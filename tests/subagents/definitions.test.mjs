import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import jiti from "jiti";
import { run, test } from "./lib/test-helpers.mjs";

const packageRoot = resolve(import.meta.dirname, "..", "..");
const load = jiti(import.meta.url, { moduleCache: false });
const {
  deleteDefinitionOverlay,
  discoverSubagents,
  filterVisibleSubagents,
  previewDefinitionPatch,
  serializeDefinitionPatch,
  writeDefinitionPatch,
  __testables,
} = await load(join(packageRoot, "src", "subagents", "definitions.ts"));

function root() {
  return join(tmpdir(), `pi-square-definitions-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function write(path, content) {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf8");
}

async function withRoot(fn) {
  const dir = root();
  const previousAgentDir = process.env.PI_AGENT_DIR;
  const previousCodingAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_AGENT_DIR = join(dir, "agent");
  process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
  try {
    await fn(dir);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = previousAgentDir;
    if (previousCodingAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousCodingAgentDir;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("package V2 definitions expose the three inherited-model roles without diagnostics", async () => {
  await withRoot((dir) => {
    const registry = discoverSubagents(join(dir, "repo"));
    assert.deepEqual(registry.errors, []);
    assert.deepEqual(
      filterVisibleSubagents(registry).definitions.map((item) => item.name),
      ["crawler", "explorer", "generalist"],
    );
    assert.equal(registry.definitions.find((item) => item.name === "example_profile").visible, false);
    for (const definition of registry.definitions) {
      assert.equal(definition.layers[0]?.filePath, join(packageRoot, "subagents", `${definition.name}.yaml`));
    }
    for (const definition of filterVisibleSubagents(registry).definitions) {
      assert.equal(definition.model, undefined, `${definition.name} model must inherit`);
      assert.equal(definition.effort, undefined, `${definition.name} effort must inherit`);
      assert.equal(definition.inheritParentSystem, true, `${definition.name} must inherit the parent system`);
      assert.ok(definition.policy?.length > 40, `${definition.name} needs a clear policy`);
      assert.ok(definition.instructions?.includes("## Objective"), `${definition.name} needs structured instructions`);
      assert.ok(definition.output?.includes("### Confidence") || definition.name === "generalist", `${definition.name} needs a bounded output contract`);
      assert.ok((definition.instructions?.length ?? 0) < 2_000, `${definition.name} instructions should stay concise`);
    }
  });
});

test("project and user overlays merge per field with project precedence", () => {
  const base = discoverSubagents(packageRoot).definitions.find((item) => item.name === "generalist").layers[0];
  const userFile = "/agent/subagents/generalist.yaml";
  const projectFile = "/repo/.pi/subagents/generalist.yaml";
  const user = __testables.parseYamlDefinition(
    `promptVersion: 2\nname: generalist\npolicy: |\n  USER POLICY\nvisible: false\n`,
    userFile,
    "agent",
  ).layer;
  const project = __testables.parseYamlDefinition(
    `promptVersion: 2\nname: generalist\ninstructions: null\nvisible: true\n`,
    projectFile,
    "project",
  ).layer;
  const { definition: generalist, errors } = __testables.mergeDefinitionLayers("generalist", [base, user, project]);

  assert.deepEqual(errors, []);
  assert.equal(generalist.layers.length, 3);
  assert.equal(generalist.policy, "USER POLICY");
  assert.equal(generalist.instructions, undefined);
  assert.match(generalist.output, /### Changes/);
  assert.equal(generalist.visible, true);
  assert.equal(generalist.fieldSources.policy.source, "agent");
  assert.equal(generalist.fieldSources.instructions.source, "project");
  assert.equal(generalist.fieldSources.output.source, "package");
  assert.equal(generalist.source, "project");
  assert.equal(generalist.filePath, projectFile);
});

test("a minimal visibility overlay can hide and reveal a package definition", async () => {
  await withRoot((dir) => {
    const file = join(dir, "repo", ".pi", "subagents", "explorer.yaml");
    write(file, `promptVersion: 2\nname: explorer\nvisible: false\n`);
    const hidden = discoverSubagents(join(dir, "repo"));
    assert.equal(hidden.definitions.find((item) => item.name === "explorer").visible, false);
    assert.equal(filterVisibleSubagents(hidden).definitions.some((item) => item.name === "explorer"), false);

    write(file, `promptVersion: 2\nname: explorer\nvisible: null\n`);
    const revealed = discoverSubagents(join(dir, "repo"));
    assert.equal(revealed.definitions.find((item) => item.name === "explorer").visible, true);
  });
});

test("V2 rejects legacy and unknown fields without admitting the layer", () => {
  const parsed = __testables.parseYamlDefinition(
    `name: legacy\ndescription: old\nprompt: old\n`,
    "/agent/subagents/legacy.yaml",
    "agent",
  );
  assert.equal(parsed.layer, undefined);
  assert.ok(parsed.errors.some((item) => item.includes("promptVersion")));
  assert.ok(parsed.errors.some((item) => item.includes("unknown field 'prompt'")));
});

test("block scalar chomping indicators are rejected instead of stored as literal strings", () => {
  for (const indicator of ["|-", ">+", "|2"]) {
    const parsed = __testables.parseYamlDefinition(
      `promptVersion: 2\nname: t\ndescription: ${indicator}\n  hello\n`,
      "/agent/subagents/t.yaml",
      "agent",
    );
    assert.equal(parsed.layer, undefined, `${indicator} must not admit the layer`);
    assert.ok(parsed.errors.some((item) => item.includes(indicator) && item.includes("chomping")), `${indicator}: ${parsed.errors.join(" | ")}`);
  }
  // Rejecting the indicator must not consume what follows: the next field line
  // still parses, so no spurious missing-name error and the invalid entry
  // keeps the parsed name as its identity.
  const noBody = __testables.parseYamlDefinition(
    `promptVersion: 2\ndescription: |-\nname: t\n`,
    "/agent/subagents/t.yaml",
    "agent",
  );
  assert.equal(noBody.layer, undefined);
  assert.ok(noBody.errors.some((item) => item.includes("chomping")));
  assert.ok(!noBody.errors.some((item) => item.includes("missing required field 'name'")), noBody.errors.join(" | "));
  assert.equal(noBody.name, "t");
});

test("inline comments are rejected instead of mixing into values", () => {
  for (const [label, text] of [
    ["scalar", `promptVersion: 2\nname: t\ndescription: hello # note\n`],
    ["leading", `promptVersion: 2\nname: t\ndescription: # note\n`],
    ["inline array", `promptVersion: 2\nname: t\ndescription: d\ntools: [read, grep] # note\n`],
    ["list item", `promptVersion: 2\nname: t\ndescription: d\ntools:\n  - read # first\n`],
  ]) {
    const parsed = __testables.parseYamlDefinition(text, "/agent/subagents/t.yaml", "agent");
    assert.equal(parsed.layer, undefined, `${label} must not admit the layer`);
    assert.ok(parsed.errors.some((item) => item.includes("inline comments")), `${label}: ${parsed.errors.join(" | ")}`);
  }
  // Quoted values keep a literal #; only unquoted comments are rejected.
  const quoted = __testables.parseYamlDefinition(
    `promptVersion: 2\nname: t\ndescription: "hello # not a comment"\n`,
    "/agent/subagents/t.yaml",
    "agent",
  );
  assert.equal(quoted.layer?.patch.description, "hello # not a comment");
});

