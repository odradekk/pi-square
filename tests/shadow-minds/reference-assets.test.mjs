import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import jiti from "jiti";

const packageRoot = resolve(import.meta.dirname, "..", "..");
const load = jiti(import.meta.url, { moduleCache: false });
const {
  DEFAULT_OUTPUT_SCHEMA,
  SHADOW_BODY_MAX_CHARS,
  SHADOW_DEFAULT_TOOLS,
  SHADOW_DELIVERIES,
  SHADOW_FILE_MAX_BYTES,
  SHADOW_ID_MAX_CHARS,
  SHADOW_ID_PATTERN,
  SHADOW_MODEL_REFERENCE,
  SHADOW_NAME_MAX_CHARS,
  SHADOW_PAYLOAD_MAX_CHARS,
  SHADOW_PAYLOAD_VALIDATION_ERRORS_MAX,
  SHADOW_PRIORITY_MAX,
  SHADOW_PRIORITY_MIN,
  SHADOW_SCHEMA_MAX_DEPTH,
  SHADOW_SCHEMA_MAX_ITEMS,
  SHADOW_SCHEMA_MAX_PROPERTIES_PER_OBJECT,
  SHADOW_SCHEMA_MAX_TOTAL_PROPERTIES,
  SHADOW_SCHEMA_STRING_MAX_LENGTH,
  SHADOW_THINKING_LEVELS,
  SHADOW_TOOL_PATTERN,
  SHADOW_TOOLS_MAX,
  SHADOW_TRIGGER_INSTRUCTION_MAX_CHARS,
  SHADOW_TRIGGERS,
  SHADOW_TRIGGERS_MAX,
  SHADOW_PARENT_MODELS_MAX,
  parseShadowDefinitionFile,
} = await load(join(packageRoot, "src", "shadow-minds", "parser.ts"));
const {
  SHADOW_MINDS_MODEL_TURNS_HARD_MAX,
  SHADOW_MINDS_RUN_TIMEOUT_HARD_MAX_SECONDS,
  SHADOW_MINDS_TOOL_CALLS_HARD_MAX,
} = await load(join(packageRoot, "src", "core", "config.ts"));
const { discoverShadowDefinitions } = await load(join(packageRoot, "src", "shadow-minds", "definitions.ts"));
const { serializeShadowDefinition } = await load(join(packageRoot, "src", "shadow-minds", "serialize.ts"));
const { buildShadowConfigGuide } = await load(join(packageRoot, "src", "shadow-minds", "config-guide.ts"));

const assetsDir = join(packageRoot, "shadow-minds");

// ── The package ships exactly the two reference assets ───────────────

{
  const entries = readdirSync(assetsDir).sort();
  assert.deepEqual(entries, ["example.md", "schema-reference.md"], "the packaged shadow-minds directory holds exactly the two reference assets");
}

// ── The example is one complete valid definition ─────────────────────

{
  const content = readFileSync(join(assetsDir, "example.md"), "utf8");
  const result = parseShadowDefinitionFile("example.md", content);
  assert.deepEqual(result.errors, [], "the annotated example parses without errors");
  const fields = result.definition.fields;
  assert.equal(fields.id, "example");
  assert.equal(fields.name, "Annotated example");
  assert.equal(fields.enabled, false, "the example stays disabled");
  assert.deepEqual(fields.triggers, ["completion", "failure"]);
  assert.deepEqual(fields.tools, ["read", "grep", "ls"]);
  assert.deepEqual(fields.requiredTools, ["read"]);
  assert.equal(fields.outputSchema.properties.verdict.enum.join(","), "sound,gap,wrong");
  assert.ok(fields.body.length > 0 && fields.body.length <= SHADOW_BODY_MAX_CHARS);

  // Serializer round-trip: the example stays canonically rewritable.
  const serialized = serializeShadowDefinition(fields);
  const reparsed = parseShadowDefinitionFile("example.md", serialized);
  assert.deepEqual(reparsed.errors, []);
  assert.deepEqual(reparsed.definition.fields, fields, "serialize → parse round-trips the example exactly");
}

// ── The schema reference's structured contract matches production ────

function extractBlocks(markdown, info) {
  const pattern = new RegExp("```" + info + "\\s*\\n([\\s\\S]*?)\\n```", "g");
  const blocks = [];
  for (const match of markdown.matchAll(pattern)) blocks.push(match[1]);
  return blocks;
}

