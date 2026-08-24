import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import jiti from "jiti";

const packageRoot = resolve(import.meta.dirname, "..", "..");
const load = jiti(import.meta.url, { moduleCache: false });
const {
  serializeShadowDefinition,
  newShadowDefinitionDraft,
} = await load(join(packageRoot, "src", "shadow-minds", "serialize.ts"));
const { parseShadowDefinitionFile } = await load(
  join(packageRoot, "src", "shadow-minds", "parser.ts"),
);

function roundTrip(fields) {
  const content = serializeShadowDefinition(fields);
  const source = `${fields.id}.md`;
  const parsed = parseShadowDefinitionFile(source, content);
  assert.deepEqual(parsed.errors, [], `serialized layer must reparse without errors:\n${parsed.errors.join("\n")}`);
  const { contentHash: _ignored, ...reparsed } = parsed.definition.fields;
  const { contentHash: _dropped, ...expected } = fields;
  assert.deepEqual(reparsed, expected, "serialized layer must round-trip field-for-field");
  return content;
}

// ── The default draft for a new definition ───────────────────────────

{
  const draft = newShadowDefinitionDraft("my-shadow", "My shadow", "Read the workspace and report.");
  assert.equal(draft.enabled, false, "new definitions default to disabled");
  assert.deepEqual(draft.triggers, [], "new definitions subscribe to no automatic trigger");
  assert.equal(draft.delivery, "steer");
  assert.equal(draft.debug, false);
  assert.equal(draft.outputSchema, undefined, "absent schema inherits the default summary schema");
  assert.equal(draft.model, undefined, "runtime defaults inherit");
  assert.equal(draft.priority, 0);
  const content = serializeShadowDefinition(draft);
  assert.match(content, /^---\npromptVersion: 1\nid: "my-shadow"\nname: "My shadow"\nenabled: false\nhidden: false\npriority: 0\ntriggers: \[\]\ndelivery: "steer"\ncompletionGate: false\ndebug: false\n---\n\nRead the workspace and report\.\n$/);
  roundTrip(draft);
}

// ── Every field serializes and round-trips ───────────────────────────

roundTrip({
  id: "full",
  name: "Full overlay",
  enabled: true,
  hidden: true,
  priority: -12,
  triggers: ["tool_turn", "completion"],
  triggerInstructions: { tool_turn: "Check grounding.", completion: "Summarize." },
  delivery: "notify",
  completionGate: true,
  parentModels: ["*", "anthropic/claude-sonnet-4-5"],
  model: "openai/gpt-5.2",
  thinking: "high",
  timeoutSeconds: 300,
  maxTurns: 12,
  maxToolCalls: 48,
  tools: ["read", "grep"],
  requiredTools: ["read"],
  debug: false,
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["summary"],
    properties: { summary: { type: "string", minLength: 1, maxLength: 12000 } },
  },
  body: "Responsibility text.\n\nSecond paragraph.",
});

// ── Clearing forms round-trip ────────────────────────────────────────

roundTrip({
  id: "clears",
  name: "Clears",
  triggers: [],
  triggerInstructions: { failure: null },
  tools: [],
  outputSchema: null,
  body: "Body.",
});

// ── Scalars that need quoting round-trip ─────────────────────────────

roundTrip({
  id: "quotes",
  name: 'Quotes: "and" \\ backslash',
  triggerInstructions: { mutation: "line one\nline two: with colon" },
  body: "Body with --- inside\nand\ttab.",
});

// ── The default schema is never written explicitly ───────────────────

{
  const content = serializeShadowDefinition({ id: "s", name: "S", body: "b" });
  assert.ok(!content.includes("outputSchema"), "an absent schema field stays absent");
  const parsed = parseShadowDefinitionFile("s.md", content);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.definition.fields.outputSchema, undefined);
}

// ── Canonical output is deterministic and field-ordered ──────────────

{
  const fields = { id: "order", name: "Order", tools: ["b", "a"], body: "x" };
  const first = serializeShadowDefinition(fields);
  const second = serializeShadowDefinition({ body: "x", tools: ["b", "a"], name: "Order", id: "order" });
  assert.equal(first, second, "serialization ignores key order of the input object");
  assert.ok(first.indexOf('id: "order"') < first.indexOf('name: "Order"'), "id precedes name");
  assert.ok(first.indexOf("tools:") < first.indexOf("---\n\nx"), "frontmatter precedes the body");
}

// ── Invalid inputs are rejected rather than silently mangled ─────────

{
  assert.throws(() => serializeShadowDefinition({ id: "has space", name: "x", body: "b" }), /id/);
  assert.throws(() => serializeShadowDefinition({ id: "ok", name: "x", body: "" }), /body/);
  assert.doesNotThrow(() => serializeShadowDefinition({ id: "ok", name: "x" }), "a body-less overlay layer serializes");
  assert.throws(() => serializeShadowDefinition({ id: "ok", name: "x".repeat(121), body: "b" }), /name/);
  assert.throws(
    () => serializeShadowDefinition({ id: "ok", name: "x", body: "b", triggers: ["nonsense"] }),
    /trigger/,
  );
}

// Schema property names stay inside the canonical YAML-safe key subset.
assert.throws(
  () => serializeShadowDefinition({
    id: "schema-key",
    name: "Schema key",
    body: "Body.",
    outputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { "not yaml safe": { type: "string" } },
    },
  }),
  /YAML-safe schema key subset/,
);

console.log("shadow-minds serializer tests: OK");
