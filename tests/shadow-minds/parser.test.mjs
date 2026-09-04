import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import jiti from "jiti";

const load = jiti(import.meta.url, { moduleCache: false });
const {
  DEFAULT_OUTPUT_SCHEMA,
  parseShadowDefinitionFile,
  validateOutputSchema,
  validateShadowPayload,
} = await load(join(import.meta.dirname, "..", "..", "src", "shadow-minds", "parser.ts"));

const body = "Ground every answer in local evidence.";

function file(frontmatter, fileBody = body) {
  return `---\n${frontmatter}\n---\n${fileBody}`;
}

function parseOk(content, source = "probe.md") {
  const result = parseShadowDefinitionFile(source, content);
  assert.deepEqual(result.errors, [], `expected a valid definition, got ${JSON.stringify(result.errors)}`);
  assert.ok(result.definition, "expected a definition");
  return result.definition;
}

function parseErr(content, pattern, source = "probe.md") {
  const result = parseShadowDefinitionFile(source, content);
  assert.ok(!result.definition, `expected rejection for ${JSON.stringify(content.slice(0, 80))}`);
  assert.ok(
    result.errors.some((error) => pattern.test(error)),
    `expected an error matching ${pattern}, got ${JSON.stringify(result.errors)}`,
  );
}

// ── Full valid definition ────────────────────────────────────────────

const full = parseOk(file([
  "promptVersion: 1",
  "id: probe",
  "name: Probe",
  "enabled: false",
  "hidden: false",
  "priority: 3",
  "triggers: [tool_turn, completion]",
  "triggerInstructions:",
  "  tool_turn: 'Inspect the newest tool work.'",
  "  failure: null",
  "delivery: steer",
  "completionGate: false",
  'parentModels: ["cpa/gpt-5.6-sol", "*"]',
  "model: cpa/kimi-k3-256k",
  "thinking: high",
  "timeoutSeconds: 90",
  "maxTurns: 4",
  "maxToolCalls: 8",
  "tools: [read, grep, pdf_search]",
  "requiredTools: [read]",
  "debug: false",
].join("\n")));
assert.equal(full.fields.id, "probe");
assert.equal(full.fields.name, "Probe");
assert.equal(full.fields.enabled, false);
assert.equal(full.fields.hidden, false);
assert.equal(full.fields.priority, 3);
assert.deepEqual(full.fields.triggers, ["tool_turn", "completion"]);
assert.deepEqual(full.fields.triggerInstructions, {
  tool_turn: "Inspect the newest tool work.",
  failure: null,
});
assert.equal(full.fields.delivery, "steer");
assert.equal(full.fields.completionGate, false);
assert.deepEqual(full.fields.parentModels, ["cpa/gpt-5.6-sol", "*"]);
assert.equal(full.fields.model, "cpa/kimi-k3-256k");
assert.equal(full.fields.thinking, "high");
assert.equal(full.fields.timeoutSeconds, 90);
assert.equal(full.fields.maxTurns, 4);
assert.equal(full.fields.maxToolCalls, 8);
assert.deepEqual(full.fields.tools, ["read", "grep", "pdf_search"]);
assert.deepEqual(full.fields.requiredTools, ["read"]);
assert.equal(full.fields.debug, false);
assert.equal(full.fields.body, body);
assert.equal(full.contentHash, createHash("sha256").update(file([
  "promptVersion: 1",
  "id: probe",
  "name: Probe",
  "enabled: false",
  "hidden: false",
  "priority: 3",
  "triggers: [tool_turn, completion]",
  "triggerInstructions:",
  "  tool_turn: 'Inspect the newest tool work.'",
  "  failure: null",
  "delivery: steer",
  "completionGate: false",
  'parentModels: ["cpa/gpt-5.6-sol", "*"]',
  "model: cpa/kimi-k3-256k",
  "thinking: high",
  "timeoutSeconds: 90",
  "maxTurns: 4",
  "maxToolCalls: 8",
  "tools: [read, grep, pdf_search]",
  "requiredTools: [read]",
  "debug: false",
].join("\n"))).digest("hex"), "content hash is the sha256 of the raw file bytes");

