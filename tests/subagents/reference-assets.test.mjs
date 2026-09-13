import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import jiti from "jiti";

const packageRoot = resolve(import.meta.dirname, "..", "..");
const load = jiti(import.meta.url, { moduleCache: false });
const {
  DEFINITION_FIELDS,
  discoverSubagents,
  filterVisibleSubagents,
  __testables,
} = await load(join(packageRoot, "src", "subagents", "definitions.ts"));
const { BUILT_IN_TOOL_NAMES, resolveSubagentTools } = await load(join(packageRoot, "src", "subagents", "tool-policy.ts"));
const { ALLOWED_EFFORTS } = await load(join(packageRoot, "src", "subagents", "efforts.ts"));
const { buildSubagentConfigGuide, subagentFieldTableRows } = await load(join(packageRoot, "src", "subagents", "config-guide.ts"));

const assetsDir = join(packageRoot, "subagents");

// ── The package ships exactly the reference definition and the schema doc ──

{
  const entries = readdirSync(assetsDir).sort();
  assert.deepEqual(
    entries,
    ["example_profile.yaml", "schema-reference.md"],
    "the packaged subagents directory holds exactly the reference definition and the schema reference",
  );
}

// ── The package layer provides no delegatable roles ────────────────────

{
  const dir = mkdtempSync(join(tmpdir(), "pi-square-subagent-ref-"));
  const previousAgentDir = process.env.PI_AGENT_DIR;
  const previousCodingAgentDir = process.env.PI_CODING_AGENT_DIR;
  const agent = join(dir, "agent");
  const project = join(dir, "project");
  try {
    process.env.PI_AGENT_DIR = agent;
    process.env.PI_CODING_AGENT_DIR = agent;
    mkdirSync(agent, { recursive: true });
    mkdirSync(project, { recursive: true });

    // The behavioral assertion for "the package layer provides no roles":
    // real discovery over the packaged directory yields an empty visible set.
    const registry = discoverSubagents(project);
    assert.deepEqual(
      filterVisibleSubagents(registry).definitions.map((definition) => definition.name),
      [],
      "the package layer's visible set is empty",
    );
    assert.deepEqual(
      registry.definitions.map((definition) => definition.name),
      ["example_profile"],
      "the hidden reference definition is the only package-layer entry",
    );
    assert.equal(registry.definitions[0].visible, false);
    assert.equal(registry.definitions[0].layers[0]?.filePath, join(assetsDir, "example_profile.yaml"));
    assert.deepEqual(registry.errors, []);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = previousAgentDir;
    if (previousCodingAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousCodingAgentDir;
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── The reference definition stays valid, hidden, and complete ─────────

{
  const content = readFileSync(join(assetsDir, "example_profile.yaml"), "utf8");
  const parsed = __testables.parseYamlDefinition(content, join(assetsDir, "example_profile.yaml"), "package");
  assert.deepEqual(parsed.errors, [], "the annotated reference definition parses without errors");
  assert.equal(parsed.layer?.patch.name, "example_profile");
  assert.equal(parsed.layer?.patch.visible, false, "the reference definition stays hidden");
  for (const field of DEFINITION_FIELDS) {
    assert.ok(
      content.includes(`${field}:`) || content.includes(`# ${field}:`),
      `the reference definition demonstrates the '${field}' field`,
    );
  }
}

// ── The schema reference's structured contract matches production ──────

function extractBlocks(markdown, info) {
  const pattern = new RegExp("```" + info + "\\s*\\n([\\s\\S]*?)\\n```", "g");
  const blocks = [];
  for (const match of markdown.matchAll(pattern)) blocks.push(match[1]);
  return blocks;
}

{
  const markdown = readFileSync(join(assetsDir, "schema-reference.md"), "utf8");
  const contracts = extractBlocks(markdown, "json subagent-contract");
  assert.equal(contracts.length, 1, "exactly one structured contract block exists");
  const contract = JSON.parse(contracts[0]);
  assert.equal(contract.promptVersion, 2);
  assert.equal(contract.builtInToolNames.join(","), BUILT_IN_TOOL_NAMES.join(","));
  assert.equal(contract.portableShellCapability, "shell");
  assert.equal(contract.noBuiltInToolsSentinel, "none (must be the only entry)");
  assert.equal(contract.allowedEfforts.join(","), ALLOWED_EFFORTS.join(","));

  // The documented field table is the guide's generated one, item by item.
  const rows = subagentFieldTableRows();
  assert.deepEqual(Object.keys(contract.fields), [...DEFINITION_FIELDS]);
  assert.deepEqual(Object.keys(contract.fields), rows.map((row) => row.field));
  for (const row of rows) {
    assert.deepEqual(
      contract.fields[row.field],
      { type: row.type, required: row.required, default: row.default },
      `the contract row for '${row.field}' matches the generated guide row`,
    );
  }
}

// ── Embedded examples run through production discovery and tool policy ─

{
  const markdown = readFileSync(join(assetsDir, "schema-reference.md"), "utf8");
  const valid = extractBlocks(markdown, "yaml subagent-valid");
  const invalid = extractBlocks(markdown, "yaml subagent-invalid");
  const startupInvalid = extractBlocks(markdown, "yaml subagent-startup-invalid");
  const overlayAgent = extractBlocks(markdown, "yaml subagent-overlay-agent");
  const overlayProject = extractBlocks(markdown, "yaml subagent-overlay-project");
  assert.ok(valid.length >= 2, "at least two valid embedded examples exist");
  assert.ok(invalid.length >= 5, "at least five invalid embedded examples exist");
  assert.equal(startupInvalid.length, 2, "the two startup-time counterexamples exist");
  assert.equal(overlayAgent.length, 1, "exactly one agent-base overlay block exists");
  assert.equal(overlayProject.length, 1, "exactly one project-overlay block exists");

  const nameOf = (block) => {
    const match = /^name: (\S+)$/m.exec(block);
    assert.ok(match, "every embedded example declares a name");
    return match[1];
  };

  const dir = mkdtempSync(join(tmpdir(), "pi-square-subagent-ref-"));
  const previousAgentDir = process.env.PI_AGENT_DIR;
  const previousCodingAgentDir = process.env.PI_CODING_AGENT_DIR;
  const agent = join(dir, "agent");
  const project = join(dir, "project");
  try {
    process.env.PI_AGENT_DIR = agent;
    process.env.PI_CODING_AGENT_DIR = agent;
    mkdirSync(join(agent, "subagents"), { recursive: true });
    mkdirSync(join(project, ".pi", "subagents"), { recursive: true });

    for (const block of [...valid, ...invalid, ...startupInvalid, ...overlayAgent]) {
      writeFileSync(join(agent, "subagents", `${nameOf(block)}.yaml`), `${block}\n`, "utf8");
    }
    for (const block of overlayProject) {
      writeFileSync(join(project, ".pi", "subagents", `${nameOf(block)}.yaml`), `${block}\n`, "utf8");
    }
    const registry = discoverSubagents(project);
    const active = new Map(registry.definitions.map((definition) => [definition.name, definition]));
    const excluded = new Map(registry.invalid.map((entry) => [entry.id, entry]));

    for (const block of valid) {
      const name = nameOf(block);
      assert.ok(active.has(name), `embedded example '${name}' is effective through production discovery`);
      assert.ok(!excluded.has(name), `embedded example '${name}' is not excluded`);
    }
    for (const block of invalid) {
      const name = nameOf(block);
      assert.ok(excluded.has(name), `embedded example '${name}' is rejected whole through production discovery`);
      assert.ok(!active.has(name), `embedded example '${name}' never activates`);
      assert.ok(
        excluded.get(name).errors.length > 0,
        `embedded example '${name}' carries its errors as an invalid entry`,
      );
    }
    for (const block of startupInvalid) {
      const name = nameOf(block);
      // The three-stage story, executed: these parse and merge cleanly, and
      // only the child-session tool resolution rejects them.
      assert.ok(active.has(name), `startup example '${name}' parses and stays effective at discovery`);
      const definition = active.get(name);
      const resolved = resolveSubagentTools({
        tools: definition.tools,
        extensionTools: definition.extensionTools,
      }, "linux");
      assert.ok(resolved.errors.length > 0, `startup example '${name}' fails production tool resolution`);
    }
    // Every positive example is also startup-clean through the same seam.
    for (const block of [...valid, ...overlayAgent, ...overlayProject]) {
      const definition = active.get(nameOf(block));
      const resolved = resolveSubagentTools({
        tools: definition?.tools,
        extensionTools: definition?.extensionTools,
      }, "linux");
      assert.deepEqual(resolved.errors, [], `${nameOf(block)} resolves cleanly at child-session startup`);
    }

    // The overlay pair merges the three states exactly as documented: []
    // clears the inherited tool list, null clears the scalar, omitted inherits.
    const overlay = active.get("overlay-demo");
    assert.ok(overlay, "the overlay pair merges into one effective definition");
    assert.match(overlay.description, /Base layer carrying the inherited fields\./);
    assert.equal(overlay.policy, "Base policy.");
    assert.deepEqual(overlay.tools, []);
    assert.equal(overlay.model, undefined);
    assert.equal(overlay.visible, false);
    assert.equal(overlay.fieldSources.policy.source, "agent");
    assert.equal(overlay.fieldSources.visible.source, "project");

    // The packaged reference stays hidden beside every embedded example.
    assert.equal(registry.definitions.find((definition) => definition.name === "example_profile")?.visible, false);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = previousAgentDir;
    if (previousCodingAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousCodingAgentDir;
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── The Config Guide points at the reference assets and generated lists ─

{
  const registry = { definitions: [], invalid: [], errors: [], projectDir: null };
  const guide = buildSubagentConfigGuide(registry, "/repo");
  assert.ok(guide.content.includes(join("subagents", "schema-reference.md")), "the guide names the packaged schema-reference path");
  assert.ok(guide.content.includes(BUILT_IN_TOOL_NAMES.join(", ")), "the guide's built-in tool list matches the constant exactly");
  assert.ok(guide.content.includes(ALLOWED_EFFORTS.join(", ")), "the guide's effort list matches the constant exactly");
  for (const row of subagentFieldTableRows()) {
    assert.ok(guide.content.includes(`| ${row.field} | ${row.type} |`), `the guide's field table covers '${row.field}'`);
  }
}

console.log("subagents reference-asset tests: OK");
