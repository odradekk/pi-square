import { mkdirSync, mkdtempSync, lstatSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import jiti from "jiti";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { workloadPrompt } from "./scenarios.mjs";

const load = jiti(import.meta.url, { moduleCache: false });
const { deriveCurrentMemory } = await load("../../../src/context-memory/derive.ts");

export const CONTINUITY_SESSION_CONFIG = Object.freeze({
  contextWindow: 100_000,
  maxTokens: 4096,
  compressionThresholdTokens: 3500,
  memoryBudgetPercent: 1,
  keepRecentTokens: 200,
  maxCheckpoints: 12,
  maxRequests: 80,
  promptTimeoutMs: 180_000,
});
const EVIDENCE_MAX_BYTES = 2 * 1024 * 1024;
const FILE_MAX_BYTES = 64 * 1024;

function workspacePath(cwd, path) {
  const target = resolve(cwd, path);
  const rel = relative(cwd, target);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || resolve(path) === path) throw new Error("invalid scenario workspace path");
  return target;
}

function createEnvironment(packageRoot, script) {
  const root = mkdtempSync(join(tmpdir(), "pi-square-continuity-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "workspace");
  try {
    mkdirSync(join(agentDir, "config"), { recursive: true });
    mkdirSync(cwd);
    writeFileSync(join(agentDir, "auth.json"), "{}\n", { mode: 0o600 });
    writeFileSync(join(agentDir, "config", "pi-square.json"), JSON.stringify({
      version: 2,
      contextMemory: { enabled: true, compressionThreshold: { tokens: CONTINUITY_SESSION_CONFIG.compressionThresholdTokens }, memoryBudgetPercent: CONTINUITY_SESSION_CONFIG.memoryBudgetPercent },
    }));
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
      packages: [{ source: packageRoot }], quietStartup: true,
      compaction: { enabled: false, keepRecentTokens: CONTINUITY_SESSION_CONFIG.keepRecentTokens },
      retry: { enabled: false, provider: { maxRetries: 0 } },
    }));
    for (const [path, content] of Object.entries(script.setupFiles)) {
      const target = workspacePath(cwd, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
    return { root, agentDir, cwd };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function containsEvidence(text, script) {
  if (script.evidenceTokens.some((token) => text.includes(token))) return true;
  return Object.entries(script.oracle.expected ?? {}).some(([field, value]) => {
    if (typeof value !== "number" && typeof value !== "boolean") return false;
    const label = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replaceAll("_", "[\\s_-]+");
    return new RegExp(`${label}[^\\n]{0,40}\\b${value}\\b`, "i").test(text);
  });
}

function withoutThinking(message) {
  return message.role === "assistant"
    ? { ...message, content: message.content.filter((part) => part.type !== "thinking") }
    : message;
}

/** Detect alternate on-disk answers before asking the sole final probe. */
function workspaceChanged(cwd, script) {
  let count = 0;
  let bytes = 0;
  function visit(directory) {
    for (const name of readdirSync(directory)) {
      if (++count > 100) throw new Error("workspace inspection bound");
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error("workspace link");
      if (stat.isDirectory()) {
        if (visit(path)) return true;
      } else {
        if (!stat.isFile() || stat.size > FILE_MAX_BYTES || (bytes += stat.size) > 512 * 1024) throw new Error("workspace file bound");
        // Every pre-final task is read-only. Comparing the whole fixture also
        // catches notes containing only numeric or boolean answer fragments.
        if (readFileSync(path, "utf8") !== script.setupFiles[relative(cwd, path).split(sep).join("/")]) return true;
      }
    }
    return false;
  }
  return visit(cwd);
}

function responseUsage(message, phase, request) {
  const usage = message.usage ?? {};
  const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
  return {
    phase, request, stopReason: message.stopReason,
    input: count(usage.input), output: count(usage.output), cacheRead: count(usage.cacheRead), cacheWrite: count(usage.cacheWrite),
    tools: (message.content ?? []).filter((part) => part.type === "toolCall").map((part) => part.name),
  };
}

function memoryShape(memory) {
  return memory.kind === "valid" ? memory.blocks.map((block) => ({ endEntryId: block.endEntryId, markdown: block.markdown })) : [];
}

function appendOperation(previous, current) {
  return current.length === previous.length + 1 && previous.every((block, index) =>
    block.endEntryId === current[index].endEntryId && block.markdown === current[index].markdown);
}

/** Sequential caller only: Pi extensions resolve their agent configuration via a process-wide path. */
export async function runContinuitySession({ packageRoot, modelRuntime, model, script, run }) {
  const environment = createEnvironment(packageRoot, script);
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = environment.agentDir;
  let session;
  let unsubscribe;
  const failures = new Set();
  const coverageFailures = new Set();
  const requests = [];
  const sourceReads = [];
  const sourceEntryIds = [];
  const abandonedEntryIds = [];
  const compressions = [];
  let phase = "intro";
  let finalContextSeen = false;
  let finalContext = null;
  let rawSourceAbsent = false;
  let compactionEnds = 0;
  let acceptedSubmissions = 0;
  let requestStarts = 0;
  let previousMemory = [];
  let lastCompactionId;
  const sessionManager = SessionManager.inMemory(environment.cwd);
  const pendingSourceReads = new Map();
  try {
    const observer = (pi) => {
      pi.on("context", (event) => {
        if (phase !== "final" || finalContextSeen) return;
        finalContextSeen = true;
        finalContext = structuredClone(event.messages.map(withoutThinking));
        // Runs after pi-square's transform; maintenance source reinsertion is
        // visible here too. Only the actual Memory projection may contain facts.
        const raw = event.messages.filter((message) => message.customType !== "pi-square.context-memory/blocks" && message.role !== "compactionSummary");
        rawSourceAbsent = !containsEvidence(JSON.stringify(raw), script)
          && !sourceEntryIds.some((id) => {
            const entry = sessionManager.getEntry(id);
            return raw.some((message) => JSON.stringify(message.content) === JSON.stringify(entry?.message?.content));
          });
      });
      pi.on("tool_execution_start", (event) => {
        if (event.toolName !== "read_memory_source" || phase !== "final") return;
        const memory = deriveCurrentMemory(sessionManager);
        const block = memory.kind === "valid" ? memory.blocks[event.args.block - 1] : undefined;
        pendingSourceReads.set(event.toolCallId, {
          compactionId: memory.kind === "valid" ? memory.compactionId : null,
          block: event.args.block, page: event.args.page,
          coversSource: block?.sourceEntries.some((entry) => sourceEntryIds.includes(entry.id)) === true,
        });
      });
      pi.on("tool_execution_end", (event) => {
        if (event.toolName === "submit_memory" && !event.isError && event.result?.details?.accepted === true) acceptedSubmissions += 1;
        const read = pendingSourceReads.get(event.toolCallId);
        if (!read) return;
        pendingSourceReads.delete(event.toolCallId);
        const details = event.result?.details;
        sourceReads.push({ ...read, ok: !event.isError && details?.page === read.page && details?.block === read.block,
          totalPages: details?.totalPages ?? null, hasMore: details?.hasMore ?? null });
      });
    };
    const settingsManager = SettingsManager.create(environment.cwd, environment.agentDir);
    const resourceLoader = new DefaultResourceLoader({ cwd: environment.cwd, agentDir: environment.agentDir, settingsManager, noSkills: true,
      extensionFactories: [{ name: "continuity-observer", factory: observer }] });
    await resourceLoader.reload();
    const measuredModel = { ...model, contextWindow: CONTINUITY_SESSION_CONFIG.contextWindow, maxTokens: Math.min(model.maxTokens ?? 4096, 4096) };
    ({ session } = await createAgentSession({ cwd: environment.cwd, agentDir: environment.agentDir, settingsManager, resourceLoader, sessionManager,
      modelRuntime, model: measuredModel, thinkingLevel: "off" }));
    await session.bindExtensions({ mode: "print", onError: () => failures.add("extension-error") });
    if (resourceLoader.getExtensions().errors.length > 0) failures.add("extension-load-error");
    if (!session.extensionRunner.getExtensionPaths().some((path) => path === join(packageRoot, "src", "index.ts"))) failures.add("pi-square-not-loaded");
    unsubscribe = session.subscribe((event) => {
      if (event.type === "turn_start" && ++requestStarts > CONTINUITY_SESSION_CONFIG.maxRequests) {
        failures.add("request-limit");
        void session.abort();
      }
      if (event.type === "message_end" && event.message.role === "assistant") requests.push(responseUsage(event.message, phase, requests.length + 1));
      if (event.type === "compaction_end") {
        compactionEnds += 1;
        if (event.aborted || event.errorMessage) failures.add("compaction-error");
      }
    });

    function collectCompaction() {
      const memory = deriveCurrentMemory(sessionManager);
      if (memory.kind === "opaque") failures.add("opaque-memory");
      if (memory.kind !== "valid" || memory.compactionId === lastCompactionId) return;
      const shape = memoryShape(memory);
      const entry = sessionManager.getEntry(memory.compactionId);
      if (entry.fromHook !== true) failures.add("non-extension-compaction");
      compressions.push({ id: memory.compactionId, phase, operation: appendOperation(previousMemory, shape) ? "append" : "rebuild",
        blocks: shape.length, sourceEntryIds: memory.blocks.flatMap((block) => block.sourceEntries.map((source) => source.id)) });
      previousMemory = shape;
      lastCompactionId = memory.compactionId;
    }

    async function prompt(text, nextPhase) {
      if (failures.size > 0) return;
      phase = nextPhase;
      const firstRequest = requests.length;
      const previousEnds = compactionEnds;
      const previousAccepted = acceptedSubmissions;
      const beforeIds = new Set(sessionManager.getEntries().map((entry) => entry.id));
      const timer = setTimeout(() => { failures.add("prompt-timeout"); void session.abort(); }, CONTINUITY_SESSION_CONFIG.promptTimeoutMs);
      try {
        await session.prompt(text, { source: "interactive", expandPromptTemplates: false });
        const submitted = acceptedSubmissions > previousAccepted;
        const deadline = Date.now() + 10_000;
        while (session.isCompacting || (submitted && compactionEnds === previousEnds)) {
          if (Date.now() > deadline) { failures.add("compaction-did-not-settle"); break; }
          await new Promise((done) => setTimeout(done, 5));
        }
      } finally { clearTimeout(timer); }
      if (requests.length === firstRequest) failures.add("missing-assistant-response");
      if (requests.slice(firstRequest).some((row) => !["stop", "toolUse"].includes(row.stopReason))) failures.add("unfinished-response");
      if (nextPhase === "intro" || nextPhase === "revision") {
        const user = sessionManager.getBranch().find((entry) => !beforeIds.has(entry.id) && entry.type === "message" && entry.message.role === "user");
        if (user) sourceEntryIds.push(user.id);
        else failures.add("source-entry-missing");
      }
      collectCompaction();
    }

    await prompt(script.introPrompt, "intro");
    if (script.revisionPrompt) await prompt(script.revisionPrompt, "revision");
    if (script.abandonedPrompt && failures.size === 0) {
      const retained = sessionManager.getLeafId();
      const beforeIds = new Set(sessionManager.getEntries().map((entry) => entry.id));
      await prompt(script.abandonedPrompt, "abandoned");
      abandonedEntryIds.push(...sessionManager.getEntries().filter((entry) => !beforeIds.has(entry.id)).map((entry) => entry.id));
      const navigation = await session.navigateTree(retained, { summarize: false });
      if (navigation.cancelled || navigation.aborted) failures.add("branch-navigation-failed");
      // The branch operation is native; its current Memory can precede the
      // last observed compaction on the now-abandoned sibling.
      const retainedMemory = deriveCurrentMemory(sessionManager);
      previousMemory = memoryShape(retainedMemory);
      lastCompactionId = retainedMemory.kind === "valid" ? retainedMemory.compactionId : undefined;
    }

    function retainedCompressions() {
      const branch = new Set(sessionManager.getBranch().map((entry) => entry.id));
      return compressions.filter((entry) => branch.has(entry.id));
    }
    function sourceCovered() {
      const memory = deriveCurrentMemory(sessionManager);
      return sourceEntryIds.length > 0 && memory.kind === "valid"
        && sourceEntryIds.every((id) => memory.blocks.some((block) => block.sourceEntries.some((entry) => entry.id === id)));
    }
    for (let checkpoint = 1; checkpoint <= CONTINUITY_SESSION_CONFIG.maxCheckpoints && failures.size === 0; checkpoint += 1) {
      const before = retainedCompressions().length;
      await prompt(workloadPrompt(checkpoint), "work");
      const events = retainedCompressions();
      if (events.length > before && events.some((entry) => entry.operation === "append")
        && events.filter((entry) => entry.operation === "rebuild").length >= 2 && sourceCovered()) break;
    }
    const preFinalSourceCovered = sourceCovered();
    const coverageEvents = retainedCompressions();
    const preFinalBranch = sessionManager.getBranch();
    if (abandonedEntryIds.some((id) => preFinalBranch.some((entry) => entry.id === id))) failures.add("abandoned-branch-in-active-lineage");
    if (coverageEvents.some((entry) => entry.sourceEntryIds.some((id) => abandonedEntryIds.includes(id)))) failures.add("abandoned-source-in-memory");
    try {
      if (workspaceChanged(environment.cwd, script)) coverageFailures.add("workspace-changed-before-final");
      try { lstatSync(workspacePath(environment.cwd, script.artifactPath)); coverageFailures.add("artifact-created-before-final"); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    } catch { coverageFailures.add("workspace-could-not-be-inspected"); }
    await prompt(script.finalPrompt, "final");
    let artifactText = null;
    try {
      const path = workspacePath(environment.cwd, script.artifactPath);
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > FILE_MAX_BYTES) failures.add("artifact-not-bounded-regular-file");
      else artifactText = readFileSync(path, "utf8");
    } catch (error) { if (error.code !== "ENOENT") failures.add("artifact-read-error"); }
    for (const read of sourceReads) {
      const pages = sourceReads.filter((other) => other.compactionId === read.compactionId && other.block === read.block && other.ok && other.totalPages === read.totalPages);
      const seen = new Set(pages.map((page) => page.page));
      read.complete = read.ok && Number.isSafeInteger(read.totalPages) && read.totalPages > 0 && read.totalPages <= 100
        && Array.from({ length: read.totalPages }, (_, index) => index + 1).every((page) => seen.has(page))
        && pages.some((page) => page.page === read.totalPages && page.hasMore === false);
    }
    if (!preFinalSourceCovered) coverageFailures.add("source-not-covered-by-final-memory");
    if (!finalContextSeen || !rawSourceAbsent) coverageFailures.add("final-context-has-raw-answer-or-was-not-observed");
    if (!coverageEvents.some((entry) => entry.operation === "append")) coverageFailures.add("append-not-observed");
    if (coverageEvents.filter((entry) => entry.operation === "rebuild").length < 2) coverageFailures.add("two-rebuilds-not-observed");
    if (script.oracle.requireSourceRead && !sourceReads.some((read) => read.complete && read.coversSource)) coverageFailures.add("original-source-not-read-completely");
    if (requests.some((row) => [row.input, row.output, row.cacheRead, row.cacheWrite].some((count) => count === null))) failures.add("missing-native-usage");
    const entries = sessionManager.getEntries().map((entry) => entry.type === "message"
      ? { ...entry, message: withoutThinking(entry.message) } : entry);
    if (entries.filter((entry) => entry.type === "message" && entry.message.role === "assistant").length !== requests.length) failures.add("assistant-observation-mismatch");
    let evidence = { entries, finalContext, artifactText, sourceEntryIds, abandonedEntryIds, compressions };
    if (Buffer.byteLength(JSON.stringify(evidence)) > EVIDENCE_MAX_BYTES) { failures.add("evidence-bound-exceeded"); evidence = null; }
    return {
      run, model: { provider: model.provider, id: model.id, api: model.api }, artifactText, requests, sourceReads, evidence,
      integrity: { ok: failures.size === 0, failures: [...failures] },
      coverage: { ok: coverageFailures.size === 0, failures: [...coverageFailures], compactions: coverageEvents.length,
        appends: coverageEvents.filter((entry) => entry.operation === "append").length,
        rebuilds: coverageEvents.filter((entry) => entry.operation === "rebuild").length,
        sourceCovered: preFinalSourceCovered, rawSourceAbsent },
    };
  } finally {
    unsubscribe?.();
    session?.dispose();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(environment.root, { recursive: true, force: true });
  }
}