// ── Delimiters and structure ─────────────────────────────────────────

parseErr("promptVersion: 1\n", /frontmatter/i);
parseErr("---\npromptVersion: 1\nid: probe\nname: Probe\n", /closing/i);
parseErr("  ---\npromptVersion: 1\n---\nbody", /frontmatter/i);
parseOk("---\npromptVersion: 1\nid: probe\nname: Probe\n---\n");
// Full-line frontmatter comments are skipped (#188); '#' after a value
// remains a scalar-content rejection (covered again in the comment block).
parseOk(file("# a comment\npromptVersion: 1\nid: probe\nname: Probe\n", ""), "probe.md");
parseErr(file("promptVersion: 1\nid: probe\nname: Probe # trailing\n", ""), /comment/i);
parseErr(file("promptVersion: 1\nid: probe\nname: Probe\nkey: |\n  block\n", ""), /block scalar/i);

// ── Version, unknown fields, YAML-subset rejection ───────────────────

parseErr(file("promptVersion: 2\nid: probe\nname: Probe\n", ""), /promptVersion/i);
parseErr(file("id: probe\nname: Probe\n", ""), /promptVersion/i);
parseErr(file("promptVersion: 1\nid: probe\nname: Probe\ncolor: red\n", ""), /color/i);
parseErr(file("promptVersion: 1\nid: &anchor probe\nname: Probe\n", ""), /anchor/i);
parseErr(file("promptVersion: 1\nid: *alias\nname: Probe\n", ""), /alias/i);
parseErr(file("promptVersion: 1\nid: !!str probe\nname: Probe\n", ""), /tag/i);
parseErr(file("promptVersion: 1\nid: probe\nname: Probe\n<<: {a: 1}\n", ""), /merge/i);
parseErr(file("promptVersion: 1\nid: probe\n\tname: Probe\n", ""), /tab/i);
parseErr(file("promptVersion: 1\nid: probe\nid: probe2\nname: Probe\n", ""), /duplicate/i);
parseErr(file("promptVersion: 1\n? complex\n: value\nid: probe\nname: Probe\n", ""), /complex/i);
parseErr(file("promptVersion: 1\nid: probe\nname: Probe\ntools: [read,]\n", ""), /empty items/i);
parseErr(file("promptVersion: 1\nid: probe\nname: Probe\ntools: ['read]\n", ""), /unterminated/i);
parseErr(file("promptVersion: 1\nid: probe\nname: Probe\n__proto__: polluted\n", ""), /__proto__/i);
// ── Identity and field bounds ────────────────────────────────────────

parseErr(file("promptVersion: 1\nid: other\nname: Probe\n", ""), /probe\.md/i);
parseErr(file(`promptVersion: 1\nid: ${"a".repeat(65)}\nname: Probe\n`, ""), /id/i, `${"a".repeat(65)}.md`);
parseErr(file(`promptVersion: 1\nid: probe\nname: ${"n".repeat(121)}\n`, ""), /name/i);
parseErr(file("promptVersion: 1\nid: probe\nname: Probe\nenabled: yes\n", ""), /enabled/i);
parseErr(file("promptVersion: 1\nid: probe\nname: Probe\npriority: 1001\n", ""), /priority/i);

// ── Triggers, instructions, delivery ─────────────────────────────────

