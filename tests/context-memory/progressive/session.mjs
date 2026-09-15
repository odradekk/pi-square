import { mkdirSync, writeFileSync, chmodSync, existsSync, createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import jiti from "jiti";
import { Type } from "typebox";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { isContextOverflow, isRetryableAssistantError } from "@earendil-works/pi-ai";
import { requireThinkingConfiguration, requireSessionThinking } from "../thinking.mjs";
import { safeErrorDiagnostic, safeResponseDiagnostic } from "../qualification/diagnostics.mjs";
import { createSandbox } from "./sandbox.mjs";
import { createEvidence, digest } from "./evidence.mjs";

const load = jiti(import.meta.url, { moduleCache: false });
const registerMemory = (await load("../../../src/context-memory/index.ts")).default;
const { deriveCurrentMemory } = await load("../../../src/context-memory/derive.ts");
const { MEMORY_SUMMARY_WRAPPER, MEMORY_BLOCK_SEPARATOR } = await load("../../../src/context-memory/format.ts");
const MEMORY_TOOLS = ["compact_to_memory_block", "read_memory_source", "search_memory_source"];

export const CONFIG = Object.freeze({ contextWindow: 256_000, thinkingLevel: "max", memoryBudgetPercent: 2, memoryCompressionThreshold: Object.freeze({ tokens: 5_121 }), timeoutMs: 3_600_000,
  emergencyCompaction: Object.freeze({ safetyBudgetRatio: 0.7 }),
  recovery: Object.freeze({ initialDelayMs: 1_000, maxDelayMs: 30_000 }) });
const textOf = message => typeof message?.content === "string" ? message.content : (message?.content ?? []).filter(p => p.type === "text").map(p => p.text).join("\n");
const resultOf = (data, isError = false) => ({ content: [{ type: "text", text: JSON.stringify(data) }], details: data, ...(isError ? { isError } : {}) });
const WORK_CONTINUATION = "Continue implementing the current stage and call verify_stage. The next stage remains unavailable until verification passes.";
const FINAL_RECALL = 'FINAL RECALL: Return only a JSON object mapping the stage numbers "1" through "8" to their exact released project identifiers. Include every stage. Do not explain. The workspace and verifier are now unavailable.';

// Pi 0.84.2 misses raw socket-reset/pipe errors emitted by some gateways.
// Normalize only for classification; retain the original response in evidence
// and let Pi's quota/billing exclusions inspect the rest of the error text.
function isRetryableProviderError(message) {
  const errorMessage = message.errorMessage ?? "";
  if (/^\s*(?:401|403)\b|\b(?:unauthorized|forbidden|invalid[_ -]api[_ -]key|authentication[_ -](?:failed|failure|error)|invalid[_ -](?:authentication[_ -])?credentials)\b/i.test(errorMessage)) return false;
  return isRetryableAssistantError({ ...message, errorMessage: errorMessage.replace(
    /\b(?:ECONNRESET|ECONNABORTED|EPIPE|ETIMEDOUT|UND_ERR_SOCKET)\b|connection reset by peer|broken pipe/gi, "Connection error.") });
}

/** One clock owns all task, verifier, maintenance, and final-recall work. */
export function armDeadline(clock = globalThis) {
  const controller = new AbortController();
  const timer = clock.setTimeout(() => controller.abort(new Error("arm-timeout")), CONFIG.timeoutMs);
  return { signal: controller.signal, close: () => clock.clearTimeout(timer) };
}

export function gradeRecall(text, flags) {
  let answer;
  try { answer = JSON.parse(text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, "$1")); } catch { return { correct: 0, complete: false, matches: flags.map(() => false) }; }
  const matches = flags.map((flag, index) => answer?.[String(index + 1)] === flag);
  return { correct: matches.filter(Boolean).length, complete: answer !== null && typeof answer === "object" && !Array.isArray(answer)
    && Object.keys(answer).length === 8 && matches.every(Boolean), matches };
}

