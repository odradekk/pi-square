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

  let block = 0;
  const observedContexts = [];
  faux.setResponses(Array.from({ length: 24 }, () => (context) => {
    observedContexts.push({
      messages: structuredClone(context.messages),
      toolNames: context.tools?.map((tool) => tool.name) ?? [],
    });
    const submitActive = context.tools?.some((tool) => tool.name === "submit_memory") === true;
    const last = context.messages.at(-1);
    if (submitActive) {
      block += 1;
      return fauxAssistantMessage(
        fauxToolCall("submit_memory", { markdown: `# Memory ${block}\n\n- retained fact ${block}` }),
        { stopReason: "toolUse" },
      );
    }
    if (last?.role === "toolResult" && last.toolName === "submit_memory") {
      return fauxAssistantMessage(`memory ${block} committed`);
    }
    return fauxAssistantMessage("acknowledged");
  }));

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

  assert.equal(result.schema, "pi-square.context-memory/pi-session-cache-sequence/1");
  assert.equal(result.execution.driver, "AgentSession.prompt");
  assert.equal(result.execution.promptCount, 7);
  assert.ok(result.session.compactions >= 2, "the real Pi prompt loop should commit at least two Memory compactions");
  assert.ok(result.session.maximumMemoryBlocks >= 2, "the second compaction should carry multiple Memory blocks");
  assert.equal(result.integrity.ok, true, result.integrity.failures.join("\n"));
  assert.equal(result.requests.length, observedContexts.length, "one row should come from every real provider request");
  assert.equal(result.session.persistedAssistantResponses, result.requests.length, "Pi should persist every measured assistant response");
  assert.ok(result.requests.some((row) => row.toolNames.includes("submit_memory")), "Pi should execute the real submit_memory loop");
  assert.ok(result.requests.slice(1).some((row) => row.cacheRead > 0), "later Pi requests should report prefix-cache reads");
  for (const row of result.requests.filter((candidate) => candidate.promptTokens > 0)) {
    assert.equal(row.hitRate, row.cacheRead / row.promptTokens, "cache hit rate should use Pi's footer formula");
  }

  const projected = observedContexts.find((context) => context.messages.some((message) => {
    if (!Array.isArray(message.content) || message.content.length < 4) return false;
    return message.content.every((part) => part.type === "text")
      && message.content.map((part) => part.text).join("").includes("Context Memory v1");
  }));
  assert.ok(projected, "a real provider request should carry the multi-block Memory projection");

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
  for (const provider of [anthropic, openai]) {
    const blocksBySession = new Map();
    provider.setResponses(Array.from({ length: 80 }, () => (context, options) => {
      const sessionId = options?.sessionId ?? "missing";
      const submitActive = context.tools?.some((tool) => tool.name === "submit_memory") === true;
      if (submitActive) {
        const next = (blocksBySession.get(sessionId) ?? 0) + 1;
        blocksBySession.set(sessionId, next);
        return fauxAssistantMessage(
          fauxToolCall("submit_memory", { markdown: `# Matrix memory ${next}\n\n- retained matrix fact ${next}` }),
          { stopReason: "toolUse" },
        );
      }
      return fauxAssistantMessage("matrix acknowledged");
    }));
  }

  const matrix = await runRealPiCacheExperiment({
    runtime,
    generatedAt: "2026-09-09T00:00:00.000Z",
  });
  assert.equal(matrix.schema, "pi-square.context-memory/pi-session-cache-matrix/1");
  assert.equal(matrix.execution.modelLanes, 3);
  assert.equal(matrix.execution.laneConcurrency, "parallel");
  assert.deepEqual(matrix.comparison.map((row) => `${row.provider}/${row.model}`), [
    "ccr-claude/claude-sonnet-5",
    "cpa/glm-5.3",
    "cpa/gpt-5.6-luna",
  ]);
  assert.equal(matrix.integrity.ok, true, JSON.stringify(matrix.runs.map((run) => run.integrity.failures)));
} finally {
  rmSync(runtimeDir, { recursive: true, force: true });
}

console.log("context-memory real Pi session cache sequence: ok");