parseErr(file("promptVersion: 1\nid: probe\nname: Probe\ntriggers: [tool_turn, tool_turn]\n", ""), /duplicate trigger/i);
parseErr(file("promptVersion: 1\nid: probe\nname: Probe\ntriggers: [tool_turn, heartbeat]\n", ""), /heartbeat/i);
parseErr(file("promptVersion: 1\nid: probe\nname: Probe\ntriggers: []\n", "").replace("triggers: []", "triggers: [tool_turn, failure, mutation, completion, tool_turn]"), /trigger/i);
const triggerNull = parseOk(file("promptVersion: 1\nid: probe\nname: Probe\ntriggerInstructions:\n  failure: null\n"));
assert.deepEqual(triggerNull.fields.triggerInstructions, { failure: null });
parseErr(file("promptVersion: 1\nid: probe\nname: Probe\ntriggerInstructions:\n  heartbeat: x\n", ""), /heartbeat/i);
parseErr(file(`promptVersion: 1\nid: probe\nname: Probe\ntriggerInstructions:\n  failure: '${"x".repeat(8001)}'\n`, ""), /8,?001/);
parseErr(file("promptVersion: 1\nid: probe\nname: Probe\ndelivery: shout\n", ""), /delivery/i);

// ── Model filters and runtime bounds ─────────────────────────────────

parseErr(file("promptVersion: 1\nid: probe\nname: Probe\nparentModels: [\"**\"]\n", ""), /parentModels/i);
{
  const many = Array.from({ length: 33 }, (_, i) => `"cpa/model-${i}"`).join(", ");
  parseErr(file(`promptVersion: 1\nid: probe\nname: Probe\nparentModels: [${many}]\n`, ""), /parentModels/i);
}
parseErr(file('promptVersion: 1\nid: probe\nname: Probe\nparentModels: ["cpa/a", "cpa/a"]\n', ""), /duplicate/i);
parseErr(file("promptVersion: 1\nid: probe\nname: Probe\nmodel: not-a-model-reference\n", ""), /model/i);
parseErr(file("promptVersion: 1\nid: probe\nname: Probe\nthinking: ultra\n", ""), /thinking/i);
// Pi 0.84.2 adds the "max" level; definitions may request it.
{
  const definition = parseOk(file("promptVersion: 1\nid: probe\nname: Probe\nthinking: max\n", ""));
  assert.equal(definition.fields.thinking, "max");
}
parseErr(file("promptVersion: 1\nid: probe\nname: Probe\ntimeoutSeconds: 601\n", ""), /timeoutSeconds/i);
parseErr(file("promptVersion: 1\nid: probe\nname: Probe\ntimeoutSeconds: 0\n", ""), /timeoutSeconds/i);
parseErr(file("promptVersion: 1\nid: probe\nname: Probe\nmaxTurns: 33\n", ""), /maxTurns/i);
parseErr(file("promptVersion: 1\nid: probe\nname: Probe\nmaxToolCalls: 129\n", ""), /maxToolCalls/i);

// ── Tool lists ───────────────────────────────────────────────────────

{
  const many = Array.from({ length: 17 }, (_, i) => `tool${i}`).join(", ");
  parseErr(file(`promptVersion: 1\nid: probe\nname: Probe\ntools: [${many}]\n`, ""), /tools/i);
}
parseErr(file("promptVersion: 1\nid: probe\nname: Probe\ntools: [read, read]\n", ""), /duplicate/i);
parseErr(file("promptVersion: 1\nid: probe\nname: Probe\ntools: [Read]\n", ""), /tools/i);
parseErr(file("promptVersion: 1\nid: probe\nname: Probe\nrequiredTools: [read, read]\n", ""), /duplicate/i);

// ── Body and file bounds ─────────────────────────────────────────────

parseErr(file("promptVersion: 1\nid: probe\nname: Probe\n", "x".repeat(24_001)), /24,?001/);
parseOk(file("promptVersion: 1\nid: probe\nname: Probe\n", "x".repeat(24_000)));
{
  const huge = `---\npromptVersion: 1\nid: probe\nname: Probe\n---\n${"y".repeat(70_000)}`;
  const oversized = parseShadowDefinitionFile("probe.md", huge);
  assert.ok(!oversized.definition && oversized.errors.some((e) => /64 KiB/i.test(e)), "oversized files are rejected before parsing");
}

// ── Output schema subset ─────────────────────────────────────────────