test("uppercase null and tilde spellings are rejected instead of becoming literal strings", () => {
  for (const spelling of ["NULL", "Null", "～"]) {
    const parsed = __testables.parseYamlDefinition(
      `promptVersion: 2\nname: t\ndescription: d\nmodel: ${spelling}\n`,
      "/agent/subagents/t.yaml",
      "agent",
    );
    assert.equal(parsed.layer, undefined, `${spelling} must not admit the layer`);
    assert.ok(parsed.errors.some((item) => item.includes(spelling) && item.includes("null")), `${spelling}: ${parsed.errors.join(" | ")}`);
  }
  // Exact lowercase null, ASCII tilde, and quoted strings stay valid.
  for (const value of ["null", "~", '"NULL"']) {
    const parsed = __testables.parseYamlDefinition(
      `promptVersion: 2\nname: t\ndescription: d\nmodel: ${value}\n`,
      "/agent/subagents/t.yaml",
      "agent",
    );
    assert.equal(parsed.errors.length, 0, value);
  }
  // Inline array items follow the same spelling rules as block list items.
  const arrayMisspelled = __testables.parseYamlDefinition(
    `promptVersion: 2\nname: t\ndescription: d\ntools: [read, NULL]\n`,
    "/agent/subagents/t.yaml",
    "agent",
  );
  assert.equal(arrayMisspelled.layer, undefined);
  assert.ok(arrayMisspelled.errors.some((item) => item.includes("NULL")));
  const arrayQuoted = __testables.parseYamlDefinition(
    `promptVersion: 2\nname: t\ndescription: d\ntools: [read, "NULL"]\n`,
    "/agent/subagents/t.yaml",
    "agent",
  );
  assert.deepEqual(arrayQuoted.errors, []);
  assert.deepEqual(arrayQuoted.layer?.patch.tools, ["read", "NULL"]);
  // Exact lowercase null inside an inline array clears the item like a block list item.
  const arrayNullItem = __testables.parseYamlDefinition(
    `promptVersion: 2\nname: t\ndescription: d\ntools: [read, null]\n`,
    "/agent/subagents/t.yaml",
    "agent",
  );
  assert.deepEqual(arrayNullItem.errors, []);
  assert.deepEqual(arrayNullItem.layer?.patch.tools, ["read"]);
});

