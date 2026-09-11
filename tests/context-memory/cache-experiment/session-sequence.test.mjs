import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { runRealPiCacheExperiment } from "./experiment.mjs";
import { runPiSessionSequence } from "./session-sequence.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const runtimeDir = mkdtempSync(join(tmpdir(), "pi-square-cache-runtime-"));
writeFileSync(join(runtimeDir, "auth.json"), "{}\n", "utf8");

function messageText(message) {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content.map((part) => (part?.type === "text" ? part.text : "")).join("");
}

function requestText(messages) {
  return messages.map(messageText).join("\n");
}

/**
 * The #319 faux model: ordinary read work first, the resident
 * `compact_to_memory_block` tool as the sole call of its batch whenever the
 * due advisory rides a request that already has completed ordinary work to
 * cover, more ordinary work after every recording, and a plain answer
 * otherwise. State is kept per session so one provider can serve parallel
 * matrix lanes.
 */
function memoryWorker({ store = new Map(), onContext } = {}) {
  return (context, options) => {
    if (onContext) onContext(context);
    const state = store.get(options?.sessionId ?? "missing") ?? { records: 0, reads: 0 };
    store.set(options?.sessionId ?? "missing", state);
    const last = context.messages.at(-1);
    const lastToolName = last?.role === "toolResult" ? last.toolName : undefined;
    if (lastToolName === "compact_to_memory_block") {
      return fauxAssistantMessage(fauxToolCall("read", { path: "reference.txt" }), { stopReason: "toolUse" });
    }
    if (lastToolName === "read") {
      state.reads += 1;
      if (requestText(context.messages).includes("compression is due") && state.reads >= 2 && state.records < 2) {
        state.records += 1;
        state.reads = 0;
        return fauxAssistantMessage(
          fauxToolCall("compact_to_memory_block", {
            markdown: `# Memory ${state.records}\n\n- retained fact ${state.records}: the reference pass confirmed the build entry and the ownership notes.`,
          }),
          { stopReason: "toolUse" },
        );
      }
      return fauxAssistantMessage("acknowledged; the reference pass is retained.", { stopReason: "stop" });
    }
    return fauxAssistantMessage(fauxToolCall("read", { path: "reference.txt" }), { stopReason: "toolUse" });
  };
}

try {
  const runtime = await ModelRuntime.create({
    authPath: join(runtimeDir, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const faux = fauxProvider({
    provider: "cache-sequence-test",
    api: "cache-sequence-test",
    models: [{ id: "cache-sequence", contextWindow: 100_000, maxTokens: 1_024 }],
  });
  runtime.registerNativeProvider(faux.provider);

  const observedContexts = [];
  const worker = memoryWorker({
    onContext: (context) => observedContexts.push({
      messages: structuredClone(context.messages),
      toolNames: context.tools?.map((tool) => tool.name) ?? [],
    }),
  });
  faux.setResponses(Array.from({ length: 48 }, () => worker));

  const longMaterial = "stable project fact and implementation detail. ".repeat(520);
  const result = await runPiSessionSequence({
    packageRoot,
    modelRuntime: runtime,
    model: faux.getModel(),
    prompts: [
      `Record this reference for later.\n\n${longMaterial}`,
      "Confirm the reference is understood.",
      `Record this second reference for later.\n\n${longMaterial}`,
      "Confirm both references are understood.",
      "Give a one-line status update.",
      "Give another one-line status update.",
      "Give a final one-line status update.",
    ],
  });

  assert.equal(result.schema, "pi-square.context-memory/pi-session-cache-sequence/2");
  assert.equal(result.execution.driver, "AgentSession.prompt");
  assert.equal(result.execution.promptCount, 7);
  assert.ok(result.session.memoryStateEntries >= 2, "the real Pi prompt loop should record at least two Memory state entries");
  assert.ok(result.session.maximumMemoryBlocks >= 2, "the latest state entry should carry multiple Memory blocks");
  assert.equal(result.integrity.ok, true, result.integrity.failures.join("\n"));
  assert.equal(result.requests.length, observedContexts.length, "one row should come from every real provider request");
  assert.equal(result.session.persistedAssistantResponses, result.requests.length, "Pi should persist every measured assistant response");
  assert.ok(result.requests.some((row) => row.toolNames.includes("compact_to_memory_block")), "Pi should execute the real compact_to_memory_block loop");
  assert.ok(result.requests.slice(1).some((row) => row.cacheRead > 0), "later Pi requests should report prefix-cache reads");
  for (const row of result.requests.filter((candidate) => candidate.promptTokens > 0)) {
    assert.equal(row.hitRate, row.cacheRead / row.promptTokens, "cache hit rate should use Pi's footer formula");
  }

  const projected = observedContexts.find((context) => context.messages.some((message) => {
    if (!Array.isArray(message.content)) return false;
    const parts = message.content.filter((part) => part?.type === "text");
    return parts.length >= 3 && parts.map((part) => part.text ?? "").join("").includes("Context Memory v1");
  }));
  assert.ok(projected, "a real provider request should carry the multi-block Memory carrier");
  const projectedText = requestText(projected.messages);
  assert.ok(!projectedText.includes("Record this reference for later"),
    "the covered original prompt left the projected request");
  assert.ok(projectedText.includes("Record this second reference for later"),
    "the latest uncompressed instruction stays raw in the projected request");

  const anthropic = fauxProvider({
    provider: "ccr-claude",
    api: "cache-matrix-anthropic",
    models: [{ id: "claude-sonnet-5", contextWindow: 100_000, maxTokens: 1_024 }],
  });
  const openai = fauxProvider({
    provider: "cpa",
    api: "cache-matrix-openai",
    models: [
      { id: "glm-5.3", contextWindow: 100_000, maxTokens: 1_024 },
      { id: "gpt-5.6-luna", contextWindow: 100_000, maxTokens: 1_024 },
    ],
  });
  runtime.registerNativeProvider(anthropic.provider);
  runtime.registerNativeProvider(openai.provider);
  const laneState = new Map();
  for (const provider of [anthropic, openai]) {
    provider.setResponses(Array.from({ length: 160 }, () => memoryWorker({ store: laneState })));
  }

  const matrix = await runRealPiCacheExperiment({
    runtime,
    generatedAt: "2026-09-09T00:00:00.000Z",
  });
  assert.equal(matrix.schema, "pi-square.context-memory/pi-session-cache-matrix/2");
  assert.equal(matrix.execution.modelLanes, 3);
  assert.equal(matrix.execution.laneConcurrency, "parallel");
  assert.deepEqual(matrix.comparison.map((row) => `${row.provider}/${row.model}`), [
    "ccr-claude/claude-sonnet-5",
    "cpa/glm-5.3",
    "cpa/gpt-5.6-luna",
  ]);
  assert.ok(matrix.comparison.every((row) => row.memoryStateEntries >= 2 && row.maximumMemoryBlocks >= 2),
    "every lane records a multi-block Context Memory");
  assert.equal(matrix.integrity.ok, true, JSON.stringify(matrix.runs.map((run) => run.integrity.failures)));
} finally {
  rmSync(runtimeDir, { recursive: true, force: true });
}

console.log("context-memory real Pi session cache sequence: ok");
