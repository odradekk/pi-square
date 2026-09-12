import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, lstatSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import jiti from "jiti";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { SEED_EXCHANGE, SEED_MEMORY, workloadPrompt } from "./scenarios.mjs";

const load = jiti(import.meta.url, { moduleCache: false });
const { deriveCurrentMemory, isEligibleSourceEntry } = await load("../../../src/context-memory/derive.ts");
const { MEMORY_STATE_CUSTOM_TYPE, MEMORY_STATE_FORMAT_TAG, MEMORY_SUMMARY_WRAPPER, MEMORY_BLOCK_SEPARATOR } = await load("../../../src/context-memory/format.ts");
export const CONTINUITY_SESSION_CONFIG = Object.freeze({
  contextWindow: 100_000,
  maxTokens: 4096,
  compressionThresholdTokens: 24_000,
  memoryBudgetPercent: 2,
  keepRecentTokens: 200,
  maxCheckpoints: 12,
  maxRequests: 80,
  promptTimeoutMs: 180_000,
  requiredAppends: 1,
  requiredRebuilds: 2,
});
const EVIDENCE_MAX_BYTES = 2 * 1024 * 1024;
const FILE_MAX_BYTES = 64 * 1024;

function workspacePath(cwd, path) {
  const target = resolve(cwd, path);
  const rel = relative(cwd, target);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || resolve(path) === path) throw new Error("invalid scenario workspace path");
  return target;
}