const validSchema = [
  "outputSchema:",
  "  type: object",
  "  additionalProperties: false",
  "  properties:",
  "    summary:",
  "      type: string",
  "      minLength: 1",
  "      maxLength: 300",
  "    findings:",
  "      type: array",
  "      maxItems: 8",
  "      items:",
  "        type: object",
  "        additionalProperties: false",
  "        properties:",
  "          file:",
  "            type: string",
  "          severity:",
  "            type: string",
  "            enum: [info, warning]",
  "        required: [file, severity]",
  "  required: [summary]",
].join("\n");
{
  const withSchema = parseOk(file(`promptVersion: 1\nid: probe\nname: Probe\n${validSchema}\n`));
  assert.equal(withSchema.fields.outputSchema.type, "object");
  assert.equal(withSchema.fields.outputSchema.additionalProperties, false);
  assert.deepEqual(withSchema.fields.outputSchema.properties.findings.items.properties.severity.enum, ["info", "warning"]);
}
parseErr(file("promptVersion: 1\nid: probe\nname: Probe\noutputSchema:\n  type: object\n  $ref: '#/x'\n", ""), /\$ref/i);
parseErr(file("promptVersion: 1\nid: probe\nname: Probe\noutputSchema:\n  type: object\n  allOf: []\n", ""), /allOf/i);
parseErr(file("promptVersion: 1\nid: probe\nname: Probe\noutputSchema:\n  type: object\n  patternProperties: {}\n", ""), /patternProperties/i);
parseErr(file("promptVersion: 1\nid: probe\nname: Probe\noutputSchema:\n  type: object\n  minProperties: 1\n", ""), /minProperties/i);
parseErr(file("promptVersion: 1\nid: probe\nname: Probe\noutputSchema:\n  type: object\n  properties:\n    a:\n      type: string\n", ""), /additionalProperties/i);
parseErr(file("promptVersion: 1\nid: probe\nname: Probe\noutputSchema:\n  type: array\n", ""), /object/i);
{
  const cleared = parseOk(file("promptVersion: 1\nid: probe\nname: Probe\noutputSchema: null\n"));
  assert.equal(cleared.fields.outputSchema, null, "explicit null restores the default schema marker");
}
{
  // Exactly six schema nodes on one path (root plus four nested objects plus
  // a scalar leaf) stay valid; a seventh is rejected below.
  const sixLevelLines = ["outputSchema:", "  type: object", "  additionalProperties: false", "  properties:", "    a0:", "      type: object", "      additionalProperties: false", "      properties:"];
  for (let i = 1; i <= 3; i += 1) {
    sixLevelLines.push(`${" ".repeat(4 + 4 * i)}a${i}:`, `${" ".repeat(6 + 4 * i)}type: object`, `${" ".repeat(6 + 4 * i)}additionalProperties: false`, `${" ".repeat(6 + 4 * i)}properties:`);
  }
  sixLevelLines.push(`${" ".repeat(20)}leaf:`, `${" ".repeat(22)}type: string`);
  parseOk(file(`promptVersion: 1\nid: probe\nname: Probe\n${sixLevelLines.join("\n")}\n`, ""));
  const depthLines = ["outputSchema:", "  type: object", "  additionalProperties: false", "  properties:", "    a0:", "      type: object", "      additionalProperties: false", "      properties:"];
  for (let i = 1; i <= 5; i += 1) {
    depthLines.push(`${" ".repeat(4 + 4 * i)}a${i}:`, `${" ".repeat(6 + 4 * i)}type: object`, `${" ".repeat(6 + 4 * i)}additionalProperties: false`, `${" ".repeat(6 + 4 * i)}properties:`);
  }
  depthLines.push(`${" ".repeat(28)}leaf:`, `${" ".repeat(30)}type: string`);
  parseErr(file(`promptVersion: 1\nid: probe\nname: Probe\n${depthLines.join("\n")}\n`, ""), /depth/i);
}
{
  const props = Array.from({ length: 33 }, (_, i) => `    p${i}:\n      type: string`).join("\n");
  parseErr(file(`promptVersion: 1\nid: probe\nname: Probe\noutputSchema:\n  type: object\n  additionalProperties: false\n  properties:\n${props}\n`, ""), /32 properties/i);
}
parseErr(file("promptVersion: 1\nid: probe\nname: Probe\noutputSchema:\n  type: object\n  additionalProperties: false\n  properties:\n    a:\n      type: string\n      maxLength: 12001\n", ""), /maxLength/i);
parseErr(file("promptVersion: 1\nid: probe\nname: Probe\noutputSchema:\n  type: object\n  additionalProperties: false\n  properties:\n    a:\n      type: array\n      maxItems: 65\n", ""), /maxItems/i);
parseErr(file("promptVersion: 1\nid: probe\nname: Probe\noutputSchema:\n  type: object\n  additionalProperties: false\n  properties:\n    a:\n      type: string\n  required: [b]\n", ""), /required/i);
parseErr(file("promptVersion: 1\nid: probe\nname: Probe\noutputSchema:\n  type: object\n  additionalProperties: false\n  properties:\n    a:\n      type: number\n      enum: [wrong]\n", ""), /enum.*number|match type/i);
parseErr(file("promptVersion: 1\nid: probe\nname: Probe\noutputSchema:\n  type: object\n  additionalProperties: false\n  enum: [x]\n", ""), /enum.*scalar/i);
parseErr(file("promptVersion: 1\nid: probe\nname: Probe\noutputSchema:\n  type: object\n  additionalProperties: false\n  properties:\n    a:\n      type: string\n  required: [a, a]\n", ""), /required.*unique/i);
parseErr(file("promptVersion: 1\nid: probe\nname: Probe\noutputSchema:\n  type: object\n  additionalProperties: false\n  properties:\n    a:\n      type: string\n      minimum: 1\n", ""), /minimum.*number|keyword.*string|string.*minimum/i);
parseErr(file("promptVersion: 1\nid: probe\nname: Probe\noutputSchema:\n  type: object\n  additionalProperties: false\n  properties:\n    a:\n      type: number\n      maxLength: 5\n", ""), /maxLength.*string|keyword.*number|number.*maxLength/i);
parseErr(file("promptVersion: 1\nid: probe\nname: Probe\noutputSchema:\n  type: object\n  additionalProperties: false\n  properties:\n    a:\n      type: array\n      minimum: 1\n", ""), /minimum.*number|keyword.*array|array.*minimum/i);