{
  const markdown = readFileSync(join(assetsDir, "schema-reference.md"), "utf8");
  const contracts = extractBlocks(markdown, "json shadow-contract");
  assert.equal(contracts.length, 1, "exactly one structured contract block exists");
  const contract = JSON.parse(contracts[0]);
  assert.equal(contract.promptVersion, 1);
  assert.equal(contract.file.maxBytes, SHADOW_FILE_MAX_BYTES);
  assert.equal(contract.file.commentPolicy, "whole-line-only");

  const fields = contract.fields;
  assert.deepEqual(
    Object.keys(fields).sort(),
    [
      "body", "completionGate", "debug", "delivery", "enabled", "hidden", "id", "maxToolCalls",
      "maxTurns", "model", "name", "outputSchema", "parentModels", "priority", "requiredTools",
      "thinking", "timeoutSeconds", "tools", "triggerInstructions", "triggers",
    ].sort(),
    "the normative contract covers every production definition field",
  );
  assert.equal(fields.id.required, true);
  assert.equal(fields.id.maxLength, SHADOW_ID_MAX_CHARS);
  assert.equal(fields.id.pattern, SHADOW_ID_PATTERN.source);
  assert.equal(fields.id.equalsFilenameStem, true);
  assert.equal(fields.name.maxLength, SHADOW_NAME_MAX_CHARS);
  assert.equal(fields.name.effectiveRequired, true);
  assert.equal(fields.enabled.default, false);
  assert.equal(fields.hidden.default, false);
  assert.equal(fields.priority.min, SHADOW_PRIORITY_MIN);
  assert.equal(fields.priority.max, SHADOW_PRIORITY_MAX);
  assert.equal(fields.priority.default, 0);
  assert.deepEqual(fields.triggers.enum, [...SHADOW_TRIGGERS]);
  assert.equal(fields.triggers.maxEntries, SHADOW_TRIGGERS_MAX);
  assert.equal(fields.triggers.unique, true);
  assert.deepEqual(fields.triggers.default, []);
  assert.equal(fields.triggerInstructions.keysFromTriggers, true);
  assert.equal(fields.triggerInstructions.valueMaxLength, SHADOW_TRIGGER_INSTRUCTION_MAX_CHARS);
  assert.equal(fields.triggerInstructions.nullClearsKey, true);
  assert.equal(fields.triggerInstructions.merge, "per-key across layers");
  assert.deepEqual(fields.delivery.enum, [...SHADOW_DELIVERIES]);
  assert.equal(fields.delivery.default, "steer");
  assert.equal(fields.completionGate.default, false);
  assert.equal(fields.completionGate.requiresCompletionTrigger, true);
  assert.equal(fields.parentModels.maxEntries, SHADOW_PARENT_MODELS_MAX);
  assert.equal(fields.parentModels.unique, true);
  assert.equal(fields.parentModels.entryPattern, "exact provider/model-id or *");
  assert.equal(fields.model.pattern, SHADOW_MODEL_REFERENCE.source);
  assert.deepEqual(fields.thinking.enum, [...SHADOW_THINKING_LEVELS]);
  assert.deepEqual(fields.timeoutSeconds, { min: 1, max: SHADOW_MINDS_RUN_TIMEOUT_HARD_MAX_SECONDS });
  assert.deepEqual(fields.maxTurns, { min: 1, max: SHADOW_MINDS_MODEL_TURNS_HARD_MAX });
  assert.deepEqual(fields.maxToolCalls, { min: 1, max: SHADOW_MINDS_TOOL_CALLS_HARD_MAX });
  assert.equal(fields.tools.maxEntries, SHADOW_TOOLS_MAX);
  assert.equal(fields.tools.unique, true);
  assert.equal(fields.tools.entryPattern, SHADOW_TOOL_PATTERN.source);
  assert.deepEqual(fields.tools.default, [...SHADOW_DEFAULT_TOOLS]);
  assert.equal(fields.tools.emptyListMeans, "no tools");
  assert.equal(fields.tools.catalogIsFixed, true);
  assert.equal(fields.requiredTools.maxEntries, SHADOW_TOOLS_MAX);
  assert.equal(fields.requiredTools.unique, true);
  assert.equal(fields.requiredTools.entryPattern, SHADOW_TOOL_PATTERN.source);
  assert.equal(fields.requiredTools.subsetOfFinalTools, true);
  assert.equal(fields.debug.default, false);
  assert.equal(fields.outputSchema.maxDepth, SHADOW_SCHEMA_MAX_DEPTH);
  assert.equal(fields.outputSchema.maxTotalProperties, SHADOW_SCHEMA_MAX_TOTAL_PROPERTIES);
  assert.equal(fields.outputSchema.maxPropertiesPerObject, SHADOW_SCHEMA_MAX_PROPERTIES_PER_OBJECT);
  assert.equal(fields.outputSchema.maxItems, SHADOW_SCHEMA_MAX_ITEMS);
  assert.equal(fields.outputSchema.stringMaxLength, SHADOW_SCHEMA_STRING_MAX_LENGTH);
  assert.equal(fields.outputSchema.atomicReplace, true);
  assert.equal(fields.outputSchema.nullRestoresDefault, true);
  assert.equal(fields.outputSchema.rootMustBeObject, true);
  assert.equal(fields.outputSchema.additionalPropertiesFalseRequired, true);
  assert.deepEqual(fields.outputSchema.default, DEFAULT_OUTPUT_SCHEMA);
  assert.equal(fields.body.maxChars, SHADOW_BODY_MAX_CHARS);
  assert.equal(fields.body.omittedOrEmptyInherits, true);
  assert.equal(fields.body.nonEmptyReplaces, true);
  assert.equal(fields.body.effectiveRequired, true);
  assert.equal(contract.payload.maxEncodedChars, SHADOW_PAYLOAD_MAX_CHARS);
  assert.equal(contract.payload.maxFieldErrors, SHADOW_PAYLOAD_VALIDATION_ERRORS_MAX);
}

