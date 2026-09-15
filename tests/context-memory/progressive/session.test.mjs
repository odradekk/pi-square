import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { readEvidence } from "./evidence.mjs";
import { createTask } from "./task.mjs";
import { referenceCliSource } from "./reference-fixture.mjs";
import { runProgressiveSession, gradeRecall } from "./session.mjs";

const root = mkdtempSync(join(tmpdir(), "progressive-session-test-"));
try {
  writeFileSync(join(root, "auth.json"), "{}\n");
  const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  const faux = fauxProvider({ provider: "progressive-test", api: "progressive-test", models: [{ id: "test", contextWindow: 500_000, maxTokens: 8192, reasoning: true }] });
  runtime.registerNativeProvider(faux.provider);
  const model = { ...runtime.getModel("progressive-test", "test"), thinkingLevelMap: { max: "high" } };
  const flags = Array.from({ length: 8 }, (_, i) => `independent-test-project-fact-${i}`);
  const prompts = [];
  const failures = new Set();
  const task = { flags, openingPrompt: "Preserve the eight flags.", setupFiles: { "cli.mjs": "console.log('{}');" },
    prompt: stage => `STAGE ${stage}`, verify: async () => ({ ok: true, failures: [] }) };
  faux.setResponses(Array.from({ length: 40 }, () => context => {
    const tools = context.tools?.map(t => t.name) ?? [];
    assert.equal(tools.some(t => /memory/.test(t)), false);
    const user = [...context.messages].reverse().find(m => m.role === "user");
    const text = typeof user.content === "string" ? user.content : user.content.map(p => p.text ?? "").join("");
    const boundary = text.includes("FINAL RECALL") ? "final" : tools.includes("verify_stage") ? "work" : "verified";
    if (!failures.has(boundary)) {
      failures.add(boundary);
      return fauxAssistantMessage("", { stopReason: "error", errorMessage: { work: "read ECONNRESET", verified: "write EPIPE", final: "UND_ERR_SOCKET: socket closed" }[boundary] });
    }
    if (text.includes("FINAL RECALL")) {
      assert.deepEqual(tools, []);
      return fauxAssistantMessage(JSON.stringify(Object.fromEntries(flags.map((f,i) => [String(i+1), f]))));
    }
    if (tools.includes("verify_stage")) { prompts.push([...context.messages].reverse().filter(m => m.role === "user").map(m => typeof m.content === "string" ? m.content : m.content.map(p => p.text ?? "").join("")).find(text => /STAGE \d/.test(text))); return fauxAssistantMessage(fauxToolCall("verify_stage", {}), { stopReason: "toolUse" }); }
    return fauxAssistantMessage("Stage complete.");
  }));
  const result = await runProgressiveSession({ directory: join(root, "arm"), arm: "native", task, model, modelRuntime: runtime, retryDelay: async () => {} });
  assert.equal(result.status, "passed", JSON.stringify(result));
  assert.equal(result.stages.filter(s => s.passed).length, 8);
  assert.equal(result.recall.correct, 8);
  assert.equal(result.metrics.providerErrors, 3);
  assert.equal(result.metrics.retryScheduled, 3);
  assert.equal(result.metrics.retryContinuations, 3);
  assert.equal(result.metrics.retryRecovered, 3);
  assert.equal(prompts.length, 8);
  for (let i=0;i<8;i++) assert.match(prompts[i], new RegExp(`STAGE ${i+1}`));
  console.log("progressive native stage chain passed");
} finally { rmSync(root, { recursive: true, force: true }); }