/** Pi normalizes absent cache fields to zero; only adapter provenance or a
 * non-zero value can establish that cache usage was reported. */
export function cacheUsageObservation(usage) {
  if (!usage || typeof usage !== "object") return { readReported: false, writeReported: false, cacheRead: null, cacheWrite: null };
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const read = count(usage.cacheRead), write = count(usage.cacheWrite);
  const marked = typeof usage.cacheReported === "boolean" ? usage.cacheReported : null;
  const readReported = marked === true ? read !== null : marked === false ? false : (read ?? 0) > 0;
  const writeReported = marked === true ? write !== null : marked === false ? false : (write ?? 0) > 0;
  return { readReported, writeReported, cacheRead: readReported ? read : null, cacheWrite: writeReported ? write : null };
}

const TOOL_CATEGORIES = Object.freeze({
  bash: "workspace",
  verify_stage: "verifier",
  close_stage: "closing",
  compact_to_memory_block: "compaction",
  read_memory_source: "retrieval",
  search_memory_source: "retrieval",
});

export async function runProgressiveSession({ directory, arm, task, model, modelRuntime, signal, clock, retryDelay = delay, onEvent = () => {}, contextModifierFactory }) {
  if (!["native", "memory"].includes(arm)) throw new Error("unknown experiment arm");
  const { memoryCompressionThreshold } = CONFIG;
  const deadline = armDeadline(clock);
  const combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  const monotonicNow = typeof clock?.performance?.now === "function" ? () => clock.performance.now() : () => performance.now();
  const startedMonotonic = monotonicNow();
  const armElapsedMs = () => Math.max(0, monotonicNow() - startedMonotonic);
  let session, sandbox, evidence, sessionManager, memoryRegistration;
  let stage = 1;
  let phase = "work";
  let providerFailed = false;
  let providerFailure;
  let terminalProviderError;
  let consecutiveFailures = 0;
  let recovering = false;
  let infrastructureError;
  let recall = null;
  const stages = [];
  const metrics = { requests: 0, tools: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheReadReportedRequests: 0, cacheWriteReportedRequests: 0, usageReportedRequests: 0, nativeCompactions: 0, toolBytes: 0, toolCounts: {}, toolCategories: {}, costReportedRequests: 0, reportedCost: 0, providerErrors: 0, retryScheduled: 0, retryContinuations: 0, retryRecovered: 0 };
  const usagePending = [];
  const flagCalls = new Map();
  const toolStartedAt = new Map();
  let previousBlocks = [];
  let pendingApplication;
  let emergency = false;
  const emergencyCompaction = { requested: 0, recorded: 0, applied: 0, refused: 0, appends: 0, rebuilds: 0 };
  const coverage = { stageGates: 0, appends: 0, rebuilds: 0 };
  let memoryAvailable = false;
  let verifying = false;
  const problems = { verificationFailures: 0, compactionRefusals: {}, applicationPending: false };
  const emit = (kind, data) => {
    try { evidence.append(kind, { armElapsedMs: armElapsedMs(), ...data }); onEvent({ arm, stage, phase, kind }); }
    catch (error) { infrastructureError = error; throw error; }
  };
  const activeNames = () => {
    const reading = arm === "memory" && memoryAvailable ? MEMORY_TOOLS.slice(1) : [];
    if (pendingApplication) return reading;
    if (phase === "work") return emergency ? ["compact_to_memory_block", ...reading] : ["bash", "verify_stage", ...reading];
    if (phase === "closing") return ["close_stage", "compact_to_memory_block", ...reading];
    if (phase === "compact") return ["compact_to_memory_block", ...reading];
    return reading;
  };
  const maintenanceContinuation = () => {
    if (emergency && !pendingApplication) return "Context safety exception: pause stage work and call compact_to_memory_block alone using the current Context Memory maintenance advisory. Preserve project facts, every released identifier, and unfinished work. This does not verify or complete the stage; resume the same stage only after Memory application.";
    if (phase === "closing") {
      return "Use the actual registered close_stage tool interface now. Writing a tool name or XML/JSON/prose that describes a call does not execute it. Only a real successful tool result advances this stage.";
    }
    if (pendingApplication) {
      return "A real compaction call was recorded and is awaiting application. Do not call it again; stop and wait. Only a later request carrying the applied Memory and replacing the flag's original message advances this stage.";
    }
    return "No successful compaction call has been recorded. Use the actual registered compact_to_memory_block tool interface now, as the sole tool call in its batch. Writing XML, JSON, or prose that describes a call does not execute it. Only a real recorded call and its later application advance this stage.";
  };
  const abort = () => { void session?.abort(); };
  const runSandbox = async (command, options = {}) => {
    try { return await sandbox.run(command, { ...options, signal: combined }); }
    catch (error) { infrastructureError = error; abort(); throw error; }
  };
  const requirePhase = expected => { combined.throwIfAborted(); if (phase !== expected) throw new Error("tool-phase-unavailable"); };
  try {
    combined.throwIfAborted();
    mkdirSync(directory, { mode: 0o700 });
    const cwd = join(directory, "workspace"), agentDir = join(directory, "agent");
    mkdirSync(cwd, { mode: 0o700 }); mkdirSync(agentDir, { mode: 0o700 });
    for (const [name, content] of Object.entries(task.setupFiles)) writeFileSync(join(cwd, name), content, { mode: 0o600, flag: "wx" });
    sandbox = createSandbox({ workspace: cwd });
    evidence = createEvidence(join(directory, "evidence"));
    writeFileSync(join(agentDir, "auth.json"), "{}\n", { mode: 0o600 });
    // Native auto-retry deletes the failed assistant only from live state. A
    // partial response then breaks Memory's alignment with persisted history.
    // Ordinary continuation prompts preserve both sides of that boundary.
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [], quietStartup: true, compaction: { enabled: arm === "native" }, retry: { enabled: false, provider: { maxRetries: 0 } } }), { mode: 0o600 });
    const settingsManager = SettingsManager.create(cwd, agentDir);
    sessionManager = SessionManager.create(cwd, join(directory, "sessions"));
    const thinking = requireThinkingConfiguration(model, CONFIG.thinkingLevel);
    const factory = pi => {
      if (arm === "memory") {
        // Production remains the owner of Memory eligibility; the experiment
        // intersects its active-tool selection with the current stage phase.
        const gatedPi = new Proxy(pi, { get(target, property) {
          if (property === "setActiveTools") return names => target.setActiveTools(names.filter(name => activeNames().includes(name)));
          return target[property];
        } });
        memoryRegistration = registerMemory(gatedPi, {
          configProvider: () => ({ contextMemory: { enabled: true, compressionThreshold: memoryCompressionThreshold, memoryBudgetPercent: CONFIG.memoryBudgetPercent } }),
          displayRuntimeProvider: () => { throw new Error("display not used by progressive experiment"); },
          reserveTokens: () => settingsManager.getCompactionSettings().reserveTokens,
        });
      }
      pi.registerTool({ name: "close_stage", label: "Record verified workspace", description: "Record the verified CLI size and SHA-256 before compaction. This real closing operation moves the just-issued flag outside the latest protected tool batch. Call it once after verification and before compact.", parameters: Type.Object({}),
        async execute() {
          requirePhase("closing");
          const result = await runSandbox('node -e \'const fs=require("fs"),c=require("crypto"),b=fs.readFileSync("cli.mjs"); console.log(JSON.stringify({bytes:b.length,sha256:c.createHash("sha256").update(b).digest("hex")}))\'', { signal: combined });
          if (result.exitCode !== 0) throw new Error("verified-workspace-snapshot-failed");
          phase = "compact";
          emit("workspace-snapshot", { stage, ...JSON.parse(result.stdout) });
          pi.setActiveTools(activeNames());
          return resultOf({ ...JSON.parse(result.stdout), instruction: "Now call compact_to_memory_block alone, preserving all necessary project facts and flags. After its acknowledgement, stop and wait for the next stage." });
        } });
      pi.registerTool({ name: "bash", label: "Workspace shell", description: "Run a shell command inside the isolated project workspace. Use it to read, write, and execute project files. No network or host files are available.", parameters: Type.Object({ command: Type.String() }),
        async execute(_id, args) { requirePhase("work"); const result = await runSandbox(args.command); return resultOf(result, result.exitCode !== 0); } });
      pi.registerTool({ name: "verify_stage", label: "Verify current stage", description: "Run the trusted hidden cumulative tests for the current stage. Only the first complete pass releases that stage's project identifier.", parameters: Type.Object({}),
        async execute(toolCallId) {
          requirePhase("work");
          if (verifying) return resultOf({ error: "verification-already-running" }, true);
          verifying = true;
          let result;
          try { result = await task.verify(stage, input => runSandbox("node cli.mjs", { input: JSON.stringify(input) }), combined); }
          finally { verifying = false; }
          combined.throwIfAborted();
          emit("verification", { stage, ...result });
          if (!result.ok) { problems.verificationFailures++; return resultOf(result, true); }
          Object.assign(stages.at(-1), { passed: true, passedAtMs: armElapsedMs() });
          flagCalls.set(stage, toolCallId);
          phase = arm === "memory" ? "closing" : "passed";
          pi.setActiveTools(activeNames());
          emit("flag-issued", { stage, flag: task.flags[stage - 1] });
          return resultOf({ passed: true, stage, flag: task.flags[stage - 1], instruction: arm === "memory" ? "This stage passed. Call close_stage to record the verified workspace, then compact_to_memory_block alone to preserve the project facts and all flags. Wait for the next stage after compaction." : "This stage is complete. Stop and wait for the next stage prompt." });
        } });
      pi.on("tool_call", event => activeNames().includes(event.toolName) && !(phase === "closing" && event.toolName === "compact_to_memory_block") ? undefined : { block: true, reason: "This tool is unavailable in the current experiment phase. Finish the required closing operation before compacting." });
      pi.on("context", (event, ctx) => {
        let newlyRequested = false;
        const snapshot = memoryRegistration?.snapshot(ctx.getContextUsage());
        const safetyBound = CONFIG.contextWindow - settingsManager.getCompactionSettings().reserveTokens;
        const threshold = Math.floor(safetyBound * CONFIG.emergencyCompaction.safetyBudgetRatio);
        // The production estimate includes a pending rebuild's original sources.
        // Only its fit-approved advisory authorizes exceptional work-phase compact.
        if (phase === "work" && !pendingApplication && !emergency
          && snapshot?.maintenance && !snapshot.maintenance.suppressed
          && snapshot.pressure?.estimated >= threshold) {
          emergency = true;
          newlyRequested = true;
          emergencyCompaction.requested++;
          emit("emergency-compaction-requested", { stage, estimatedTokens: snapshot.pressure.estimated, thresholdTokens: threshold, safetyBoundTokens: safetyBound, operation: snapshot.maintenance.operation });
        }
        if (emergency && !pendingApplication && (!snapshot?.maintenance || snapshot.maintenance.suppressed)) {
          emergency = false;
          emit("emergency-compaction-deferred", { stage, reason: snapshot?.scaleLimit ? "source-scale-limit" : "maintenance-unavailable" });
        }
        memoryAvailable = arm === "memory" && deriveCurrentMemory(sessionManager).kind === "valid";
        pi.setActiveTools(activeNames());
        // The current tool snapshot cannot execute the newly enabled compact.
        // Its stop/wait reminder replaces the conflicting production advisory.
        if (newlyRequested) return { messages: event.messages.filter(message => message.customType !== "pi-square.context-memory/advisory") };
      });
      pi.on("tool_execution_start", event => toolStartedAt.set(event.toolCallId, monotonicNow()));
      pi.on("tool_execution_end", event => {
        if (event.toolName === "compact_to_memory_block") {
          const memory = deriveCurrentMemory(sessionManager);
          if (event.result?.details?.recorded && memory.kind === "valid") {
            const blocks = memory.blocks;
            const operation = blocks.length === previousBlocks.length + 1 && previousBlocks.every((block, i) => block.endEntryId === blocks[i].endEntryId && block.markdown === blocks[i].markdown) ? "append" : "rebuild";
            const purpose = phase === "work" && emergency ? "emergency" : "stage";
            // Application must remove evidence newly covered by this operation,
            // not an old prefix source already absent before this recording.
            const previouslyReplaced = new Set(previousBlocks.flatMap(block => block.sourceEntries.filter(entry => !block.retainedEntryIds.includes(entry.id)).map(entry => entry.id)));
            const newSources = purpose === "emergency" ? blocks.flatMap(block => block.sourceEntries.filter(entry => !block.retainedEntryIds.includes(entry.id) && !previouslyReplaced.has(entry.id))) : [];
            const source = newSources.findLast(entry => entry.type === "message" && entry.message.role === "toolResult")
              ?? newSources.findLast(entry => entry.type === "message" && entry.message.role !== "user");
            pendingApplication = { stage, purpose, memoryId: memory.stateEntryId, operation, request: metrics.requests,
              ...(source ? { sourceEntry: source.id } : {}) };
            problems.applicationPending = true;
            previousBlocks = blocks;
            if (purpose === "emergency") emergencyCompaction.recorded++;
            emit(purpose === "emergency" ? "emergency-compaction-recorded" : "memory-recorded", pendingApplication);
          } else {
            const code = /\b[A-Z][A-Z0-9_]{3,}\b/.exec(textOf(event.result))?.[0] ?? "UNCLASSIFIED";
            if (phase === "work" && emergency) emergencyCompaction.refused++;
            problems.compactionRefusals[code] = (problems.compactionRefusals[code] ?? 0) + 1;
            emit("compaction-refused", { stage, request: metrics.requests, code });
          }
        }
        const bytes = Buffer.byteLength(JSON.stringify(event.result ?? {}));
        const finishedAt = monotonicNow();
        const elapsedMs = Math.max(0, finishedAt - (toolStartedAt.get(event.toolCallId) ?? finishedAt));
        toolStartedAt.delete(event.toolCallId);
        const category = TOOL_CATEGORIES[event.toolName] ?? "other";
        const categoryMetric = metrics.toolCategories[category] ??= { count: 0, bytes: 0, elapsedMs: 0 };
        categoryMetric.count++; categoryMetric.bytes += bytes; categoryMetric.elapsedMs += elapsedMs;
        metrics.tools++; metrics.toolCounts[event.toolName] = (metrics.toolCounts[event.toolName] ?? 0) + 1; metrics.toolBytes += bytes; emit("tool-result", { stage, phase, name: event.toolName, category, bytes, elapsedMs, error: event.isError, result: event.result }); });
      pi.on("session_compact", () => {
        metrics.nativeCompactions++; emit("native-compaction", { stage, phase });
        if (arm === "memory") { infrastructureError = new Error("native-compaction-in-memory-arm"); abort(); }
      });
    };
    const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      systemPrompt: "You are developing a local data-processing project. Use only the supplied tools and current-stage instructions. Invoke tools through their actual registered tool interface; writing XML, JSON, or prose that describes a tool call does not execute it. Work in /workspace. Hidden tests are authoritative. Preserve every released project identifier for final recall. Do not attempt to access hidden verifier code or unrevealed stages.",
      extensionFactories: [{ name: "progressive-coordinator", factory }, ...(contextModifierFactory ? [{ name: "progressive-test-observer", factory: pi => contextModifierFactory(pi, { sessionManager }) }] : [])] });
    await resourceLoader.reload();
    ({ session } = await createAgentSession({ cwd, agentDir, settingsManager, resourceLoader, sessionManager, modelRuntime,
      model: { ...model, contextWindow: CONFIG.contextWindow }, thinkingLevel: CONFIG.thinkingLevel, tools: ["bash", "verify_stage", "close_stage", ...(arm === "memory" ? MEMORY_TOOLS : [])] }));
    requireSessionThinking(session, thinking);
    if (session.model.provider !== model.provider || session.model.id !== model.id || session.model.contextWindow !== CONFIG.contextWindow) throw new Error("session-model-configuration-mismatch");
    await session.bindExtensions({ mode: "print", onError: () => { infrastructureError = new Error("extension-error"); abort(); } });
    if (resourceLoader.getExtensions().errors.length) throw new Error("extension-load-error");
    combined.addEventListener("abort", abort, { once: true });
    combined.throwIfAborted();
    const stream = session.agent.streamFunction;
    session.agent.streamFunction = async (requestModel, context, options) => {
      combined.throwIfAborted();
      // AgentSession snapshots the tool array before context handlers run.
      // Enforce the phase once more at the public provider stream boundary.
      const request = ++metrics.requests;
      const requestStartedAt = monotonicNow();
      const requestStage = stage, requestPhase = phase;
      if (pendingApplication && arm === "memory") {
        const memory = deriveCurrentMemory(sessionManager);
        const isEmergency = pendingApplication.purpose === "emergency";
        const call = flagCalls.get(stage);
        const original = sessionManager.getBranch().find(entry => isEmergency ? entry.id === pendingApplication.sourceEntry
          : entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === call);
        const expected = memory.kind === "valid" ? [MEMORY_SUMMARY_WRAPPER, ...memory.blocks.map(block => MEMORY_BLOCK_SEPARATOR + block.markdown)] : [];
        const carrier = expected.length > 0 && context.messages.some(message => Array.isArray(message.content) && JSON.stringify(message.content.filter(part => part.type === "text").map(part => part.text)) === JSON.stringify(expected));
        const replaced = original && memory.kind === "valid" && memory.blocks.some(block => block.sourceEntries.some(entry => entry.id === original.id) && !block.retainedEntryIds.includes(original.id));
        const absent = isEmergency
          ? original && !context.messages.some(message => message.role === original.message.role && message.timestamp === original.message.timestamp
            && digest(message.content) === digest(original.message.content))
          : !context.messages.some(message => message.role === "toolResult" && message.toolCallId === call);
        if (memory.kind === "valid" && memory.stateEntryId === pendingApplication.memoryId && carrier && replaced && absent && request > pendingApplication.request) {
          pendingApplication.appliedAtRequest = request;
          if (isEmergency) {
            emergencyCompaction.applied++;
            emergencyCompaction[pendingApplication.operation === "append" ? "appends" : "rebuilds"]++;
            emergency = false;
          } else {
            coverage[pendingApplication.operation === "append" ? "appends" : "rebuilds"]++;
            coverage.stageGates++;
            phase = "passed";
            stages.at(-1).appliedAtMs = armElapsedMs();
          }
          emit(isEmergency ? "emergency-compaction-applied" : "memory-applied", { ...pendingApplication, sourceEntry: original.id, replaced: true, carrier: true });
          pendingApplication = undefined;
          problems.applicationPending = false;
        }
      }
      let visible = (context.tools ?? []).filter(tool => activeNames().includes(tool.name));
      // Pi snapshots executable tools before context handlers. A newly enabled
      // compact becomes executable on the next prompt, never by inventing a schema.
      if (emergency && !pendingApplication) {
        const instruction = visible.some(tool => tool.name === "compact_to_memory_block")
          ? maintenanceContinuation()
          : "Context safety exception: pause stage work and end this response now. The coordinator will enable compact_to_memory_block on the next prompt. Do not call unavailable tools.";
        if (!visible.some(tool => tool.name === "compact_to_memory_block")) visible = [];
        context = { ...context, messages: [...context.messages, { role: "user", content: instruction, timestamp: Date.now() }] };
      }
      emit("request", { request, stage, phase, tools: visible.map(t => t.name), toolSchemaSha256: digest(visible), toolSchemaBytes: Buffer.byteLength(JSON.stringify(visible)), systemSha256: digest(context.systemPrompt ?? ""), messages: context.messages.map(message => message.role === "assistant" ? { ...message, content: message.content.filter(part => part.type !== "thinking") } : message) });
      const response = await stream(requestModel, { ...context, tools: visible }, options);
      usagePending.push(response.result().then(message => {
        const usage = message.usage;
        if (Number.isFinite(usage?.input) && Number.isFinite(usage?.output)) { metrics.input += usage.input; metrics.output += usage.output; metrics.usageReportedRequests++; }
        const cache = cacheUsageObservation(usage);
        if (cache.readReported) { metrics.cacheRead += cache.cacheRead; metrics.cacheReadReportedRequests++; }
        if (cache.writeReported) { metrics.cacheWrite += cache.cacheWrite; metrics.cacheWriteReportedRequests++; }
        if (Number.isFinite(usage?.cost?.total)) { metrics.reportedCost += usage.cost.total; metrics.costReportedRequests++; }
        providerFailed = message.stopReason === "error";
        providerFailure = providerFailed ? message : undefined;
        if (providerFailed) { metrics.providerErrors++; consecutiveFailures++; }
        else if (message.stopReason !== "aborted") {
          consecutiveFailures = 0;
          if (recovering) { metrics.retryRecovered++; recovering = false; emit("provider-recovered", { stage, phase, request }); }
        }
        if (message.stopReason === "aborted" && !combined.aborted) infrastructureError = new Error("native-run-aborted");
        emit("response", { request, stage: requestStage, phase: requestPhase, elapsedMs: Math.max(0, monotonicNow() - requestStartedAt), stopReason: message.stopReason, diagnostic: safeResponseDiagnostic(message), usage: usage ? { input: usage.input, output: usage.output, cacheRead: cache.cacheRead, cacheWrite: cache.cacheWrite, cacheReadReported: cache.readReported, cacheWriteReported: cache.writeReported } : null });
      }).catch(error => { infrastructureError = error; abort(); }));
      return response;
    };
    emit("configuration", { arm, config: CONFIG, memoryCompressionThreshold, model: { provider: model.provider, id: model.id, api: model.api, contextWindow: session.model.contextWindow, maxTokens: session.model.maxTokens }, thinking: { ...thinking, session: session.thinkingLevel }, compaction: settingsManager.getCompactionSettings(), retry: settingsManager.getRetrySettings(), providerRetry: settingsManager.getProviderRetrySettings(), session: digest(sessionManager.getSessionId()) });
    const prompt = async text => {
      for (;;) {
        combined.throwIfAborted();
        providerFailed = false; providerFailure = undefined;
        session.setActiveToolsByName(activeNames());
        let promptError;
        try { await session.prompt(text, { source: "interactive", expandPromptTemplates: false }); }
        catch (error) { promptError = error; }
        await Promise.all(usagePending.splice(0));
        combined.throwIfAborted();
        if (infrastructureError) throw infrastructureError;
        if (!providerFailed) { if (promptError) throw promptError; return; }
        if (!isRetryableProviderError(providerFailure) || isContextOverflow(providerFailure, CONFIG.contextWindow)) {
          terminalProviderError = promptError ?? new Error("provider-response-error");
          throw terminalProviderError;
        }
        const delayMs = Math.min(CONFIG.recovery.maxDelayMs, CONFIG.recovery.initialDelayMs * 2 ** (consecutiveFailures - 1));
        metrics.retryScheduled++;
        emit("provider-retry", { stage, phase, request: metrics.requests, consecutiveFailures, delayMs, diagnostic: safeResponseDiagnostic(providerFailure) });
        await retryDelay(delayMs, undefined, { signal: combined });
        combined.throwIfAborted();
        text = phase === "final" ? FINAL_RECALL : phase === "work" && !emergency && !pendingApplication ? WORK_CONTINUATION
          : phase === "passed" ? "The current stage is complete. Stop and wait for the next stage. Do not repeat completed tool operations."
            : maintenanceContinuation();
        metrics.retryContinuations++; recovering = true;
        emit("provider-continue", { stage, phase });
      }
    };
    while (stage <= 8) {
      phase = "work";
      stages.push({ stage, passed: false, startedAtMs: armElapsedMs() });
      emit("stage-start", { stage });
      await prompt(`${stage === 1 ? task.openingPrompt + "\n\n" : ""}STAGE ${stage}\n${task.prompt(stage)}`);
      while (phase !== "passed") await prompt(phase === "work" && !emergency && !pendingApplication
        ? WORK_CONTINUATION
        : maintenanceContinuation());
      stage++;
    }
    phase = "final";
    await prompt(FINAL_RECALL);
    recall = gradeRecall(textOf([...session.messages].reverse().find(message => message.role === "assistant")), task.flags);
    emit("recall", recall);
    chmodSync(sessionManager.getSessionFile(), 0o600);
  } catch (error) {
    if (error !== terminalProviderError) infrastructureError ??= error;
    if (evidence) { try { emit("error", safeErrorDiagnostic(error, { repoRoot: directory })); } catch { /* the returned status records evidence failure */ } }
  } finally {
    deadline.close(); combined.removeEventListener("abort", abort);
    if (combined.aborted) await session?.abort();
    session?.dispose(); sandbox?.dispose();
    const sessionFile = sessionManager?.getSessionFile();
    if (sessionFile && existsSync(sessionFile)) chmodSync(sessionFile, 0o600);
  }
  let nativeReplay = null;
  const sessionFile = sessionManager?.getSessionFile();
  if (sessionFile && existsSync(sessionFile)) {
    try {
      const fileIdentity = async () => {
        const hash = createHash("sha256"); let bytes = 0;
        for await (const chunk of createReadStream(sessionFile, { highWaterMark: 64 * 1024 })) { hash.update(chunk); bytes += chunk.length; }
        return { sha256: hash.digest("hex"), bytes };
      };
      const before = await fileIdentity();
      const reopened = SessionManager.open(sessionFile);
      nativeReplay = {
        ...before,
        branchEquivalent: digest(sessionManager.getBranch()) === digest(reopened.getBranch()),
        memoryEquivalent: digest(deriveCurrentMemory(sessionManager)) === digest(deriveCurrentMemory(reopened)),
        diskUnchanged: before.sha256 === (await fileIdentity()).sha256,
      };
      if (!nativeReplay.branchEquivalent || !nativeReplay.memoryEquivalent || !nativeReplay.diskUnchanged) throw new Error("native-replay-mismatch");
      emit("native-replay", nativeReplay);
    } catch (error) { infrastructureError = error; }
  }
  let manifest;
  try { manifest = evidence?.close(); } catch (error) { infrastructureError = error; }
  const status = deadline.signal.aborted ? "timeout" : signal?.aborted ? "cancelled" : infrastructureError ? "infrastructure-error" : providerFailed ? "provider-error" : !recall?.complete ? "recall-error" : arm === "memory" && (coverage.stageGates !== 8 || coverage.appends < 1 || coverage.rebuilds < 2) ? "coverage-incomplete" : "passed";
  return { arm, status, stages, recall, coverage, emergencyCompaction, metrics, problems, nativeReplay, terminal: { stage: Math.min(stage, 8), phase }, elapsedMs: armElapsedMs(), evidence: manifest,
    ...((infrastructureError ?? terminalProviderError) ? { diagnostic: safeErrorDiagnostic(infrastructureError ?? terminalProviderError, { repoRoot: directory }) } : {}) };
}