// ── Embedded examples run through the production pipeline ────────────

{
  const markdown = readFileSync(join(assetsDir, "schema-reference.md"), "utf8");
  const valid = extractBlocks(markdown, "yaml shadow-valid");
  const invalid = extractBlocks(markdown, "yaml shadow-invalid");
  assert.ok(valid.length >= 2, "at least two valid embedded examples exist");
  assert.ok(invalid.length >= 3, "at least three invalid embedded examples exist");

  const idOf = (block) => {
    const match = /^id: (\S+)$/m.exec(block);
    assert.ok(match, "every embedded example declares an id");
    return match[1];
  };

  const dir = mkdtempSync(join(tmpdir(), "pi-square-shadow-ref-"));
  const previousAgentDir = process.env.PI_AGENT_DIR;
  const previousCodingAgentDir = process.env.PI_CODING_AGENT_DIR;
  const agent = join(dir, "agent");
  const project = join(dir, "project");
  try {
    process.env.PI_AGENT_DIR = agent;
    process.env.PI_CODING_AGENT_DIR = agent;
    mkdirSync(join(agent, "shadow-minds"), { recursive: true });
    mkdirSync(project, { recursive: true });

    for (const block of valid) {
      writeFileSync(join(agent, "shadow-minds", `${idOf(block)}.md`), `${block}\n`, "utf8");
    }
    for (const block of invalid) {
      writeFileSync(join(agent, "shadow-minds", `${idOf(block)}.md`), `${block}\n`, "utf8");
    }
    const registry = discoverShadowDefinitions(project);
    const active = new Set(registry.definitions.map((definition) => definition.id));
    const excluded = new Set(registry.invalid.map((entry) => entry.id));
    for (const block of valid) {
      const id = idOf(block);
      assert.ok(active.has(id), `embedded example '${id}' is effective through production discovery`);
      assert.ok(!excluded.has(id), `embedded example '${id}' is not excluded`);
    }
    for (const block of invalid) {
      const id = idOf(block);
      assert.ok(excluded.has(id), `embedded example '${id}' fails closed through production discovery`);
      assert.ok(!active.has(id), `embedded example '${id}' never activates`);
    }

    // Reference assets never surface as definitions even with a live agent
    // base: discovery reads only the two user-owned scopes.
    assert.ok(!active.has("example"), "the packaged example is never discovered");
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = previousAgentDir;
    if (previousCodingAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousCodingAgentDir;
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── The Config Guide points at the reference assets ──────────────────

{
  const registry = { definitions: [], invalid: [], diagnostics: [] };
  const guide = buildShadowConfigGuide(registry, "/repo");
  assert.ok(guide.content.includes(join("shadow-minds", "example.md")), "the guide names the packaged example path");
  assert.ok(guide.content.includes(join("shadow-minds", "schema-reference.md")), "the guide names the packaged schema-reference path");
}

console.log("shadow-minds reference-asset tests: OK");
