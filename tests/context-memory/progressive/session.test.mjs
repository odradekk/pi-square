import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
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
  const task = { flags, openingPrompt: "Preserve the eight flags.", setupFiles: { "cli.mjs": "console.log('{}');" },
    prompt: stage => `STAGE ${stage}`, verify: async () => ({ ok: true, failures: [] }) };
  faux.setResponses(Array.from({ length: 40 }, () => context => {
    const tools = context.tools?.map(t => t.name) ?? [];
    assert.equal(tools.some(t => /memory/.test(t)), false);
    const user = [...context.messages].reverse().find(m => m.role === "user");
    const text = typeof user.content === "string" ? user.content : user.content.map(p => p.text ?? "").join("");
    if (text.includes("FINAL RECALL")) {
      assert.deepEqual(tools, []);
      return fauxAssistantMessage(JSON.stringify(Object.fromEntries(flags.map((f,i) => [String(i+1), f]))));
    }
    if (tools.includes("verify_stage")) { prompts.push(text); return fauxAssistantMessage(fauxToolCall("verify_stage", {}), { stopReason: "toolUse" }); }
    return fauxAssistantMessage("Stage complete.");
  }));
  const result = await runProgressiveSession({ directory: join(root, "arm"), arm: "native", task, model, modelRuntime: runtime });
  assert.equal(result.status, "passed", JSON.stringify(result));
  assert.equal(result.stages.filter(s => s.passed).length, 8);
  assert.equal(result.recall.correct, 8);
  assert.equal(prompts.length, 8);
  for (let i=0;i<8;i++) assert.match(prompts[i], new RegExp(`STAGE ${i+1}`));
  console.log("progressive native stage chain passed");
} finally { rmSync(root, { recursive: true, force: true }); }

// A real Memory tool recording must replace each issued flag before the next prompt.
// The second deterministic case lowers only the advisory threshold to exercise
// production suffix serving with a compact fixture; paid runs keep the pinned default.
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
  const events = [];
  faux.setResponses(Array.from({ length: 100 }, () => context => {
    const tools = context.tools?.map(t => t.name) ?? [];
    const last = context.messages.at(-1);
    const body = typeof last.content === "string" ? last.content : last.content.map(p => p.text ?? "").join("");
    const finalRecall = context.messages.some(message => message.role === "user"
      && (typeof message.content === "string" ? message.content : message.content.map(part => part.text ?? "").join("")).includes("FINAL RECALL"));
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
    if (last.role === "toolResult" && last.toolName === "verify_stage") {
      const result = JSON.parse(body); known[result.stage] = result.flag;
      assert.equal(tools.includes("compact_to_memory_block"), true);
      return fauxAssistantMessage(fauxToolCall("close_stage", {}), { stopReason: "toolUse" });
    }
    if (last.role === "toolResult" && last.toolName === "close_stage") return fauxAssistantMessage(fauxToolCall("compact_to_memory_block", { markdown: `Completed project stage facts: ${JSON.stringify(known)}${retainImplementation ? "\nCurrent implementation reference:\n" + referenceCliSource(flags.map((_, i) => known[i+1] ?? "not-yet-issued")) : ""}` }), { stopReason: "toolUse" });
    if (last.role === "toolResult" && last.toolName === "compact_to_memory_block") {
      if (tools.includes("compact_to_memory_block") && !retainImplementation && removedCarrier && !refusedAdvance) {
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
  const result = await runProgressiveSession({ directory: join(memoryRoot, "arm"), arm: "memory", task, model, modelRuntime: runtime, onEvent: event => events.push(event),
    ...(retainImplementation ? { memoryCompressionThreshold: { tokens: 10_001 } } : { contextModifierFactory: pi => pi.on("context", event => {
      if (!removedCarrier && event.messages.some(message => message.customType === "pi-square.context-memory/blocks")) {
        removedCarrier = true;
        return { messages: event.messages.filter(message => message.customType !== "pi-square.context-memory/blocks") };
      }
    }) }) });
  assert.equal(result.status, retainImplementation ? "passed" : "coverage-incomplete", JSON.stringify(result));
  assert.equal(result.recall.complete, true);
  assert.equal(probes, retainImplementation ? 8 : 7);
  if (!retainImplementation) {
    assert.equal(refusedAdvance, true, "recording without a delivered carrier did not advance");
    const applied = events.findIndex(event => event.kind === "memory-applied" && event.stage === 1);
    const second = events.findIndex(event => event.kind === "stage-start" && event.stage === 2);
    assert.ok(applied >= 0 && second > applied);
  }
  assert.equal(result.coverage.stageGates, 8);
  if (retainImplementation) assert.ok(result.coverage.rebuilds >= 2);
  else assert.equal(result.coverage.appends, 8);
  assert.equal(finalSearches, retainImplementation ? 1 : 0);
  assert.equal(finalReads, retainImplementation ? 1 : 0);
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
  assert.equal(cancelled.terminal.stage, 1);
  assert.equal(cancelled.terminal.phase, "work");
  assert.equal(cancelled.metrics.requests, 1);
  assert.equal(cleared, 1);
  assert.notEqual(cancelled.evidence.file, fast.evidence.file);
  console.log("progressive shared-runtime concurrency and single deadline passed");
} finally { rmSync(parallelRoot, { recursive: true, force: true }); }

const recallFlags = Array.from({ length: 8 }, (_, i) => `flag-independent-${i}`);
const exactAnswer = Object.fromEntries(recallFlags.map((flag, i) => [i + 1, flag]));
assert.equal(gradeRecall(JSON.stringify(exactAnswer), recallFlags).complete, true);
assert.equal(gradeRecall(JSON.stringify({ ...exactAnswer, 4: "wrong" }), recallFlags).correct, 7);
assert.equal(gradeRecall(JSON.stringify({ ...exactAnswer, extra: "unexpected" }), recallFlags).complete, false);
assert.equal(gradeRecall("I do not remember", recallFlags).complete, false);