test("blank lines inside a block list are rejected instead of truncating it", () => {
  for (const [label, text] of [
    ["mid-list", `promptVersion: 2\nname: t\ndescription: d\ntools:\n  - read\n\n  - grep\n`],
    ["before first item", `promptVersion: 2\nname: t\ndescription: d\ntools:\n\n  - read\n`],
  ]) {
    const parsed = __testables.parseYamlDefinition(text, "/agent/subagents/t.yaml", "agent");
    assert.equal(parsed.layer, undefined, `${label} must not admit the layer`);
    assert.ok(parsed.errors.some((item) => item.includes("blank line inside the block list")), `${label}: ${parsed.errors.join(" | ")}`);
    assert.equal(parsed.errors.filter((item) => item.includes("blank line inside the block list")).length, 1, `${label} reports the blank once`);
  }
  // A blank line after a finished list, before the next field, stays valid.
  const trailing = __testables.parseYamlDefinition(
    `promptVersion: 2\nname: t\ndescription: d\ntools:\n  - read\n\nskills: []\n`,
    "/agent/subagents/t.yaml",
    "agent",
  );
  assert.deepEqual(trailing.errors, []);
  assert.deepEqual(trailing.layer?.patch.tools, ["read"]);
});

test("column-zero list items report the indentation rule directly", () => {
  const parsed = __testables.parseYamlDefinition(
    `promptVersion: 2\nname: t\ndescription: d\ntools:\n- read\n`,
    "/agent/subagents/t.yaml",
    "agent",
  );
  assert.equal(parsed.layer, undefined);
  assert.ok(parsed.errors.some((item) => item.includes("list items must be indented")), parsed.errors.join(" | "));
});

test("new definitions must resolve a description after overlays", async () => {
  await withRoot((dir) => {
    write(join(dir, "repo", ".pi", "subagents", "new-agent.yaml"), `promptVersion: 2\nname: new-agent\nvisible: false\n`);
    const registry = discoverSubagents(join(dir, "repo"));
    assert.equal(registry.definitions.some((item) => item.name === "new-agent"), false);
    assert.ok(registry.errors.some((item) => item.includes("missing required field 'description'")));
  });
});

test("canonical overlay serialization preserves inherit versus clear", () => {
  const content = serializeDefinitionPatch({
    promptVersion: 2,
    name: "worker",
    policy: null,
    instructions: "Use evidence.",
    tools: [],
    visible: false,
  });
  assert.match(content, /^promptVersion: 2\nname: "worker"/);
  assert.match(content, /policy: null/);
  assert.match(content, /instructions: \|\n  Use evidence\./);
  assert.match(content, /tools: \[\]/);
  assert.doesNotMatch(content, /description:/);
});

