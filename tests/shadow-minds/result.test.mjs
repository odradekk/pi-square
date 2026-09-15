import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import jiti from "jiti";

const packageRoot = resolve(import.meta.dirname, "..", "..");
const load = jiti(import.meta.url, { moduleCache: false });

const {
  SUBMIT_SHADOW_RESULT_TOOL,
  createSubmitShadowResultTool,
  summarizeShadowResult,
  canonicalPayloadJson,
  SHADOW_RESULT_SUMMARY_MAX_CHARS,
} = await load(join(packageRoot, "src", "shadow-minds", "result.ts"));
const { DEFAULT_OUTPUT_SCHEMA, validateShadowPayload } = await load(join(packageRoot, "src", "shadow-minds", "parser.ts"));

const fakeCtx = { cwd: "/repo" };

function makeTool(schema, accepted) {
  return createSubmitShadowResultTool({
    schema,
    onAccepted: (payload) => accepted.push(payload),
  });
}

async function execute(tool, payload) {
  return await tool.execute("call-1", { payload }, undefined, undefined, fakeCtx);
}

// ── fixed model-callable schema ────────────────────────────────────

{
  const tool = makeTool(DEFAULT_OUTPUT_SCHEMA, []);
  assert.equal(tool.name, SUBMIT_SHADOW_RESULT_TOOL);
  assert.equal(tool.name, "submit_shadow_result");
  const schema = tool.parameters;
  assert.equal(schema.type, "object", "the top level is a strict object");
  assert.deepEqual(Object.keys(schema.properties), ["payload"], "payload is the only property");
  assert.equal(schema.properties.payload.type, "string");
  assert.equal(schema.properties.payload.maxLength, 24_000, "the fixed tool schema bounds the encoded payload string");
  assert.deepEqual(schema.required, ["payload"], "payload is required");
  assert.equal(schema.additionalProperties, false, "no additional properties");
  assert.ok(!Array.isArray(schema.anyOf) && schema.anyOf === undefined, "no top-level unions");
}

// ── rejection paths stay recoverable ───────────────────────────────

{
  const accepted = [];
  const tool = makeTool(DEFAULT_OUTPUT_SCHEMA, accepted);
  const invalidJson = await execute(tool, "{not json");
  assert.equal(invalidJson.isError, true, "non-JSON payload is a tool error, not a crash");
  assert.ok(invalidJson.content[0].text.toLowerCase().includes("json"), "the error names the JSON problem");
  assert.equal(invalidJson.terminate, undefined);
  assert.equal(accepted.length, 0);
}

{
  const accepted = [];
  const schema = {
    type: "object",
    properties: { summary: { type: "string" }, count: { type: "integer" } },
    required: ["summary", "count"],
    additionalProperties: false,
  };
  const tool = makeTool(schema, accepted);
  const wrongFields = await execute(tool, JSON.stringify({ summary: 42, count: "many" }));
  assert.equal(wrongFields.isError, true);
  const text = wrongFields.content[0].text;
  assert.ok(text.includes("summary"), "field-level error names summary");
  assert.ok(text.includes("count"), "field-level error names count");
  assert.ok(text.toLowerCase().includes("submit again"), "the error asks for a retry");
  assert.equal(wrongFields.terminate, undefined);
  assert.equal(accepted.length, 0);

  // A corrected retry within the same run is accepted.
  const corrected = await execute(tool, JSON.stringify({ summary: "Fixed.", count: 3 }));
  assert.notEqual(corrected.isError, true);
  assert.deepEqual(accepted, [{ summary: "Fixed.", count: 3 }]);
}

{
  const accepted = [];
  const tool = makeTool(DEFAULT_OUTPUT_SCHEMA, accepted);
  const oversized = await execute(tool, JSON.stringify({ summary: "x".repeat(25_000) }));
  assert.equal(oversized.isError, true, "the encoded payload bound is enforced through the shared validator");
  assert.ok(oversized.content[0].text.includes("24,000"), "the bound is stated in the error");
  assert.equal(accepted.length, 0);
}

// ── valid submission terminates ────────────────────────────────────

{
  const accepted = [];
  const tool = makeTool(DEFAULT_OUTPUT_SCHEMA, accepted);
  const result = await execute(tool, JSON.stringify({ summary: "One clear finding." }));
  assert.notEqual(result.isError, true);
  assert.equal(result.terminate, true, "a valid submission terminates the run at the batch boundary");
  assert.ok(result.content[0].text.includes("accepted"), "the model sees acceptance");
  assert.deepEqual(accepted, [{ summary: "One clear finding." }]);
}


{
  const accepted = [];
  const tool = makeTool(DEFAULT_OUTPUT_SCHEMA, accepted);
  const first = await execute(tool, JSON.stringify({ summary: "first" }));
  const second = await execute(tool, JSON.stringify({ summary: "second" }));
  assert.equal(first.terminate, true);
  assert.equal(second.isError, true);
  assert.equal(second.details.status, "already_accepted");
  assert.equal(second.terminate, true);
  assert.deepEqual(accepted, [{ summary: "first" }], "only the first valid submission is accepted");
}

// ── deterministic summaries ────────────────────────────────────────

{
  assert.ok(summarizeShadowResult({ summary: "Short finding." }).startsWith("Short finding."));
  const byTitle = summarizeShadowResult({ summary: 3, title: "Title wins when summary is not a string" });
  assert.ok(byTitle.startsWith("Title wins"), "a non-string summary falls through to title");
  const byMessage = summarizeShadowResult({ message: "Message third." });
  assert.ok(byMessage.startsWith("Message third."));
  const fallback = summarizeShadowResult({ nested: { deep: true }, values: [1, 2] });
  assert.ok(fallback.startsWith("{"), "otherwise canonical JSON is used");
  assert.ok(summarizeShadowResult({ summary: "y".repeat(400) }).length <= SHADOW_RESULT_SUMMARY_MAX_CHARS);
  assert.equal(SHADOW_RESULT_SUMMARY_MAX_CHARS, 300);
}


{
  const left = { z: 1, nested: { b: 2, a: 1 } };
  const right = { nested: { a: 1, b: 2 }, z: 1 };
  assert.equal(canonicalPayloadJson(left), canonicalPayloadJson(right));
  assert.equal(summarizeShadowResult(left), summarizeShadowResult(right), "fallback summaries are canonical across key order");
}


console.log("shadow-minds result tests: OK");