/** input + cacheRead + cacheWrite, Pi-normalized; output tokens stay out. */
function promptTokensOf(row) {
  if (!row || [row.input, row.cacheRead, row.cacheWrite].some((count) => count === null)) return null;
  return row.input + row.cacheRead + row.cacheWrite;
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

/** The identity of the carrying Memory: the recorded state entry (#319). */
function memoryIdOf(memory) {
  if (memory.kind !== "valid") return undefined;
  return memory.carrier === "state" ? memory.stateEntryId : memory.compactionId;
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
  const carrierObservations = [];
  const refusals = new Map();
  const recordedRequestIndexes = [];
  const phaseLatency = [];
  const seedEntryIds = new Set();
  let phase = "intro";
  let finalContextSeen = false;
  let finalContext = null;
  let rawSourceAbsent = false;
  let requestStarts = 0;
  let lastRecordedShape = [];
  let finalCarrierCount = null;
  let finalRequests = 0;
  let finalFullCarrierSeen = false;
  const sessionManager = SessionManager.inMemory(environment.cwd);
  const recordedMemoryIds = new Set();
  const pendingSourceReads = new Map();
  try {
    const observer = (pi) => {
      pi.on("context", (event) => {
        // Every provider-bound request is observed, not only the final one:
        // the Memory carrier's block parts are hashed per request so the
        // report can show acceptance→application gaps, byte-stable unselected
        // prefixes, and the one-carrier invariant without retaining bodies.
        const carriers = event.messages.filter((message) => message.customType === "pi-square.context-memory/blocks");
        const parts = carriers.length > 0
          ? carriers[0].content.filter((part) => part?.type === "text").map((part) => createHash("sha256").update(part.text ?? "").digest("hex"))
          : [];
        if (carriers.length > 0 && carrierObservations.length < CONTINUITY_SESSION_CONFIG.maxRequests) {
          carrierObservations.push({ request: requests.length + 1, phase, carriers: carriers.length, parts });
        }
        if (phase !== "final") return;
        finalRequests += 1;
        // A rebuild-serving final request deliberately carries the suffix's
        // originals raw (#321), so it is not the recall probe. The final
        // prompt asks the model to complete the invited maintenance first;
        // the probe is the first final request whose carrier carries the
        // complete current Memory with the covered originals evicted.
        const memory = deriveCurrentMemory(sessionManager);
        const fullCarrier = memory.kind === "valid" && carriers.length === 1 && parts.length === memory.blocks.length + 1;
        if (fullCarrier) finalFullCarrierSeen = true;
        if (fullCarrier && !finalContextSeen) {
          finalContextSeen = true;
          finalCarrierCount = carriers.length;
          finalContext = structuredClone(event.messages.map(withoutThinking));
          // Runs after pi-square's transform; the projection's carrier and
          // maintenance source reinsertion are visible here too. Only the
          // actual Memory carrier may contain facts.
          const raw = event.messages.filter((message) => message.customType !== "pi-square.context-memory/blocks" && message.role !== "compactionSummary");
          rawSourceAbsent = !containsEvidence(JSON.stringify(raw), script)
            && !sourceEntryIds.some((id) => {
              const entry = sessionManager.getEntry(id);
              return raw.some((message) => JSON.stringify(message.content) === JSON.stringify(entry?.message?.content));
            });
        }
      });
      pi.on("tool_execution_start", (event) => {
        if (event.toolName !== "read_memory_source" || phase !== "final") return;
        const memory = deriveCurrentMemory(sessionManager);
        const block = memory.kind === "valid" ? memory.blocks[event.args.block - 1] : undefined;
        pendingSourceReads.set(event.toolCallId, {
          memoryId: memoryIdOf(memory) ?? null,
          block: event.args.block, page: event.args.page,
          coversSource: block?.sourceEntries.some((entry) => sourceEntryIds.includes(entry.id)) === true,
        });
      });
      pi.on("tool_execution_end", (event) => {
        const read = pendingSourceReads.get(event.toolCallId);
        if (read) {
          pendingSourceReads.delete(event.toolCallId);
          const details = event.result?.details;
          sourceReads.push({ ...read, ok: !event.isError && details?.page === read.page && details?.block === read.block,
            totalPages: details?.totalPages ?? null, hasMore: details?.hasMore ?? null });
          return;
        }
        // Successful recordings append their state entry synchronously inside
        // the tool call, so the in-flight request index at this event is the
        // recording request; refusals stay visible as bounded counts of the
        // stable short codes, never as free text (#320's bounded feedback).
        if (event.toolName === "compact_to_memory_block") {
          if (event.result?.details?.recorded === true) {
            recordedRequestIndexes.push(requests.length);
          } else if (event.isError || event.result?.isError) {
            const text = String(event.result?.content?.[0]?.text ?? event.result?.error ?? "");
            const code = (text.match(/\b[A-Z][A-Z0-9_]{3,}\b/) ?? ["UNCODED"])[0];
            refusals.set(code, (refusals.get(code) ?? 0) + 1);
          }
        }
      });
    };
    const settingsManager = SettingsManager.create(environment.cwd, environment.agentDir);
    const resourceLoader = new DefaultResourceLoader({ cwd: environment.cwd, agentDir: environment.agentDir, settingsManager, noSkills: true,
      extensionFactories: [{ name: "continuity-observer", factory: observer }] });
    await resourceLoader.reload();

    /** The carrier part hashes a state entry's blocks render to (#297 shape). */
    function carrierHashesOf(markdowns) {
      return [MEMORY_SUMMARY_WRAPPER, ...markdowns.map((markdown) => MEMORY_BLOCK_SEPARATOR + markdown)]
        .map((text) => createHash("sha256").update(text).digest("hex"));
    }

    // Seed the branch with fixture-authored Memory rendering at exactly half
    // the budget (#325, after #261's precedent on the retired protocol): two
    // fixture exchanges and one v2 state entry, appended through the public
    // SessionManager seams BEFORE the session is created — createAgentSession
    // initializes the agent's request context from the session manager, so the
    // seed exchanges are native request content and the recorded Memory
    // projects from the first request on. The first due maintenance appends
    // onto the seed and every later one rebuilds the newest suffix, whatever
    // block size the model writes. The seed summarizes only fixture text and
    // carries no fact any oracle scores; it is not a target compression
    // result, and the model still authors every later block.
    function seedBranchMemory() {
      const ends = [];
      let timestamp = 1;
      for (const exchange of SEED_EXCHANGE) {
        sessionManager.appendMessage({ role: "user", content: exchange.user, timestamp: timestamp++ });
        const userEnd = sessionManager.getLeafId();
        seedEntryIds.add(userEnd);
        sessionManager.appendMessage({ role: "assistant", content: [{ type: "text", text: exchange.assistant }], stopReason: "stop", timestamp: timestamp++ });
        const assistantEnd = sessionManager.getLeafId();
        seedEntryIds.add(assistantEnd);
        ends.push({ userEnd, assistantEnd });
      }
      const blocks = SEED_MEMORY.blocks.map((markdown, index) => ({
        endEntryId: ends[index].assistantEnd, markdown, retainedEntryIds: [ends[index].userEnd],
      }));
      const seedEntryId = sessionManager.appendCustomEntry(MEMORY_STATE_CUSTOM_TYPE, { format: MEMORY_STATE_FORMAT_TAG, blocks });
      const seedShape = blocks.map((block) => ({ endEntryId: block.endEntryId, markdown: block.markdown }));
      const seedMemory = deriveCurrentMemory(sessionManager);
      if (seedMemory.kind !== "valid" || seedMemory.blocks.length !== SEED_MEMORY.blockCount) {
        failures.add("seed-memory-invalid");
        return;
      }
      // The seed is a baseline, not a compression event: it never counts into
      // the schedule and its shape is the prefix every later recording extends.
      recordedMemoryIds.add(seedEntryId);
      lastRecordedShape = seedShape;
    }
    seedBranchMemory();

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
      // Native compaction is disabled in this harness and the feature never
      // takes it over (#319): any compaction entry is an integrity failure.
      if (event.type === "compaction_start" || event.type === "compaction_end") failures.add("native-compaction-occurred");
    });

    // Accepted Memory is recorded synchronously during the compact tool call.
    // Each recorded state entry is one compression observation, classified
    // against the state entry it extends, so two recordings inside one prompt
    // are both observed — no settle wait anywhere.

    function collectMemoryState() {
      const memory = deriveCurrentMemory(sessionManager);
      if (memory.kind === "opaque") failures.add("opaque-memory");
      if (memory.kind === "valid" && memory.carrier === "state") {
        const entry = sessionManager.getEntry(memory.stateEntryId);
        if (entry?.type !== "custom" || entry.customType !== MEMORY_STATE_CUSTOM_TYPE || entry.data?.format !== MEMORY_STATE_FORMAT_TAG) {
          failures.add("memory-state-entry-missing");
        }
      }
      const branch = sessionManager.getBranch();
      const positions = new Map(branch.map((entry, index) => [entry.id, index]));
      const stateEntries = branch.filter((entry) => entry.type === "custom" && entry.customType === MEMORY_STATE_CUSTOM_TYPE);
      let previousShape = lastRecordedShape;
      for (const stateEntry of stateEntries) {
        if (recordedMemoryIds.has(stateEntry.id)) continue;
        recordedMemoryIds.add(stateEntry.id);
        const blocks = Array.isArray(stateEntry.data?.blocks) ? stateEntry.data.blocks : [];
        const shape = blocks.map((block) => ({ endEntryId: block.endEntryId, markdown: block.markdown }));
        const sourceEntryIdsOfEntry = [];
        let previousEnd = -1;
        for (const block of blocks) {
          const end = positions.get(block.endEntryId) ?? -1;
          if (end > previousEnd) {
            for (let index = previousEnd + 1; index <= end; index += 1) {
              const source = branch[index];
              if (source && isEligibleSourceEntry(source)) sourceEntryIdsOfEntry.push(source.id);
            }
            previousEnd = end;
          }
        }
        if (process.env.CM_DEBUG) {
          const ids = blocks.map((b) => `${positions.get(b.endEntryId)}:ret${b.retainedEntryIds.length}`);
          console.error(`[rec] state=${stateEntry.id.slice(0, 8)} ends=[${ids.join(", ")}] shape=${shape.length} prevShape=${previousShape.length} branchLen=${branch.length}`);
        }
        compressions.push({ id: stateEntry.id, phase, request: recordedRequestIndexes.shift() ?? requests.length, operation: appendOperation(previousShape, shape) ? "append" : "rebuild",
          blocks: shape.length, sourceEntryIds: sourceEntryIdsOfEntry,
          carrierHashes: carrierHashesOf(shape.map((block) => block.markdown)) });
        previousShape = shape;
        lastRecordedShape = shape;
      }
    }

    async function prompt(text, nextPhase) {
      if (failures.size > 0) return;
      phase = nextPhase;
      const firstRequest = requests.length;
      const beforeIds = new Set(sessionManager.getEntries().map((entry) => entry.id));
      const startedAt = Date.now();
      const timer = setTimeout(() => { failures.add("prompt-timeout"); void session.abort(); }, CONTINUITY_SESSION_CONFIG.promptTimeoutMs);
      try {
        await session.prompt(text, { source: "interactive", expandPromptTemplates: false });
      } finally { clearTimeout(timer); }
      phaseLatency.push({ phase: nextPhase, ms: Date.now() - startedAt });
      if (requests.length === firstRequest) failures.add("missing-assistant-response");
      if (requests.slice(firstRequest).some((row) => !["stop", "toolUse"].includes(row.stopReason))) failures.add("unfinished-response");
      if (nextPhase === "intro" || nextPhase === "revision") {
        const user = sessionManager.getBranch().find((entry) => !beforeIds.has(entry.id) && entry.type === "message" && entry.message.role === "user");
        if (user) sourceEntryIds.push(user.id);
        else failures.add("source-entry-missing");
      }
      collectMemoryState();
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
      // The branch operation is native; state entries on the abandoned
      // sibling simply never appear on the retained branch again.
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
    // The fixed qualification schedule (#227 amendment, #325): the seeded
    // half-budget Memory makes append-versus-rebuild fixture-owned, so the
    // loop continues until one append and two suffix rebuilds are recorded
    // with the scenario sources covered — or the checkpoint bound is hit and
    // the run is honestly incomplete.
    function scheduleComplete(events) {
      return events.filter((entry) => entry.operation === "append").length >= CONTINUITY_SESSION_CONFIG.requiredAppends
        && events.filter((entry) => entry.operation === "rebuild").length >= CONTINUITY_SESSION_CONFIG.requiredRebuilds
        && events.some((entry) => entry.blocks >= 2) && sourceCovered();
    }
    for (let checkpoint = 1; checkpoint <= CONTINUITY_SESSION_CONFIG.maxCheckpoints && failures.size === 0; checkpoint += 1) {
      const before = retainedCompressions().length;
      await prompt(workloadPrompt(checkpoint), "work");
      const events = retainedCompressions();
      if (events.length > before && scheduleComplete(events)) break;
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
      const pages = sourceReads.filter((other) => other.memoryId === read.memoryId && other.block === read.block && other.ok && other.totalPages === read.totalPages);
      const seen = new Set(pages.map((page) => page.page));
      read.complete = read.ok && Number.isSafeInteger(read.totalPages) && read.totalPages > 0 && read.totalPages <= 100
        && Array.from({ length: read.totalPages }, (_, index) => index + 1).every((page) => seen.has(page))
        && pages.some((page) => page.page === read.totalPages && page.hasMore === false);
    }
    if (!preFinalSourceCovered) coverageFailures.add("source-not-covered-by-final-memory");
    if (!finalContextSeen || !rawSourceAbsent) coverageFailures.add("final-context-has-raw-answer-or-was-not-observed");
    if (finalRequests > 0 && !finalFullCarrierSeen) coverageFailures.add("final-phase-never-left-rebuild-serving");
    if (finalCarrierCount !== 1) coverageFailures.add("final-context-carrier-not-unique");
    if (!coverageEvents.some((entry) => entry.operation === "append")) coverageFailures.add("append-not-observed");
    if (coverageEvents.filter((entry) => entry.operation === "rebuild").length < CONTINUITY_SESSION_CONFIG.requiredRebuilds) coverageFailures.add("rebuilds-not-observed");
    if (!coverageEvents.some((entry) => entry.blocks >= 2)) coverageFailures.add("multi-block-memory-not-observed");
    if (script.oracle.requireSourceRead && !sourceReads.some((read) => read.complete && read.coversSource)) coverageFailures.add("original-source-not-read-completely");
    if (requests.some((row) => [row.input, row.output, row.cacheRead, row.cacheWrite].some((count) => count === null))) failures.add("missing-native-usage");

    // Bounded acceptance→application and prefix-stability measurements over
    // the observed requests and carriers — counts, indexes, and hashes only.
    const measurements = { acceptanceToApplication: [], prefixStable: true, refusals: Object.fromEntries([...refusals.entries()].sort()), peakPromptTokens: null, netInputChange: null };
    {
      let previousParts = null;
      for (const observation of carrierObservations) {
        if (previousParts !== null) {
          const m = previousParts.length;
          const n = observation.parts.length;
          let common = 0;
          while (common < Math.min(m, n) && previousParts[common] === observation.parts[common]) common += 1;
          // An append grows the part list by one with the old parts intact;
          // a rebuild keeps every part but the replaced suffix (one new block).
          const appendShaped = n === m + 1 && common === m;
          const rebuildShaped = n <= m && common >= n - 1;
          if (!appendShaped && !rebuildShaped) measurements.prefixStable = false;
        }
        previousParts = observation.parts;
      }
      for (const compression of compressions) {
        const appliedAt = carrierObservations.find((observation) =>
          observation.parts.length === compression.carrierHashes.length
          && observation.parts.every((part, index) => part === compression.carrierHashes[index]));
        measurements.acceptanceToApplication.push({
          id: compression.id, operation: compression.operation, phase: compression.phase,
          recordedAtRequest: compression.request, appliedAtRequest: appliedAt?.request ?? null,
          requestGap: appliedAt ? appliedAt.request - compression.request : null,
        });
        if (compression.phase === "work" && appliedAt && appliedAt.request >= 2) {
          const before = promptTokensOf(requests[appliedAt.request - 2]);
          const after = promptTokensOf(requests[appliedAt.request - 1]);
          if (before !== null && after !== null) {
            const change = after - before;
            measurements.netInputChange = measurements.netInputChange === null ? change : measurements.netInputChange + change;
          }
        }
      }
      const peaks = requests.map((row) => promptTokensOf(row)).filter((tokens) => tokens !== null);
      measurements.peakPromptTokens = peaks.length > 0 ? Math.max(...peaks) : null;
    }
    if (!measurements.prefixStable) failures.add("memory-prefix-unstable");
    {
      const retainedIds = new Set(retainedCompressions().map((entry) => entry.id));
      const retainedRows = measurements.acceptanceToApplication.filter((row) => retainedIds.has(row.id));
      if (retainedRows.length > 0 && retainedRows.some((row) => row.requestGap === null)) failures.add("recorded-memory-never-applied");
    }
    const entries = sessionManager.getEntries().map((entry) => entry.type === "message"
      ? { ...entry, message: withoutThinking(entry.message) } : entry);
    if (entries.filter((entry) => entry.type === "message" && entry.message.role === "assistant" && !seedEntryIds.has(entry.id)).length !== requests.length) failures.add("assistant-observation-mismatch");
    let evidence = { entries, finalContext, artifactText, sourceEntryIds, abandonedEntryIds, compressions };
    if (Buffer.byteLength(JSON.stringify(evidence)) > EVIDENCE_MAX_BYTES) { failures.add("evidence-bound-exceeded"); evidence = null; }
    return {
      run, model: { provider: model.provider, id: model.id, api: model.api }, artifactText, requests, sourceReads, measurements, phaseLatency, evidence,
      integrity: { ok: failures.size === 0, failures: [...failures] },
      coverage: { ok: coverageFailures.size === 0, failures: [...coverageFailures], memoryStates: coverageEvents.length,
        appends: coverageEvents.filter((entry) => entry.operation === "append").length,
        rebuilds: coverageEvents.filter((entry) => entry.operation === "rebuild").length,
        multiBlockMemory: coverageEvents.some((entry) => entry.blocks >= 2),
        sourceCovered: preFinalSourceCovered, rawSourceAbsent, prefixStable: measurements.prefixStable },
    };
  } finally {
    unsubscribe?.();
    session?.dispose();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(environment.root, { recursive: true, force: true });
  }
}
