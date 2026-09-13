import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import jiti from "jiti";

const packageRoot = resolve(import.meta.dirname, "..", "..");
const load = jiti(import.meta.url, { moduleCache: false });
const {
  SHADOW_BODY_MAX_CHARS,
  SHADOW_DEFINITION_FIELDS,
  parseShadowDefinitionFile,
} = await load(join(packageRoot, "src", "shadow-minds", "parser.ts"));
const { discoverShadowDefinitions } = await load(join(packageRoot, "src", "shadow-minds", "definitions.ts"));
const { serializeShadowDefinition } = await load(join(packageRoot, "src", "shadow-minds", "serialize.ts"));
const { buildShadowConfigGuide } = await load(join(packageRoot, "src", "shadow-minds", "config-guide.ts"));
const { buildShadowDefinitionContract } = await load(join(packageRoot, "src", "shadow-minds", "contract.ts"));

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

/** Every fenced block in the schema reference carrying the given info string. */
function extractBlocks(markdown, info) {
  const pattern = new RegExp("```" + info + "\\s*\\n([\\s\\S]*?)\\n```", "g");
  const blocks = [];
  for (const match of markdown.matchAll(pattern)) blocks.push(match[1]);
  return blocks;
}

// ── Embedded examples run through the production pipeline ────────────

/** The minimal example's effective definition; the contract's default source. */
let minimalDefinition;
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

    minimalDefinition = registry.definitions.find((definition) => definition.id === "minimal-valid");
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = previousAgentDir;
    if (previousCodingAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousCodingAgentDir;
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── The schema reference's structured contract matches production ────

{
  const markdown = readFileSync(join(assetsDir, "schema-reference.md"), "utf8");
  const contracts = extractBlocks(markdown, "json shadow-contract");
  assert.equal(contracts.length, 1, "exactly one structured contract block exists");
  const documented = JSON.parse(contracts[0]);

  // The minimal embedded example declares no optional field, so the defaults
  // the contract publishes are the ones discovery resolved for it.
  assert.ok(minimalDefinition, "the minimal embedded example is effective through production discovery");

  assert.deepEqual(
    Object.keys(documented.fields).sort(),
    [...SHADOW_DEFINITION_FIELDS].sort(),
    "the contract block documents exactly the parser's definition fields",
  );
  // One whole-object comparison: every bound, enum, pattern, and default in
  // the block comes from production code, so drift prints as one full diff
  // instead of stopping at the first mismatched key.
  assert.deepEqual(
    documented,
    buildShadowDefinitionContract(minimalDefinition),
    "the published contract block matches the contract generated from production",
  );
}

// ── The Config Guide points at the reference assets ──────────────────

{
  const registry = { definitions: [], invalid: [], diagnostics: [] };
  const guide = buildShadowConfigGuide(registry, "/repo");
  assert.ok(guide.content.includes(join("shadow-minds", "example.md")), "the guide names the packaged example path");
  assert.ok(guide.content.includes(join("shadow-minds", "schema-reference.md")), "the guide names the packaged schema-reference path");
}

console.log("shadow-minds reference-asset tests: OK");