test("preview and atomic project writes preserve lower fields and delete cleanly", async () => {
  await withRoot((dir) => {
    const cwd = join(dir, "repo");
    mkdirSync(cwd, { recursive: true });
    const registry = discoverSubagents(cwd);
    const patch = { promptVersion: 2, name: "generalist", visible: false };
    const preview = previewDefinitionPatch({ registry, cwd, scope: "project", patch });
    assert.deepEqual(preview.errors, []);
    assert.equal(preview.definition.visible, false);
    assert.match(preview.definition.description, /General-purpose implementation agent/);
    assert.doesNotMatch(preview.content, /description:/);

    const written = writeDefinitionPatch({ cwd, scope: "project", patch });
    assert.equal(written.filePath, join(cwd, ".pi", "subagents", "generalist.yaml"));
    assert.equal(discoverSubagents(cwd).definitions.find((item) => item.name === "generalist").visible, false);
    assert.equal(deleteDefinitionOverlay({ cwd, scope: "project", name: "generalist" }), true);
    assert.equal(discoverSubagents(cwd).definitions.find((item) => item.name === "generalist").visible, true);
  });
});

test("editing and deleting an existing noncanonical filename stays on its validated layer path", async () => {
  await withRoot((dir) => {
    const cwd = join(dir, "repo");
    const filePath = join(cwd, ".pi", "subagents", "custom-generalist.yml");
    write(filePath, `promptVersion: 2\nname: generalist\nvisible: false\n`);
    const registry = discoverSubagents(cwd);
    const patch = { promptVersion: 2, name: "generalist", visible: true };
    const preview = previewDefinitionPatch({ registry, cwd, scope: "project", patch });
    assert.equal(preview.filePath, filePath);
    writeDefinitionPatch({ cwd, scope: "project", patch, filePath: preview.filePath });
    assert.equal(existsSync(join(cwd, ".pi", "subagents", "generalist.yaml")), false);
    assert.equal(deleteDefinitionOverlay({ cwd, scope: "project", name: "generalist", filePath }), true);
    assert.equal(existsSync(filePath), false);
  });
});

test("definition hashes are stable and source-sensitive", () => {
  assert.equal(__testables.hashContent("a"), __testables.hashContent("a"));
  assert.notEqual(__testables.hashContent("a"), __testables.hashContent("b"));
});

test("rejected definition files return as invalid entries beside valid definitions", async () => {
  await withRoot((dir) => {
    const cwd = join(dir, "repo");
    const brokenPath = join(cwd, ".pi", "subagents", "broken.yaml");
    const stemPath = join(cwd, ".pi", "subagents", "no-name.yaml");
    write(join(cwd, ".pi", "subagents", "good.yaml"), `promptVersion: 2\nname: good\ndescription: Works.\n`);
    write(brokenPath, `promptVersion: 2\nname: broken\ndescription: hello # comment\nmodel: NULL\n`);
    write(stemPath, `promptVersion: 2\ndescription: no name at all\n`);
    const registry = discoverSubagents(cwd);

    assert.ok(registry.definitions.some((item) => item.name === "good"), "the valid definition stays effective");
    assert.equal(registry.definitions.some((item) => item.name === "broken"), false);

    const broken = registry.invalid.find((item) => item.id === "broken");
    assert.ok(broken, `invalid ids: ${registry.invalid.map((item) => item.id).join(", ")}`);
    assert.deepEqual(broken.sources, [brokenPath]);
    assert.ok(broken.errors.every((item) => item.includes(brokenPath)), "every error names the file");
    assert.ok(broken.errors.some((item) => item.includes("inline comments")), "the comment error is carried");
    assert.ok(broken.errors.some((item) => item.includes("null spellings")), "the null spelling error is carried");

    const stem = registry.invalid.find((item) => item.id === "no-name");
    assert.ok(stem, "an unusable name falls back to the file stem for the id");
  });
});

test("overlay merge failures surface as invalid entries with their contributing layers", async () => {
  await withRoot((dir) => {
    const cwd = join(dir, "repo");
    const agentFile = join(dir, "agent", "subagents", "worker.yaml");
    const projectFile = join(cwd, ".pi", "subagents", "worker.yaml");
    write(agentFile, `promptVersion: 2\nname: worker\ndescription: Works.\n`);
    write(projectFile, `promptVersion: 2\nname: worker\ndescription: null\n`);
    const registry = discoverSubagents(cwd);

    assert.equal(registry.definitions.some((item) => item.name === "worker"), false);
    const invalid = registry.invalid.find((item) => item.id === "worker");
    assert.ok(invalid, `invalid ids: ${registry.invalid.map((item) => item.id).join(", ")}`);
    assert.deepEqual([...invalid.sources].sort(), [agentFile, projectFile].sort());
    assert.ok(invalid.errors.some((item) => item.includes("description")));
  });
});

await run();