// ── Schema and payload validation as standalone functions ────────────

assert.deepEqual(validateOutputSchema(DEFAULT_OUTPUT_SCHEMA), []);
assert.ok(validateOutputSchema({ type: "array" }).some((error) => /root/i.test(error)));

{
  const errors = validateShadowPayload(DEFAULT_OUTPUT_SCHEMA, {});
  assert.equal(errors.length, 1);
  assert.match(errors[0], /summary/);
}
assert.deepEqual(validateShadowPayload(DEFAULT_OUTPUT_SCHEMA, { summary: "ok" }), []);
assert.ok(validateShadowPayload(DEFAULT_OUTPUT_SCHEMA, { summary: "ok", extra: 1 }).length >= 1);
assert.ok(validateShadowPayload(DEFAULT_OUTPUT_SCHEMA, { summary: 5 }).length >= 1);
{
  const schema = { type: "object", additionalProperties: false, properties: { level: { type: "string", enum: ["low", "high"] } }, required: ["level"] };
  const errors = validateShadowPayload(schema, { level: "medium" });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /level/);
}
{
  const nested = {
    type: "object",
    additionalProperties: false,
    properties: { items: { type: "array", maxItems: 2, items: { type: "object", additionalProperties: false, properties: { file: { type: "string" } }, required: ["file"] } } },
    required: ["items"],
  };
  const errors = validateShadowPayload(nested, { items: [{ file: "a.ts" }, { nope: true }] });
  assert.equal(errors.length, 2, "one additional-property error and one missing-required error");
  assert.ok(errors.every((error) => error.startsWith("items[1]")));
}
{
  const bounded = { type: "object", additionalProperties: false, properties: { text: { type: "string", maxLength: 5 } }, required: ["text"] };
  assert.ok(validateShadowPayload(bounded, { text: "toolong" }).length === 1);
}
{
  const errors = validateShadowPayload(DEFAULT_OUTPUT_SCHEMA, { summary: "x".repeat(25_000) });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /24,?000/);
}
{
  const schema = { type: "object", additionalProperties: false, properties: { text: { type: "string" } }, required: ["text"] };
  assert.ok(validateShadowPayload(schema, { text: "x".repeat(12_001) }).some((error) => /12,?000|maxLength/i), "strings stay under the absolute schema cap even when maxLength is omitted");
}
{
  const schema = { type: "object", additionalProperties: false, properties: { values: { type: "array", items: { type: "string" } } }, required: ["values"] };
  assert.ok(validateShadowPayload(schema, { values: Array.from({ length: 65 }, () => "x") }).some((error) => /64|maxItems/i), "arrays stay under the absolute schema cap even when maxItems is omitted");
}

