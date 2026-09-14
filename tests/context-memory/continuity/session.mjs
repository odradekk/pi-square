import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, lstatSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import jiti from "jiti";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { SEED_EXCHANGE, SEED_MEMORY, workloadPrompt } from "./scenarios.mjs";

const load = jiti(import.meta.url, { moduleCache: false });
const { deriveCurrentMemory, isEligibleSourceEntry, sourceViewIdentity } = await load("../../../src/context-memory/derive.ts");
const { toCwd } = await load("../../../src/anchored-edit/paths.ts");
const registerContextMemory = (await load("../../../src/context-memory/index.ts")).default;
const { MEMORY_STATE_CUSTOM_TYPE, MEMORY_STATE_FORMAT_TAG, MEMORY_SUMMARY_WRAPPER, MEMORY_BLOCK_SEPARATOR } = await load("../../../src/context-memory/format.ts");
const { paginateTranscript, renderSourceTranscript, renderSourceTranscriptWithBoundaries } = await load("../../../src/context-memory/transcript.ts");
const { createRetrievalEvidenceCollector } = await import("./retrieval-evidence.mjs");
const { MAX_NATIVE_SESSION_BYTES, measureNativeSessionReplay } = await import("./native-replay.mjs");
const { inspectRawSource } = await import("./raw-source-diagnostic.mjs");
const { REQUESTED_THINKING_LEVEL, requireThinkingConfiguration, requireSessionThinking } = await import("../thinking.mjs");
const { safeResponseDiagnostic } = await import("../qualification/diagnostics.mjs");
export const CONTINUITY_SESSION_CONFIG = Object.freeze({
  contextWindow: 100_000,
  maxTokens: 4096,
  compressionThresholdTokens: 21_000,
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

export function matchesArtifactPath(candidate, cwd, artifactPath) {
  return typeof candidate === "string" && toCwd(candidate, cwd) === toCwd(artifactPath, cwd);
}

/** Provider-reported input stays separate from provider-specific cache fields. */
function reportedInputOf(row) {
  return Number.isSafeInteger(row?.input) ? row.input : null;
}

export function originalEvidenceLocations(memory, sourceEntryIds, requirements) {
  if (memory?.kind !== "valid") return [];
  const targetIds = new Set(sourceEntryIds);
  return memory.blocks.flatMap((block, blockIndex) => {
    const entries = block.sourceEntries;
    if (!entries.some((entry) => targetIds.has(entry.id))) return [];
    // The fallback keeps this bounded provenance seam independently probeable;
    // production and repository tests always use the boundary-aware renderer.
    const rendered = typeof renderSourceTranscriptWithBoundaries === "function"
      ? renderSourceTranscriptWithBoundaries(entries)
      : { text: renderSourceTranscript(entries), boundaries: [] };
    const transcript = rendered.text;
    const pages = paginateTranscript(transcript);
    const pageEnds = [];
    let pageEnd = 0;
    for (const page of pages) { pageEnd += page.length; pageEnds.push(pageEnd); }
    const targetRanges = entries.flatMap((entry, entryIndex) => targetIds.has(entry.id) ? [{
      start: renderSourceTranscript(entries.slice(0, entryIndex)).length,
      end: renderSourceTranscript(entries.slice(0, entryIndex + 1)).length,
    }] : []);
    const targetTexts = entries.filter((entry) => targetIds.has(entry.id)).map((entry) => renderSourceTranscript([entry]));
    const otherTexts = entries.filter((entry) => !targetIds.has(entry.id)).map((entry) => renderSourceTranscript([entry]));
    const pagesFor = (start, end) => {
      const result = [];
      let cursor = start;
      while (cursor < end) {
        const page = pageEnds.findIndex((pageEnd) => cursor < pageEnd);
        if (page < 0) break;
        result.push(page + 1);
        cursor = pageEnds[page];
      }
      return result;
    };
    const folded = transcript.toLocaleLowerCase();
    const pageStarts = pageEnds.map((end, index) => index === 0 ? 0 : pageEnds[index - 1]);
    const witnesses = Object.fromEntries(requirements.map((requirement) => {
      const targetPages = new Set();
      const completeTargetPages = new Set();
      const otherPages = new Set();
      const needle = requirement.exact.toLocaleLowerCase();
      for (let at = folded.indexOf(needle); at >= 0; at = folded.indexOf(needle, at + 1)) {
        if (rendered.boundaries.some((boundary) => boundary >= at && boundary < at + needle.length)) continue;
        const target = targetRanges.some((range) => at >= range.start && at + needle.length <= range.end);
        const occurrencePages = pagesFor(at, at + needle.length);
        for (const page of occurrencePages) (target ? targetPages : otherPages).add(page);
        if (target && occurrencePages.length === 1) {
          const page = occurrencePages[0];
          if (at >= pageStarts[page - 1] && at + needle.length <= pageEnds[page - 1]) completeTargetPages.add(page);
        }
      }
      return [requirement.id, { targetPages: [...targetPages], completeTargetPages: [...completeTargetPages], otherPages: [...otherPages] }];
    }));
    return [{ block: blockIndex + 1, witnesses, targetTexts, otherTexts }];
  });
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
      packages: [], quietStartup: true,
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

export function responseUsage(message, phase, request, activeTools) {
  const usage = message.usage ?? {};
  const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
  // Pi 0.84.2 normalizes absent raw provider cache fields to zero. A positive
  // value proves reporting; a normalized zero alone cannot distinguish an
  // explicit provider zero from absence, so preserve that uncertainty.
  const reportedCache = (value) => Number.isSafeInteger(value) && value > 0 ? value : null;
  const diagnostic = safeResponseDiagnostic(message);
  return {
    phase, request, stopReason: message.stopReason,
    input: count(usage.input), output: count(usage.output), cacheRead: reportedCache(usage.cacheRead), cacheWrite: reportedCache(usage.cacheWrite),
    tools: (message.content ?? []).filter((part) => part.type === "toolCall").map((part) => part.name),
    activeTools: Array.isArray(activeTools) ? [...activeTools] : [],
    errorPresent: message.stopReason === "error" || typeof message.errorMessage === "string",
    ...(diagnostic ? { diagnostic } : {}),
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

export function netInputChangeOf(compressions, carrierObservations, requests) {
  let total = null;
  for (const compression of compressions) {
    if (compression.phase !== "work") continue;
    const appliedAt = carrierObservations.find((observation) => observation.memoryId === compression.id
      && observation.request > compression.request && observation.carriers === 1
      && observation.parts.length === compression.carrierHashes.length
      && observation.parts.every((part, index) => part === compression.carrierHashes[index]));
    if (!appliedAt || appliedAt.request < 2) continue;
    const before = reportedInputOf(requests[appliedAt.request - 2]);
    const after = reportedInputOf(requests[appliedAt.request - 1]);
    if (before !== null && after !== null) total = (total ?? 0) + after - before;
  }
  return total;
}

export async function runContinuitySession({ packageRoot, modelRuntime, model, script, run, signal, contextModifierFactory }) {
  const thinking = requireThinkingConfiguration(model);
  const environment = createEnvironment(packageRoot, script);
  let session;
  let unsubscribe;
  let abortListener;
  let cancelled = signal?.aborted === true;
  const failures = new Set();
  const coverageFailures = new Set();
  const requests = [];
  const sourceReads = [];
  const sourceEntryIds = [];
  const abandonedEntryIds = [];
  const compressions = [];
  const carrierObservations = [];
  const contextToolSets = [];
  const refusals = new Map();
  const recordedRequestIndexes = [];
  const phaseLatency = [];
  const seedEntryIds = new Set();
  let phase = "intro";
  let finalContextSeen = false;
  let finalContext = null;
  let rawSourceAbsent = false;
  let rawSourceDiagnostic = null;
  let requestStarts = 0;
  let finalCarrierCount = null;
  let finalRequests = 0;
  let finalFullCarrierSeen = false;
  const sessionManager = SessionManager.create(environment.cwd, join(environment.root, "sessions"));
  const persistence = { seedBytes: 0, finalBytes: 0, peakBytes: 0, appendedBytes: 0 };
  const recordedMemoryIds = new Set();
  const pendingSourceReads = new Map();
  const retrieval = createRetrievalEvidenceCollector({
    script,
    sourceEntryIds,
    deriveMemory: deriveCurrentMemory,
    sourceViewOf: sourceViewIdentity,
    originalLocationsOf: originalEvidenceLocations,
    artifactPathMatches: (candidate) => matchesArtifactPath(candidate, environment.cwd, script.artifactPath),
  });
  try {
    const observer = (pi) => {
      pi.on("context", (event) => {
        contextToolSets.push(pi.getActiveTools());
        retrieval.context(event.messages, sessionManager);
        // Every provider-bound request is observed, not only the final one:
        // the Memory carrier's block parts are hashed per request so the
        // report can show acceptance→application gaps, byte-stable unselected
        // prefixes, and the one-carrier invariant without retaining bodies.
        const carriers = event.messages.filter((message) => message.customType === "pi-square.context-memory/blocks");
        const parts = carriers.length > 0
          ? carriers[0].content.filter((part) => part?.type === "text").map((part) => createHash("sha256").update(part.text ?? "").digest("hex"))
          : [];
        if (carriers.length > 0 && carrierObservations.length < CONTINUITY_SESSION_CONFIG.maxRequests) {
          carrierObservations.push({ request: requests.length + 1, memoryId: memoryIdOf(deriveCurrentMemory(sessionManager)), phase, carriers: carriers.length, parts });
        }
        if (phase !== "final") return;
        finalRequests += 1;
        // A rebuild-serving final request deliberately carries the suffix's
        // originals raw (#321), so it is not the recall probe. The final
        // prompt asks the model to complete the invited maintenance first;
        // the probe is the first final request whose carrier carries the
        // complete current Memory with the covered originals evicted.
        const memory = deriveCurrentMemory(sessionManager);
        const expectedParts = memory.kind === "valid" ? carrierHashesOf(memory.blocks.map((block) => block.markdown)) : [];
        const fullCarrier = memory.kind === "valid" && carriers.length === 1 && parts.length === expectedParts.length
          && parts.every((part, index) => part === expectedParts[index]);
        if (fullCarrier) finalFullCarrierSeen = true;
        if (fullCarrier && !finalContextSeen) {
          finalContextSeen = true;
          finalCarrierCount = carriers.length;
          finalContext = structuredClone(event.messages.map(withoutThinking));
          // Runs after pi-square's transform; the projection's carrier and
          // maintenance source reinsertion are visible here too. Only the
          // actual Memory carrier may contain facts.
          const rawSource = inspectRawSource(event.messages, script, sourceEntryIds.map((id) => sessionManager.getEntry(id)));
          rawSourceAbsent = rawSource.absent;
          rawSourceDiagnostic = rawSource.diagnostic;
        }
      });
      pi.on("tool_execution_start", (event) => {
        retrieval.toolStart(event, sessionManager);
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
        retrieval.toolEnd(event);
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
    const contextMemoryFactory = (pi) => registerContextMemory(pi, {
      configProvider: () => ({ contextMemory: {
        enabled: true,
        compressionThreshold: { tokens: CONTINUITY_SESSION_CONFIG.compressionThresholdTokens },
        memoryBudgetPercent: CONTINUITY_SESSION_CONFIG.memoryBudgetPercent,
      } }),
      displayRuntimeProvider: () => { throw new Error("display runtime is not used by continuity qualification"); },
      reserveTokens: () => settingsManager.getCompactionSettings().reserveTokens,
      searchMemorySourceEnabled: run.retrievalArm !== "read-only",
    });
    const resourceLoader = new DefaultResourceLoader({ cwd: environment.cwd, agentDir: environment.agentDir, settingsManager, noSkills: true,
      noExtensions: true,
      extensionFactories: [
        { name: "context-memory-qualification", factory: contextMemoryFactory },
        ...(typeof contextModifierFactory === "function" ? [{ name: "continuity-test-context-modifier",
          factory: (pi) => contextModifierFactory(pi, { sessionManager }) }] : []),
        { name: "continuity-observer", factory: observer },
      ] });
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
      const seedMemory = deriveCurrentMemory(sessionManager);
      if (seedMemory.kind !== "valid" || seedMemory.blocks.length !== SEED_MEMORY.blockCount) {
        failures.add("seed-memory-invalid");
        return;
      }
      // The seed is a baseline, not a compression event: it never counts into
      // the schedule; every later recording classifies against it on the branch.
      recordedMemoryIds.add(seedEntryId);
    }
    seedBranchMemory();
    function observePersistence() {
      const bytes = lstatSync(sessionManager.getSessionFile()).size;
      if (bytes < persistence.finalBytes) failures.add("native-session-shrank");
      persistence.appendedBytes += Math.max(0, bytes - persistence.finalBytes);
      persistence.finalBytes = bytes;
      persistence.peakBytes = Math.max(persistence.peakBytes, bytes);
      if (bytes > MAX_NATIVE_SESSION_BYTES) failures.add("native-session-byte-limit");
    }
    observePersistence();
    persistence.seedBytes = persistence.finalBytes;
    persistence.appendedBytes = 0;

    const measuredModel = { ...model, contextWindow: CONTINUITY_SESSION_CONFIG.contextWindow, maxTokens: Math.min(model.maxTokens ?? 4096, 4096) };
    ({ session } = await createAgentSession({ cwd: environment.cwd, agentDir: environment.agentDir, settingsManager, resourceLoader, sessionManager,
      modelRuntime, model: measuredModel, thinkingLevel: REQUESTED_THINKING_LEVEL,
      tools: ["read", "bash", "write", "compact_to_memory_block", "read_memory_source", "search_memory_source"] }));
    requireSessionThinking(session, thinking);
    await session.bindExtensions({ mode: "print", onError: () => failures.add("extension-error") });
    if (resourceLoader.getExtensions().errors.length > 0) failures.add("extension-load-error");
    if (!["compact_to_memory_block", "read_memory_source", "search_memory_source"].every((name) =>
      session.getAllTools().some((tool) => tool.name === name))) failures.add("context-memory-not-loaded");
    abortListener = () => { cancelled = true; void session.abort(); };
    signal?.addEventListener("abort", abortListener, { once: true });
    if (signal?.aborted) abortListener();
    unsubscribe = session.subscribe((event) => {
      if (event.type === "turn_start" && ++requestStarts > CONTINUITY_SESSION_CONFIG.maxRequests) {
        failures.add("request-limit");
        void session.abort();
      }
      if (event.type === "message_end" && event.message.role === "assistant") requests.push(responseUsage(event.message, phase, requests.length + 1, contextToolSets[requests.length]));
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
      const shapeOf = (entry) => (Array.isArray(entry?.data?.blocks) ? entry.data.blocks : [])
        .map((block) => ({ endEntryId: block.endEntryId, markdown: block.markdown }));
      // Each recording classifies against the state entry it extends on the
      // SAME branch: after tree navigation the retained chain restarts from
      // the seed, and recordings on an abandoned sibling never poison it.
      for (let index = 0; index < stateEntries.length; index += 1) {
        const stateEntry = stateEntries[index];
        const previousShape = index === 0 ? [] : shapeOf(stateEntries[index - 1]);
        if (recordedMemoryIds.has(stateEntry.id)) continue;
        recordedMemoryIds.add(stateEntry.id);
        const shape = shapeOf(stateEntry);
        const rawBlocks = Array.isArray(stateEntry.data?.blocks) ? stateEntry.data.blocks : [];
        const sourceEntryIdsOfEntry = [];
        let previousEnd = -1;
        for (const block of rawBlocks) {
          const end = positions.get(block.endEntryId) ?? -1;
          if (end > previousEnd) {
            for (let position = previousEnd + 1; position <= end; position += 1) {
              const source = branch[position];
              if (source && isEligibleSourceEntry(source)) sourceEntryIdsOfEntry.push(source.id);
            }
            previousEnd = end;
          }
        }
        compressions.push({ id: stateEntry.id, phase, request: recordedRequestIndexes.shift() ?? requests.length, operation: appendOperation(previousShape, shape) ? "append" : "rebuild",
          blocks: shape.length, sourceEntryIds: sourceEntryIdsOfEntry,
          carrierHashes: carrierHashesOf(shape.map((block) => block.markdown)) });
      }
    }

    async function prompt(text, nextPhase) {
      if (failures.size > 0 || cancelled) return;
      phase = nextPhase;
      retrieval.setPhase(nextPhase);
      const firstRequest = requests.length;
      const beforeIds = new Set(sessionManager.getEntries().map((entry) => entry.id));
      const startedAt = Date.now();
      const timer = setTimeout(() => { failures.add("prompt-timeout"); void session.abort(); }, CONTINUITY_SESSION_CONFIG.promptTimeoutMs);
      try {
        await session.prompt(text, { source: "interactive", expandPromptTemplates: false });
      } finally { clearTimeout(timer); }
      phaseLatency.push({ phase: nextPhase, ms: Date.now() - startedAt });
      if (requests.length === firstRequest) failures.add("missing-assistant-response");
      if (requests.slice(firstRequest).some((row) => row.errorPresent)) failures.add("provider-response-error");
      if (requests.slice(firstRequest).some((row) => !["stop", "toolUse"].includes(row.stopReason))) failures.add("unfinished-response");
      if (nextPhase === "intro" || nextPhase === "revision") {
        const user = sessionManager.getBranch().find((entry) => !beforeIds.has(entry.id) && entry.type === "message" && entry.message.role === "user");
        if (user) sourceEntryIds.push(user.id);
        else failures.add("source-entry-missing");
      }
      collectMemoryState();
      observePersistence();
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
    // Earlier work keeps the normal shell, but the final artifact has one
    // observable mutation route. Retrieval must reach a later request before
    // the native write begins, so an unobserved shell write cannot be scored.
    session.setActiveToolsByName(session.getActiveToolNames().filter((name) => name !== "bash"));
    await prompt(script.finalPrompt, "final");
    let artifactText = null;
    try {
      const path = workspacePath(environment.cwd, script.artifactPath);
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > FILE_MAX_BYTES) failures.add("artifact-not-bounded-regular-file");
      else artifactText = readFileSync(path, "utf8");
    } catch (error) { if (error.code !== "ENOENT") failures.add("artifact-read-error"); }
    const retrievalResult = retrieval.finalize(artifactText);
    if (!preFinalSourceCovered) coverageFailures.add("source-not-covered-by-final-memory");
    if (!finalContextSeen || !rawSourceAbsent) coverageFailures.add("final-context-has-raw-answer-or-was-not-observed");
    if (finalRequests > 0 && !finalFullCarrierSeen) coverageFailures.add("final-phase-never-left-rebuild-serving");
    if (finalCarrierCount !== 1) coverageFailures.add("final-context-carrier-not-unique");
    if (!coverageEvents.some((entry) => entry.operation === "append")) coverageFailures.add("append-not-observed");
    if (coverageEvents.filter((entry) => entry.operation === "rebuild").length < CONTINUITY_SESSION_CONFIG.requiredRebuilds) coverageFailures.add("rebuilds-not-observed");
    if (!coverageEvents.some((entry) => entry.blocks >= 2)) coverageFailures.add("multi-block-memory-not-observed");
    if (requests.some((row) => [row.input, row.output].some((count) => count === null))) failures.add("missing-native-usage");

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
          observation.memoryId === compression.id && observation.request > compression.request
          && observation.carriers === 1 && observation.parts.length === compression.carrierHashes.length
          && observation.parts.every((part, index) => part === compression.carrierHashes[index]));
        measurements.acceptanceToApplication.push({
          id: compression.id, operation: compression.operation, phase: compression.phase,
          recordedAtRequest: compression.request, appliedAtRequest: appliedAt?.request ?? null,
          requestGap: appliedAt ? appliedAt.request - compression.request : null,
        });
      }
      measurements.netInputChange = netInputChangeOf(compressions, carrierObservations, requests);
      const peaks = requests.map((row) => reportedInputOf(row)).filter((tokens) => tokens !== null);
      measurements.peakPromptTokens = peaks.length > 0 ? Math.max(...peaks) : null;
    }
    if (!measurements.prefixStable) failures.add("memory-prefix-unstable");
    measurements.persistence = persistence;
    try {
      measurements.nativeReplay = measureNativeSessionReplay({ sessionPath: sessionManager.getSessionFile(), currentSessionManager: sessionManager });
      if (!measurements.nativeReplay.branchEquivalent || !measurements.nativeReplay.memoryEquivalent
        || !measurements.nativeReplay.diskUnchanged || !measurements.nativeReplay.directoryEntriesUnchanged) failures.add("native-replay-mismatch");
    } catch {
      measurements.nativeReplay = null;
      failures.add("native-replay-unavailable");
    }
    // A recording whose full carrier never rode a later request is reported
    // as a measurement, not an integrity failure: a due rebuild legitimately
    // replaces the full carrier with the prefix-only serving view (#321), and
    // the next-request application contract itself is pinned by the
    // deterministic append-projection and suffix-rebuild suites.
    const entries = sessionManager.getEntries().map((entry) => entry.type === "message"
      ? { ...entry, message: withoutThinking(entry.message) } : entry);
    if (entries.filter((entry) => entry.type === "message" && entry.message.role === "assistant" && !seedEntryIds.has(entry.id)).length !== requests.length) failures.add("assistant-observation-mismatch");
    let evidence = { entries, finalContext, artifactText, sourceEntryIds, abandonedEntryIds, compressions,
      retrieval: retrievalResult.privateEvidence };
    if (Buffer.byteLength(JSON.stringify(evidence)) > EVIDENCE_MAX_BYTES) { failures.add("evidence-bound-exceeded"); evidence = null; }
    return {
      run, model: { provider: model.provider, id: model.id, api: model.api }, thinking: { ...thinking, session: session.thinkingLevel }, artifactText, requests, sourceReads,
      retrievalQualification: retrievalResult.report, measurements, phaseLatency, evidence, cancelled,
      timedOut: failures.has("prompt-timeout"),
      providerError: requests.some((request) => request.errorPresent),
      isolation: {
        root: createHash("sha256").update(`root\0${environment.root}`).digest("hex"),
        agentConfig: createHash("sha256").update(`agent-config\0${join(environment.agentDir, "config", "pi-square.json")}\0${readFileSync(join(environment.agentDir, "config", "pi-square.json"))}`).digest("hex"),
        workspace: createHash("sha256").update(`workspace\0${environment.cwd}`).digest("hex"),
        session: createHash("sha256").update(`session\0${sessionManager.getSessionId()}`).digest("hex"),
        capture: createHash("sha256").update(`capture\0${sessionManager.getSessionId()}\0${JSON.stringify({ requests, contextToolSets })}`).digest("hex"),
      },
      integrity: { ok: failures.size === 0, failures: [...failures] },
      coverage: { ok: coverageFailures.size === 0, failures: [...coverageFailures], memoryStates: coverageEvents.length,
        appends: coverageEvents.filter((entry) => entry.operation === "append").length,
        rebuilds: coverageEvents.filter((entry) => entry.operation === "rebuild").length,
        multiBlockMemory: coverageEvents.some((entry) => entry.blocks >= 2),
        sourceCovered: preFinalSourceCovered, finalContextObserved: finalContextSeen, rawSourceAbsent,
        ...(rawSourceDiagnostic ? { rawSourceDiagnostic } : {}), prefixStable: measurements.prefixStable },
    };
  } finally {
    unsubscribe?.();
    if (abortListener) signal?.removeEventListener("abort", abortListener);
    session?.dispose();
    rmSync(environment.root, { recursive: true, force: true });
  }
}
