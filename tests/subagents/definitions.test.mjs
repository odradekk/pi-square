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

test("the package layer ships no delegatable roles; only the hidden reference remains", async () => {
  await withRoot((dir) => {
    const registry = discoverSubagents(join(dir, "repo"));
    assert.deepEqual(registry.errors, []);
    assert.deepEqual(
      filterVisibleSubagents(registry).definitions.map((item) => item.name),
      [],
      "the package layer's visible set is empty",
    );
    assert.deepEqual(registry.definitions.map((item) => item.name), ["example_profile"]);
    const reference = registry.definitions[0];
    assert.equal(reference.visible, false, "the packaged reference definition stays hidden");
    assert.equal(reference.layers[0]?.filePath, join(packageRoot, "subagents", "example_profile.yaml"));
  });
});

test("project and user overlays merge per field with project precedence", () => {
  const base = __testables.parseYamlDefinition(
    `promptVersion: 2\nname: worker\ndescription: >\n  Self-made package-free base layer.\npolicy: |\n  BASE POLICY\ninstructions: |\n  Base instructions.\noutput: |\n  ### Changes\ntools:\n  - read\n  - ls\n`,
    "/pkg/subagents/worker.yaml",
    "package",
  ).layer;
  const userFile = "/agent/subagents/worker.yaml";
  const projectFile = "/repo/.pi/subagents/worker.yaml";
  const user = __testables.parseYamlDefinition(
    `promptVersion: 2\nname: worker\npolicy: |\n  USER POLICY\nvisible: false\n`,
    userFile,
    "agent",
  ).layer;
  const project = __testables.parseYamlDefinition(
    `promptVersion: 2\nname: worker\ninstructions: null\nvisible: true\n`,
    projectFile,
    "project",
  ).layer;
  const { definition: worker, errors } = __testables.mergeDefinitionLayers("worker", [base, user, project]);

  assert.deepEqual(errors, []);
  assert.equal(worker.layers.length, 3);
  assert.equal(worker.policy, "USER POLICY");
  assert.equal(worker.instructions, undefined);
  assert.match(worker.output, /### Changes/);
  assert.equal(worker.visible, true);
  assert.equal(worker.fieldSources.policy.source, "agent");
  assert.equal(worker.fieldSources.instructions.source, "project");
  assert.equal(worker.fieldSources.output.source, "package");
  assert.equal(worker.source, "project");
  assert.equal(worker.filePath, projectFile);
});

test("a project overlay can reveal and re-hide the packaged reference definition", async () => {
  await withRoot((dir) => {
    const file = join(dir, "repo", ".pi", "subagents", "example_profile.yaml");
    write(file, `promptVersion: 2\nname: example_profile\nvisible: true\n`);
    const revealed = discoverSubagents(join(dir, "repo"));
    assert.equal(revealed.definitions.find((item) => item.name === "example_profile").visible, true);
    assert.equal(filterVisibleSubagents(revealed).definitions.some((item) => item.name === "example_profile"), true);

    write(file, `promptVersion: 2\nname: example_profile\nvisible: false\n`);
    const hidden = discoverSubagents(join(dir, "repo"));
    assert.equal(filterVisibleSubagents(hidden).definitions.some((item) => item.name === "example_profile"), false);
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
    // An indented body belongs to the rejected block, so it must not pile
    // orphaned-line errors on top of the named cause.
    assert.ok(!parsed.errors.some((item) => item.includes("unsupported YAML line")), `${indicator}: ${parsed.errors.join(" | ")}`);
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

  // The same indentation rule governs the supported indicators: a following
  // field at the field's own indent is never block content.
  const emptyBlock = __testables.parseYamlDefinition(
    `promptVersion: 2\ndescription: |\nname: t\n`,
    "/agent/subagents/t.yaml",
    "agent",
  );
  assert.deepEqual(emptyBlock.errors, []);
  assert.equal(emptyBlock.layer?.patch.name, "t");
  assert.equal(emptyBlock.layer?.patch.description, null);
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

test("a dash-led line without the item space is not a list item", () => {
  // The subset admits exactly `-` and `- item`; `-item` never opens a list
  // and, after items started, ends the list and reports the bare line.
  for (const [label, text] of [
    ["first item", `promptVersion: 2\nname: t\ndescription: d\ntools:\n  -bash\n`],
    ["after items", `promptVersion: 2\nname: t\ndescription: d\ntools:\n  - read\n  -bash\n`],
  ]) {
    const parsed = __testables.parseYamlDefinition(text, "/agent/subagents/t.yaml", "agent");
    assert.equal(parsed.layer, undefined, `${label} must not admit the layer`);
    assert.ok(
      parsed.errors.some((item) => item.includes("unsupported YAML line") && item.includes("-bash")),
      `${label}: ${parsed.errors.join(" | ")}`,
    );
  }
});

test("a whitespace-only line is not content and not an error", () => {
  // A tab-only line used to reject the whole file with an empty
  // unsupported-line message; whitespace-only lines now carry nothing.
  const parsed = __testables.parseYamlDefinition(
    `promptVersion: 2\nname: t\ndescription: d\ntools:\n  - bash\n\t\n`,
    "/agent/subagents/t.yaml",
    "agent",
  );
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.layer?.patch.tools, ["bash"]);
});

test("a whole-line comment inside a block list does not terminate it", () => {
  // Comments are author documentation everywhere: items on both sides of a
  // comment line stay in the list, and a blank line before the comment is
  // the named blank-line-in-list error, not a swallowed remainder.
  const transparent = __testables.parseYamlDefinition(
    `promptVersion: 2\nname: t\ndescription: d\ntools:\n  - read\n  # note\n  - grep\n`,
    "/agent/subagents/t.yaml",
    "agent",
  );
  assert.deepEqual(transparent.errors, []);
  assert.deepEqual(transparent.layer?.patch.tools, ["read", "grep"]);

  const blankBeforeComment = __testables.parseYamlDefinition(
    `promptVersion: 2\nname: t\ndescription: d\ntools:\n  - read\n\n  # note\n  - grep\n`,
    "/agent/subagents/t.yaml",
    "agent",
  );
  assert.equal(blankBeforeComment.layer, undefined);
  assert.ok(
    blankBeforeComment.errors.some((item) => item.includes("blank line inside the block list")),
    blankBeforeComment.errors.join(" | "),
  );
});

test("a column-zero item after indented items is rejected instead of swallowed", () => {
  // The column-zero indentation rule already applied to a list's first
  // item; it now applies mid-list too, instead of silently absorbing the
  // item into the list.
  const parsed = __testables.parseYamlDefinition(
    `promptVersion: 2\nname: t\ndescription: d\ntools:\n  - read\n- grep\n`,
    "/agent/subagents/t.yaml",
    "agent",
  );
  assert.equal(parsed.layer, undefined);
  assert.ok(
    parsed.errors.some((item) => item.includes("list items must be indented")),
    parsed.errors.join(" | "),
  );
  assert.ok(!parsed.errors.some((item) => item.includes("unsupported YAML line")), parsed.errors.join(" | "));
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
    write(join(dir, "agent", "subagents", "worker.yaml"), `promptVersion: 2\nname: worker\ndescription: >\n  Self-made agent-layer base for overlay tests.\ntools:\n  - read\n  - ls\n`);
    const registry = discoverSubagents(cwd);
    const patch = { promptVersion: 2, name: "worker", visible: false };
    const preview = previewDefinitionPatch({ registry, cwd, scope: "project", patch });
    assert.deepEqual(preview.errors, []);
    assert.equal(preview.definition.visible, false);
    assert.match(preview.definition.description, /Self-made agent-layer base/);
    assert.doesNotMatch(preview.content, /description:/);

    const written = writeDefinitionPatch({ cwd, scope: "project", patch });
    assert.equal(written.filePath, join(cwd, ".pi", "subagents", "worker.yaml"));
    assert.equal(discoverSubagents(cwd).definitions.find((item) => item.name === "worker").visible, false);
    assert.equal(deleteDefinitionOverlay({ cwd, scope: "project", name: "worker" }), true);
    assert.equal(discoverSubagents(cwd).definitions.find((item) => item.name === "worker").visible, true);
  });
});

test("editing and deleting an existing noncanonical filename stays on its validated layer path", async () => {
  await withRoot((dir) => {
    const cwd = join(dir, "repo");
    const filePath = join(cwd, ".pi", "subagents", "custom-worker.yml");
    write(filePath, `promptVersion: 2\nname: worker\ndescription: Noncanonical path fixture.\nvisible: false\n`);
    const registry = discoverSubagents(cwd);
    const patch = { promptVersion: 2, name: "worker", visible: true };
    const preview = previewDefinitionPatch({ registry, cwd, scope: "project", patch });
    assert.equal(preview.filePath, filePath);
    writeDefinitionPatch({ cwd, scope: "project", patch, filePath: preview.filePath });
    assert.equal(existsSync(join(cwd, ".pi", "subagents", "worker.yaml")), false);
    assert.equal(deleteDefinitionOverlay({ cwd, scope: "project", name: "worker", filePath }), true);
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