// ── A body-less overlay preserves body inheritance (#177) ──────────

{
  // The minimal enable-only overlay a user saves above a package template
  // has no responsibility body: the parser must keep the body absent —
  // inheriting the lower layer — instead of reporting an explicit empty
  // body that the layer serializer would reject on the next edit.
  const bodyless = "---\npromptVersion: 1\nid: enable-probe\nenabled: true\n---\n";
  const parsed = parseOk(bodyless, "enable-probe.md");
  assert.equal(parsed.fields.body, undefined, "a body-less overlay parses with an absent body");
  const whitespaceOnly = parseOk(
    "---\npromptVersion: 1\nid: whitespace-probe\nenabled: true\n---\n \n   \n",
    "whitespace-probe.md",
  );
  assert.equal(
    whitespaceOnly.fields.body,
    undefined,
    "a whitespace-only overlay body also preserves inheritance",
  );

  const { serializeShadowDefinition } = await load(
    join(import.meta.dirname, "..", "..", "src", "shadow-minds", "serialize.ts"),
  );
  const serialized = serializeShadowDefinition(parsed.fields);
  assert.ok(
    /^---\n[\s\S]*\n---\n$/.test(serialized) && !serialized.slice(serialized.lastIndexOf("---\n") + 4).trim(),
    "serializing the parsed overlay stays body-less",
  );
  const reparsed = parseOk(serialized, "enable-probe.md");
  assert.equal(reparsed.fields.body, undefined, "parse → serialize → parse preserves body inheritance");
}

// ── Full-line frontmatter comments (#188) ────────────────────────────
{
  // Reference-asset annotation: a full-line comment is documentation for
  // authors, not a value. The strict subset skips whole comment lines at any
  // indentation and still rejects '#' inside scalars and after values.
  const annotated = [
    "---",
    "# One complete annotated definition; copy into your agent or project",
    "# scope and edit from there. The id must equal the file name stem.",
    "promptVersion: 1",
    "id: annotated-probe",
    "name: Annotated probe",
    "# enabled stays false until you explicitly turn this definition on",
    "enabled: false",
    "triggerInstructions:",
    "  # per-trigger guidance merges by key across layers; null removes one",
    "  completion: Review the settled answer before delivery.",
    "outputSchema:",
    "  type: object",
    "  # every object schema must close with additionalProperties: false",
    "  additionalProperties: false",
    "---",
    "Own the responsibility described here.",
    "",
  ].join("\n");
  const parsed = parseOk(annotated, "annotated-probe.md");
  assert.equal(parsed.fields.id, "annotated-probe");
  assert.equal(parsed.fields.enabled, false);
  assert.equal(parsed.fields.triggerInstructions.completion, "Review the settled answer before delivery.");
  assert.equal(parsed.fields.outputSchema.type, "object");
  assert.equal(parsed.fields.outputSchema.additionalProperties, false);

  parseErr(
    file("promptVersion: 1\nid: hash-probe\nname: hash # inline comment", ""),
    /comments are not supported/,
    "hash-probe.md",
  );
}

console.log("shadow-minds parser tests: OK");
