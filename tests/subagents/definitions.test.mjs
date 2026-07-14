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

test("package V2 definitions expose the five inherited-model roles without diagnostics", async () => {
  await withRoot((dir) => {
    const registry = discoverSubagents(join(dir, "repo"));
    assert.deepEqual(registry.errors, []);
    assert.deepEqual(
      filterVisibleSubagents(registry).definitions.map((item) => item.name),
      ["crawler", "explorer", "generalist", "librarian", "oracle"],
    );
    assert.equal(registry.definitions.find((item) => item.name === "example_profile").visible, false);
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

await run();