// A real Memory tool recording must replace each issued flag before the next prompt.
// The second deterministic case retains implementation facts to exercise rebuild
// coverage. Both cases use the same configuration as the paid runner.
for (const retainImplementation of [false, true]) {
const memoryRoot = mkdtempSync(join(tmpdir(), "progressive-memory-test-"));
try {
  writeFileSync(join(memoryRoot, "auth.json"), "{}\n");
  const runtime = await ModelRuntime.create({ authPath: join(memoryRoot, "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  const faux = fauxProvider({ provider: "progressive-memory-test", api: "progressive-memory-test", models: [{ id: "test", contextWindow: 500_000, maxTokens: 8192, reasoning: true }] });
  runtime.registerNativeProvider(faux.provider);
  const model = { ...runtime.getModel("progressive-memory-test", "test"), thinkingLevelMap: { max: "high" } };
  const flags = Array.from({ length: 8 }, (_, i) => `memory-stage-unique-value-${i}`);
  const known = {};
  let probes = 0;
  let removedCarrier = false;
  let refusedAdvance = false;
  let finalSearches = 0;
  let finalReads = 0;
  let plainMarkupAttempts = 0;
  let markupFeedbackSeen = 0;
  let pendingFeedbackSeen = 0;
  const events = [];
  const recoveredBoundaries = new Set();
  faux.setResponses(Array.from({ length: 100 }, () => context => {
    const tools = context.tools?.map(t => t.name) ?? [];
    const last = context.messages.at(-1);
    const body = typeof last.content === "string" ? last.content : last.content.map(p => p.text ?? "").join("");
    const finalRecall = context.messages.some(message => message.role === "user"
      && (typeof message.content === "string" ? message.content : message.content.map(part => part.text ?? "").join("")).includes("FINAL RECALL"));
    const failureBoundary = finalRecall ? "final" : last.role === "toolResult" && last.toolName === "verify_stage" ? "verified"
      : last.role === "toolResult" && last.toolName === "compact_to_memory_block" ? "recorded" : null;
    if (retainImplementation && failureBoundary && !recoveredBoundaries.has(failureBoundary)) {
      recoveredBoundaries.add(failureBoundary);
      if (failureBoundary === "recorded") {
        assert.equal(events.some(event => event.kind === "memory-recorded"), true);
        assert.equal(events.some(event => event.kind === "memory-applied"), false);
        assert.equal(events.some(event => event.kind === "stage-start" && event.stage === 2), false);
      }
      return fauxAssistantMessage(failureBoundary === "verified" ? "Interrupted partial response." : "", {
        stopReason: "error", errorMessage: failureBoundary === "recorded" ? "read tcp 192.0.2.1:59696->198.51.100.2:443: read: connection reset by peer" : "Connection error.",
      });
    }
    if (finalRecall) {
      assert.equal(tools.includes("bash"), false); assert.equal(tools.includes("compact_to_memory_block"), false);
      if (retainImplementation) {
        assert.equal(tools.includes("search_memory_source"), true);
        assert.equal(tools.includes("read_memory_source"), true);
        if (last.role === "toolResult" && last.toolName === "search_memory_source") {
          finalSearches++;
          const row = /block (\d+) · page (\d+) of/.exec(body);
          const view = /view (sv1-[0-9a-f]+)/.exec(body);
          assert.ok(row && view, `search did not return a readable source location: ${body}`);
          return fauxAssistantMessage(fauxToolCall("read_memory_source", { block: Number(row[1]), page: Number(row[2]), view: view[1] }), { stopReason: "toolUse" });
        }
        if (last.role === "toolResult" && last.toolName === "read_memory_source") {
          finalReads++;
          assert.ok(body.includes(known[1]), "the referenced Memory page carries the searched final identifier");
          return fauxAssistantMessage(JSON.stringify(known));
        }
        return fauxAssistantMessage(fauxToolCall("search_memory_source", { terms: [known[1]] }), { stopReason: "toolUse" });
      }
      return fauxAssistantMessage(JSON.stringify(known));
    }
    if (body.includes("Writing XML, JSON, or prose that describes a call does not execute it")) {
      markupFeedbackSeen++;
      assert.equal(events.some(event => event.kind === "memory-recorded"), false, "plain markup did not record Memory");
      assert.equal(events.some(event => event.kind === "memory-applied"), false, "plain markup did not apply Memory");
      assert.equal(events.some(event => event.kind === "stage-start" && event.stage === 2), false, "plain markup did not reveal the next stage");
      assert.equal(tools.includes("compact_to_memory_block"), true);
      return fauxAssistantMessage(fauxToolCall("compact_to_memory_block", { markdown: `Completed project stage facts: ${JSON.stringify(known)}${retainImplementation ? "\nCurrent implementation reference:\n" + referenceCliSource(flags.map((_, i) => known[i+1] ?? "not-yet-issued")) : ""}` }), { stopReason: "toolUse" });
    }
    if (body.includes("A real compaction call was recorded and is awaiting application")) {
      pendingFeedbackSeen++;
      assert.equal(tools.includes("compact_to_memory_block"), false, "recorded maintenance is not offered for repetition while application is pending");
      return fauxAssistantMessage("Waiting for the recorded Memory application.");
    }
    if ((last.role === "toolResult" && last.toolName === "verify_stage") || body.startsWith("Use the actual registered close_stage tool interface now")) {
      const verified = [...context.messages].reverse().find(message => message.role === "toolResult" && message.toolName === "verify_stage");
      const result = JSON.parse(verified.content.map(part => part.text ?? "").join("")); known[result.stage] = result.flag;
      assert.equal(tools.includes("compact_to_memory_block"), true);
      return fauxAssistantMessage(fauxToolCall("close_stage", {}), { stopReason: "toolUse" });
    }
    if (last.role === "toolResult" && last.toolName === "close_stage") {
      if (plainMarkupAttempts++ === 0) return fauxAssistantMessage(`<invoke name="compact_to_memory_block">${JSON.stringify({ markdown: "described but not executed" })}</invoke>`);
      return fauxAssistantMessage(fauxToolCall("compact_to_memory_block", { markdown: `Completed project stage facts: ${JSON.stringify(known)}${retainImplementation ? "\nCurrent implementation reference:\n" + referenceCliSource(flags.map((_, i) => known[i+1] ?? "not-yet-issued")) : ""}` }), { stopReason: "toolUse" });
    }
    if (last.role === "toolResult" && last.toolName === "compact_to_memory_block") {
      if (!retainImplementation && removedCarrier && !refusedAdvance) {
        refusedAdvance = true;
        return fauxAssistantMessage("Recording acknowledged; await an actual applied request.");
      }
      if (tools.includes("compact_to_memory_block")) return fauxAssistantMessage(fauxToolCall("compact_to_memory_block", { markdown: `Completed facts: ${JSON.stringify(known)}\nImplementation:\n${referenceCliSource(flags.map((_, i) => known[i+1] ?? "not-yet-issued"))}` }), { stopReason: "toolUse" });
      assert.match(body, /recorded/, body); probes++; return fauxAssistantMessage("Compaction applied; waiting for the next stage.");
    }
    if (tools.includes("verify_stage")) {
      if (!(last.role === "toolResult" && last.toolName === "bash")) {
        const source = referenceCliSource(flags.map((_, i) => known[i+1] ?? "not-yet-issued"));
        return fauxAssistantMessage(fauxToolCall("bash", { command: `cat > cli.mjs <<'PROJECT_EOF'\n${source}\nPROJECT_EOF\ncat cli.mjs` }), { stopReason: "toolUse" });
      }
      assert.equal(tools.includes("compact_to_memory_block"), false);
      return fauxAssistantMessage(fauxToolCall("verify_stage", {}), { stopReason: "toolUse" });
    }
    return fauxAssistantMessage("Waiting.");
  }));
  const task = createTask({ flags });
  const result = await runProgressiveSession({ directory: join(memoryRoot, "arm"), arm: "memory", task, model, modelRuntime: runtime, retryDelay: async () => {}, onEvent: event => events.push(event),
    contextModifierFactory: pi => pi.on("context", event => {
      if (!removedCarrier && event.messages.some(message => message.customType === "pi-square.context-memory/blocks")) {
        removedCarrier = true;
        return { messages: event.messages.filter(message => message.customType !== "pi-square.context-memory/blocks") };
      }
    }) });
  assert.equal(result.status, retainImplementation ? "passed" : "coverage-incomplete", JSON.stringify(result));
  assert.equal(result.recall.complete, true);
  assert.equal(probes, 7);
  if (!retainImplementation) {
    assert.equal(refusedAdvance, true, "recording without a delivered carrier did not advance");
    const applied = events.findIndex(event => event.kind === "memory-applied" && event.stage === 1);
    const second = events.findIndex(event => event.kind === "stage-start" && event.stage === 2);
    assert.ok(applied >= 0 && second > applied);
  }
  assert.equal(result.coverage.stageGates, 8);
  assert.equal(events.filter(event => event.kind === "flag-issued").length, 8, "recovery never reissues a flag");
  assert.equal(result.metrics.providerErrors, retainImplementation ? 3 : 0);
  assert.equal(result.metrics.retryScheduled, retainImplementation ? 3 : 0);
  assert.equal(result.metrics.retryContinuations, retainImplementation ? 3 : 0);
  assert.equal(result.metrics.retryRecovered, retainImplementation ? 3 : 0);
  if (retainImplementation) assert.ok(result.coverage.rebuilds >= 2);
  else assert.equal(result.coverage.appends, 8);
  assert.equal(finalSearches, retainImplementation ? 1 : 0);
  assert.equal(finalReads, retainImplementation ? 1 : 0);
  assert.equal(plainMarkupAttempts, 8);
  assert.equal(markupFeedbackSeen, 1);
  assert.equal(pendingFeedbackSeen, 1);
  console.log("progressive real Memory gates and direct-block final recall passed");
} finally { rmSync(memoryRoot, { recursive: true, force: true }); }

}

// Both real sessions share a runtime; a stalled provider in one arm cannot
// prevent the other from finishing. Its single clock cancels that same request.
const parallelRoot = mkdtempSync(join(tmpdir(), "progressive-clock-test-"));
try {
  writeFileSync(join(parallelRoot, "auth.json"), "{}\n");
  const runtime = await ModelRuntime.create({ authPath: join(parallelRoot, "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  const faux = fauxProvider({ provider: "progressive-clock", api: "progressive-clock", models: [{ id: "test", contextWindow: 500_000, maxTokens: 8192, reasoning: true }] });
  runtime.registerNativeProvider(faux.provider);
  const model = { ...runtime.getModel("progressive-clock", "test"), thinkingLevelMap: { max: "high" } };
  const flags = Array.from({ length: 8 }, (_, i) => `clock-test-random-fact-${i}`);
  const task = { flags, setupFiles: { "cli.mjs": "console.log('{}')" }, openingPrompt: "Retain the flags.", prompt: stage => `STAGE ${stage}`, verify: async () => ({ ok: true, failures: [] }) };
  const started = Promise.withResolvers();
  let cancelSlow, cleared = 0;
  const clock = { setTimeout(callback, ms) { assert.equal(ms, 3_600_000); assert.equal(cancelSlow, undefined); cancelSlow = callback; return 1; }, clearTimeout() { cleared++; } };
  faux.setResponses([
    (_context, options) => { started.resolve(); return new Promise(resolve => options.signal.addEventListener("abort", () => resolve(fauxAssistantMessage("Cancelled")), { once: true })); },
    ...Array.from({ length: 30 }, () => context => {
      const tools = context.tools?.map(t => t.name) ?? [];
      const last = context.messages.at(-1);
      const body = typeof last.content === "string" ? last.content : last.content.map(p => p.text ?? "").join("");
      if (body.includes("FINAL RECALL")) return fauxAssistantMessage(JSON.stringify(Object.fromEntries(flags.map((f,i) => [i+1,f]))));
      return tools.includes("verify_stage") ? fauxAssistantMessage(fauxToolCall("verify_stage", {}), { stopReason: "toolUse" }) : fauxAssistantMessage("Waiting");
    }),
  ]);
  const slow = runProgressiveSession({ directory: join(parallelRoot, "slow"), arm: "memory", task, model, modelRuntime: runtime, clock });
  await started.promise;
  const fast = await runProgressiveSession({ directory: join(parallelRoot, "fast"), arm: "native", task, model, modelRuntime: runtime });
  assert.equal(fast.status, "passed");
  assert.equal(cleared, 0, "the first arm remains active while its peer completes");
  cancelSlow();
  const cancelled = await slow;
  assert.equal(cancelled.status, "timeout");
  assert.equal(cancelled.recall, null, "an unfinished task has no final recall score");
  assert.equal(cancelled.terminal.stage, 1);
  assert.equal(cancelled.terminal.phase, "work");
  assert.equal(cancelled.metrics.requests, 1);
  assert.equal(cleared, 1);
  assert.notEqual(cancelled.evidence.file, fast.evidence.file);
  console.log("progressive shared-runtime concurrency and single deadline passed");
} finally { rmSync(parallelRoot, { recursive: true, force: true }); }

// Authentication diagnostics stay terminal even when they quote a socket error.
const authSocketErrors = Object.fromEntries(["ECONNRESET", "ECONNABORTED", "EPIPE", "ETIMEDOUT", "UND_ERR_SOCKET", "connection reset by peer", "broken pipe"]
  .map((socket, index) => [`auth-wording-${index}`, `${["Incorrect API key provided", "API key not valid", "invalid token"][index % 3]}: ${socket}`]));

// Retry waits share the original deadline and preserve every failed response.
for (const stop of ["timeout", "cancelled", "auth", "auth-message", "auth-credentials", "forbidden", "quota", "billing", "overflow", "unknown", "infrastructure", "response-infrastructure", "wrong-recall", ...Object.keys(authSocketErrors)]) {
  const retryRoot = mkdtempSync(join(tmpdir(), "progressive-retry-test-"));
  try {
    writeFileSync(join(retryRoot, "auth.json"), "{}\n");
    const runtime = await ModelRuntime.create({ authPath: join(retryRoot, "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
    const faux = fauxProvider({ provider: "progressive-retry", api: "progressive-retry", models: [{ id: "test", contextWindow: 500_000, maxTokens: 8192, reasoning: true }] });
    runtime.registerNativeProvider(faux.provider);
    const model = { ...runtime.getModel("progressive-retry", "test"), thinkingLevelMap: { max: "high" } };
    const flags = Array.from({ length: 8 }, (_, i) => `retry-fact-${i}`);
    const task = { flags, setupFiles: { "cli.mjs": "console.log('{}')" }, openingPrompt: "Retain the flags.", prompt: stage => `STAGE ${stage}`, verify: async () => ({ ok: true, failures: [] }) };
    const controller = new AbortController();
    let expire, cleared = 0, scheduled = 0, calls = 0;
    const clock = { setTimeout(callback, ms) { assert.equal(ms, 3_600_000); assert.equal(expire, undefined, "recovery never resets the deadline"); expire = callback; return 1; }, clearTimeout() { cleared++; } };
    faux.setResponses(Array.from({ length: 25 }, () => context => {
      calls++;
      if (stop === "wrong-recall") {
        return context.tools?.some(tool => tool.name === "verify_stage")
          ? fauxAssistantMessage(fauxToolCall("verify_stage", {}), { stopReason: "toolUse" }) : fauxAssistantMessage("I do not remember");
      }
      return fauxAssistantMessage("Partial upstream response.", { stopReason: "error", errorMessage: authSocketErrors[stop] ?? (
        stop === "auth" ? "401 Unauthorized: read ECONNRESET" : stop === "auth-message" ? "Authentication error: connection reset by peer"
          : stop === "auth-credentials" ? "invalid authentication credentials: ECONNRESET" : stop === "forbidden" ? "403 Forbidden: connection reset by peer"
          : stop === "quota" ? "429 insufficient_quota: read ECONNRESET" : stop === "billing" ? "billing limit exceeded: write EPIPE"
          : stop === "overflow" ? "maximum context length exceeded: connection reset by peer" : stop === "unknown" ? "Unrecognized provider failure"
          : ["read ECONNABORTED", "write: broken pipe", "connect ETIMEDOUT"][calls % 3]) });
    }));
    const result = await runProgressiveSession({ directory: join(retryRoot, "arm"), arm: "native", task, model, modelRuntime: runtime, signal: controller.signal, clock,
      retryDelay: async (_ms, _value, { signal }) => {
        if (scheduled === 8) { if (stop === "timeout") expire(); else controller.abort(); }
        signal.throwIfAborted();
      },
      onEvent(event) {
        if (stop === "infrastructure" && event.kind === "request") throw new Error("local observer failed: read ECONNRESET");
        if (stop === "response-infrastructure" && event.kind === "response") throw new Error("local response observer failed");
        if (event.kind === "provider-retry") scheduled++;
      } });
    const interrupted = stop === "timeout" || stop === "cancelled";
    assert.equal(result.status, interrupted ? stop : stop.endsWith("infrastructure") ? "infrastructure-error" : stop === "wrong-recall" ? "recall-error" : "provider-error");
    assert.equal(result.metrics.providerErrors, interrupted ? 8 : ["infrastructure", "wrong-recall"].includes(stop) ? 0 : 1);
    assert.equal(result.metrics.retryScheduled, interrupted ? 8 : 0);
    assert.equal(result.metrics.retryContinuations, interrupted ? 7 : 0);
    assert.equal(result.metrics.retryRecovered, 0);
    assert.equal(cleared, 1);
    const records = [...readEvidence(result.evidence.file)];
    if (interrupted) {
      assert.equal(calls, 8, "cancellation during backoff makes no ninth provider call");
      assert.equal(result.recall, null);
      assert.deepEqual(records.filter(record => record.kind === "provider-retry").map(record => record.data.delayMs), [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
      assert.equal(records.filter(record => record.kind === "response").length, 8);
      assert.equal(records.filter(record => record.kind === "stage-start").length, 1);
    }
    if (stop === "wrong-recall") {
      assert.equal(result.stages.filter(stage => stage.passed).length, 8);
      assert.equal(calls, 17, "a normal incorrect final answer receives no recovery attempt");
    }
  } finally { rmSync(retryRoot, { recursive: true, force: true }); }
}
console.log("progressive recovery deadline, cancellation, terminal errors and grading passed");

const recallFlags = Array.from({ length: 8 }, (_, i) => `flag-independent-${i}`);
const exactAnswer = Object.fromEntries(recallFlags.map((flag, i) => [i + 1, flag]));
assert.equal(gradeRecall(JSON.stringify(exactAnswer), recallFlags).complete, true);
assert.equal(gradeRecall(JSON.stringify({ ...exactAnswer, 4: "wrong" }), recallFlags).correct, 7);
assert.equal(gradeRecall(JSON.stringify({ ...exactAnswer, extra: "unexpected" }), recallFlags).complete, false);
assert.equal(gradeRecall("I do not remember", recallFlags).complete, false);

// A large completed work exchange crosses the exception threshold while the
// current Pi turn still has its old executable tool snapshot. No paid calls.
for (const rebuild of [false, true]) {
const emergencyRoot = mkdtempSync(join(tmpdir(), "progressive-emergency-test-"));
try {
  writeFileSync(join(emergencyRoot, "auth.json"), "{}\n");
  const runtime = await ModelRuntime.create({ authPath: join(emergencyRoot, "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  const faux = fauxProvider({ provider: "emergency-test", api: "emergency-test", models: [{ id: "test", contextWindow: 256_000, maxTokens: 8192, reasoning: true }] });
  runtime.registerNativeProvider(faux.provider);
  // Faux cache writes overlap its input count; disable that synthetic cache so
  // this case measures the real projection rather than fake residual pressure.
  const streamSimple = runtime.streamSimple.bind(runtime);
  runtime.streamSimple = (model, context, options) => streamSimple(model, context, { ...options, cacheRetention: "none" });
  const model = { ...runtime.getModel("emergency-test", "test"), thinkingLevelMap: { max: "high" } };
  const flags = Array.from({ length: 8 }, (_, i) => `emergency-project-fact-${i}`);
  const known = {}, events = [];
  let workCalls = 0, deferrals = 0, emergencyCalls = 0, resumed = false, reinsertedSource = false, pendingSeen = false, seeded = false;
  const task = { flags, openingPrompt: "Complete the stage and preserve identifiers.", setupFiles: { "cli.mjs": "console.log('{}')" }, prompt: stage => `STAGE ${stage}`, verify: async () => ({ ok: true, failures: [] }) };
  faux.setResponses(Array.from({ length: 100 }, () => context => {
    try {
    const tools = context.tools?.map(tool => tool.name) ?? [];
    const body = message => typeof message.content === "string" ? message.content : message.content.map(part => part.text ?? "").join("\n");
    const last = context.messages.at(-1), text = body(last);
    if (text.includes("FINAL RECALL")) {
      assert.equal(tools.includes("compact_to_memory_block"), false);
      assert.equal(tools.includes("bash"), false);
      return fauxAssistantMessage(JSON.stringify(known));
    }
    if (text.includes("coordinator will enable compact_to_memory_block")) {
      assert.deepEqual(tools, []);
      assert.equal(events.filter(event => event.kind === "flag-issued").length, 1);
      assert.equal(context.messages.some(message => body(message).startsWith("Context Memory: compression is due")), false);
      deferrals++;
      return fauxAssistantMessage("Stopping for emergency maintenance.");
    }
    if (text.startsWith("Context safety exception: pause stage work and call")) {
      assert.equal(tools.includes("compact_to_memory_block"), true);
      assert.equal(tools.includes("bash"), false);
      assert.equal(tools.includes("verify_stage"), false);
      emergencyCalls++;
      if (emergencyCalls === 1) return fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 temporary upstream error" });
      if (emergencyCalls === 2) return fauxAssistantMessage(fauxToolCall("compact_to_memory_block", { markdown: "" }), { stopReason: "toolUse" });
      return fauxAssistantMessage(fauxToolCall("compact_to_memory_block", { markdown: `The workspace has cli.mjs. The large diagnostic output was inspected. Stage 2 is unfinished. Preserve prior project facts: ${JSON.stringify(known)}` }), { stopReason: "toolUse" });
    }
    if (text.includes("A real compaction call was recorded and is awaiting application")) {
      assert.equal(tools.includes("compact_to_memory_block"), false);
      assert.equal(tools.includes("verify_stage"), false);
      assert.equal(events.filter(event => event.kind === "flag-issued").length, 1);
      pendingSeen = true;
      return fauxAssistantMessage("Waiting for application.");
    }
    if (tools.includes("verify_stage")) {
      assert.equal(tools.includes("compact_to_memory_block"), false);
      const currentStage = events.filter(event => event.kind === "stage-start").at(-1).stage;
      if (currentStage === 1 && !seeded) {
        seeded = true;
        return fauxAssistantMessage(fauxToolCall("bash", { command: "node -e 'console.log(\"y\".repeat(50000))'" }), { stopReason: "toolUse" });
      }
      if (currentStage === 2 && workCalls++ < 2) return fauxAssistantMessage([
        // Cross the pressure threshold only after a second exchange makes the
        // large result eligible; the latest tool batch is protected by Memory.
        ...(workCalls === 2 ? [{ type: "text", text: "Checkpoint analysis: " + "z".repeat(160000) }] : []),
        fauxToolCall("bash", { command: workCalls === 1 ? "node -e 'console.log(\"x\".repeat(540000))'" : "node -e 'console.log(\"work checkpoint\")'" }),
      ], { stopReason: "toolUse" });
      if (currentStage === 2 && !resumed) {
        assert.equal(events.filter(event => event.kind === "emergency-compaction-applied").length, 1);
        assert.equal(events.filter(event => event.kind === "stage-start").length, 2);
        assert.equal(events.filter(event => event.kind === "flag-issued").length, 1);
        resumed = true;
      }
      return fauxAssistantMessage(fauxToolCall("verify_stage", {}), { stopReason: "toolUse" });
    }
    if (tools.includes("close_stage")) {
      const verified = [...context.messages].reverse().find(message => message.role === "toolResult" && message.toolName === "verify_stage");
      const result = JSON.parse(body(verified)); known[result.stage] = result.flag;
      return fauxAssistantMessage(fauxToolCall("close_stage", {}), { stopReason: "toolUse" });
    }
    if (tools.includes("compact_to_memory_block")) return fauxAssistantMessage(fauxToolCall("compact_to_memory_block", { markdown: `Project facts: ${JSON.stringify(known)}${rebuild && Object.keys(known).length === 1 ? "\nPrior diagnostic notes: " + "retained details ".repeat(700) : ""}` }), { stopReason: "toolUse" });
    return fauxAssistantMessage("Waiting for the coordinator.");
    } catch (error) { console.error(error); throw error; }
  }));
  const result = await runProgressiveSession({ directory: join(emergencyRoot, "arm"), arm: "memory", task, model, modelRuntime: runtime, retryDelay: async () => {}, onEvent: event => events.push(event),
    contextModifierFactory: (pi, { sessionManager }) => pi.on("context", event => {
      if (!reinsertedSource && events.some(item => item.kind === "emergency-compaction-recorded")) {
        reinsertedSource = true;
        const branch = sessionManager.getBranch();
        const source = branch.find(entry => entry.type === "message" && entry.message.role === "toolResult" && entry.message.content.some(part => part.text?.includes("x".repeat(100))));
        assert.ok(source, "a newly covered tool source exists after the prior stage block");
        const producer = branch.find(entry => entry.type === "message" && entry.message.role === "assistant" && entry.message.content.some(part => part.type === "toolCall" && part.id === source.message.toolCallId));
        return { messages: [producer.message, source.message, ...event.messages] };
      }
    }) });
  assert.equal(result.status, "coverage-incomplete", JSON.stringify(result));
  assert.equal(result.recall.correct, 8);
  assert.equal(result.coverage.stageGates, 8);
  assert.deepEqual(result.emergencyCompaction, { requested: 1, recorded: 1, applied: 1, refused: 1, appends: rebuild ? 0 : 1, rebuilds: rebuild ? 1 : 0 });
  assert.equal(result.coverage.appends, 8, "the emergency append is not mandatory-stage coverage");
  assert.equal(result.metrics.nativeCompactions, 0);
  assert.equal(result.metrics.providerErrors, 1);
  assert.equal(result.metrics.retryRecovered, 1);
  assert.equal(deferrals, 1); assert.equal(emergencyCalls, 3); assert.equal(resumed, true); assert.equal(pendingSeen, true);
  assert.equal(events.filter(event => event.kind === "flag-issued").length, 8);
  const evidence = [...readEvidence(result.evidence.file)];
  const requested = evidence.find(event => event.kind === "emergency-compaction-requested").data;
  assert.ok(requested.estimatedTokens >= requested.thresholdTokens && requested.estimatedTokens < requested.safetyBoundTokens);
  console.log("progressive emergency compaction handshake, application and stage isolation passed");
} finally { rmSync(emergencyRoot, { recursive: true, force: true }); }

}
