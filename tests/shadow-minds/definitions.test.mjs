import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import jiti from "jiti";

const packageRoot = resolve(import.meta.dirname, "..", "..");
const load = jiti(import.meta.url, { moduleCache: false });
const {
  DEFAULT_SHADOW_LOCAL_TOOLS,
  discoverShadowDefinitions,
} = await load(join(packageRoot, "src", "shadow-minds", "definitions.ts"));

const TEMPLATE_IDS = [
  "alternative-explorer",
  "architecture-lens",
  "completion-check",
  "project-grounding",
  "research-scout",
  "session-synthesizer",
];

function root() {
  return mkdtempSync(join(tmpdir(), `pi-square-shadow-defs-${process.pid}-${Date.now()}`));
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
    await fn(dir, join(dir, "project"));
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_AGENT_DIR;
    else process.env.PI_AGENT_DIR = previousAgentDir;
    if (previousCodingAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousCodingAgentDir;
    rmSync(dir, { recursive: true, force: true });
  }
}

function definitionFile(fields, body = "Own the responsibility described here.") {
  const lines = ["---", "promptVersion: 1", `id: ${fields.id}`, `name: ${fields.name}`];
  for (const [key, value] of Object.entries(fields)) {
    if (key === "id" || key === "name") continue;
    if (value === null) {
      lines.push(`${key}: null`);
    } else if (Array.isArray(value)) {
      lines.push(`${key}: [${value.join(", ")}]`);
    } else if (typeof value === "object") {
      lines.push(`${key}:`);
      lines.push(yamlBlock(value, 2));
    } else {
      lines.push(`${key}: ${typeof value === "string" && /[:#[\]'"]/.test(value) ? `'${value.replace(/'/g, "''")}'` : value}`);
    }
  }
  lines.push("---", body, "");
  return lines.join("\n");
}

function yamlBlock(value, indent) {
  const pad = " ".repeat(indent);
  const lines = [];
  for (const [key, entry] of Object.entries(value)) {
    if (entry === null) {
      lines.push(`${pad}${key}: null`);
    } else if (typeof entry === "object" && !Array.isArray(entry)) {
      lines.push(`${pad}${key}:`);
      lines.push(yamlBlock(entry, indent + 2));
    } else if (Array.isArray(entry)) {
      lines.push(`${pad}${key}: [${entry.join(", ")}]`);
    } else {
      lines.push(`${pad}${key}: ${entry}`);
    }
  }
  return lines.join("\n");
}

// ── Package templates ────────────────────────────────────────────────

await withRoot(async (_dir, project) => {
  const registry = discoverShadowDefinitions(project, { projectTrusted: false });
  assert.deepEqual(
    registry.definitions.map((definition) => definition.id),
    TEMPLATE_IDS,
    "the six package templates must be the only definitions in a clean install",
  );
  assert.equal(registry.invalid.length, 0, JSON.stringify(registry.invalid));
  assert.equal(registry.diagnostics.length, 0, JSON.stringify(registry.diagnostics));
  for (const definition of registry.definitions) {
    assert.equal(definition.enabled, false, `${definition.id} must ship disabled`);
    assert.equal(definition.priority, 0);
    assert.equal(definition.hidden, false);
    assert.equal(definition.completionGate, definition.id === "completion-check");
    assert.ok(definition.body.trim().length > 0);
    assert.equal(definition.fieldSources.name.scope, "package");
    assert.equal(definition.fieldSources.body.scope, "package");
    assert.equal(definition.layers.length, 1);
    assert.equal(definition.layers[0].scope, "package");
  }
  const byId = Object.fromEntries(registry.definitions.map((definition) => [definition.id, definition]));
  assert.deepEqual(byId["project-grounding"].triggers, ["tool_turn", "completion"]);
  assert.equal(byId["project-grounding"].delivery, "steer");
  assert.deepEqual(byId["architecture-lens"].triggers, ["mutation", "completion"]);
  assert.deepEqual(byId["completion-check"].triggers, ["completion"]);
  assert.equal(byId["completion-check"].delivery, "wake");
  assert.deepEqual(byId["alternative-explorer"].triggers, ["tool_turn"]);
  assert.equal(byId["alternative-explorer"].delivery, "notify");
  assert.equal(byId["research-scout"].triggers.length, 0, "research-scout ships without automatic triggers");
  assert.equal(byId["research-scout"].delivery, "notify");
  assert.deepEqual(byId["session-synthesizer"].tools, [], "session-synthesizer requests no investigation tools");
  assert.deepEqual(byId["session-synthesizer"].outputSchema.required, ["decisions", "progress", "open_questions"]);
  assert.ok(!byId["research-scout"].tools?.includes("search"), "research-scout has no remote tool by default");
});

// ── Layered merge, provenance, and clearing semantics ────────────────

await withRoot(async (dir, project) => {
  write(
    join(dir, "agent", "shadow-minds", "project-grounding.md"),
    definitionFile(
      { id: "project-grounding", name: "Project grounding", enabled: true, priority: 5, triggerInstructions: { tool_turn: "Focus on the newest evidence." } },
      "Agent-local body for grounding.",
    ),
  );
  write(
    join(project, ".pi", "shadow-minds", "project-grounding.md"),
    definitionFile(
      { id: "project-grounding", name: "Project grounding (project)", delivery: "notify", triggerInstructions: { tool_turn: null, completion: "Check the wrap-up." } },
      "",
    ),
  );

  const registry = discoverShadowDefinitions(project, { projectTrusted: true });
  const grounding = registry.definitions.find((definition) => definition.id === "project-grounding");
  assert.ok(grounding, "grounding stays present");
  assert.equal(grounding.name, "Project grounding (project)", "project layer wins scalar fields");
  assert.equal(grounding.enabled, true, "agent layer applies where the project omits");
  assert.equal(grounding.priority, 5);
  assert.equal(grounding.delivery, "notify");
  assert.deepEqual(grounding.triggerInstructions, { completion: "Check the wrap-up." }, "null clears a trigger key and new keys merge");
  assert.equal(grounding.fieldSources.name.scope, "project");
  assert.equal(grounding.fieldSources.enabled.scope, "agent");
  assert.equal(grounding.fieldSources["triggerInstructions.completion"].scope, "project");
  assert.equal(grounding.body, "Agent-local body for grounding.\n", "the highest provided body replaces the package body");
  assert.equal(grounding.fieldSources.body.scope, "agent");
  assert.equal(grounding.layers.length, 3, "package + agent + project layers all contribute");
  assert.equal(grounding.layers[0].scope, "package");
  assert.equal(grounding.layers[2].scope, "project");
});

// ── Output-schema replacement and default restoration ────────────────

await withRoot(async (dir, project) => {
  write(
    join(dir, "agent", "shadow-minds", "session-synthesizer.md"),
    definitionFile({
      id: "session-synthesizer",
      name: "Session synthesizer",
      outputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { note: { type: "string", maxLength: 100 } },
        required: ["note"],
      },
    }),
  );
  let registry = discoverShadowDefinitions(project, { projectTrusted: true });
  let synthesizer = registry.definitions.find((definition) => definition.id === "session-synthesizer");
  assert.deepEqual(synthesizer.outputSchema.required, ["note"], "a higher layer replaces the schema atomically");

  write(
    join(project, ".pi", "shadow-minds", "session-synthesizer.md"),
    definitionFile({ id: "session-synthesizer", name: "Session synthesizer", outputSchema: null }),
  );
  registry = discoverShadowDefinitions(project, { projectTrusted: true });
  synthesizer = registry.definitions.find((definition) => definition.id === "session-synthesizer");
  assert.deepEqual(synthesizer.outputSchema.required, ["summary"], "explicit null restores the default schema");
  assert.equal(synthesizer.fieldSources.outputSchema.scope, "project");
});

// ── New definitions default to the documented starting shape ─────────

await withRoot(async (dir, project) => {
  write(
    join(dir, "agent", "shadow-minds", "my-shadow.md"),
    definitionFile({ id: "my-shadow", name: "My Shadow" }),
  );
  const registry = discoverShadowDefinitions(project, { projectTrusted: true });
  const mine = registry.definitions.find((definition) => definition.id === "my-shadow");
  assert.ok(mine);
  assert.equal(mine.enabled, false);
  assert.equal(mine.priority, 0);
  assert.deepEqual(mine.triggers, []);
  assert.equal(mine.delivery, "steer");
  assert.equal(mine.completionGate, false);
  assert.equal(mine.parentModels, undefined);
  assert.equal(mine.model, undefined);
  assert.equal(mine.debug, false);
  assert.deepEqual(mine.requiredTools, []);
  assert.equal(mine.tools, undefined, "omitted tools keep the default local read-only set unresolved until #156");
  assert.deepEqual([...DEFAULT_SHADOW_LOCAL_TOOLS], ["read", "grep", "find", "ls", "codegraph", "pdf_search"]);
});

// ── Untrusted project exclusion ──────────────────────────────────────

await withRoot(async (dir, project) => {
  write(
    join(project, ".pi", "shadow-minds", "project-grounding.md"),
    definitionFile({ id: "project-grounding", name: "Hijacked" }),
  );
  const registry = discoverShadowDefinitions(project, { projectTrusted: false });
  const grounding = registry.definitions.find((definition) => definition.id === "project-grounding");
  assert.equal(grounding.name, "Project grounding", "untrusted project layers never contribute");
  assert.equal(grounding.layers.length, 1);
  assert.equal(grounding.fieldSources.name.scope, "package");
  assert.ok(
    registry.diagnostics.some((entry) => /not trusted/.test(entry.message)),
    "an untrusted project layer is diagnosed",
  );
});

// ── Per-ID fail-closed isolation ─────────────────────────────────────

await withRoot(async (dir, project) => {
  write(
    join(dir, "agent", "shadow-minds", "broken.md"),
    "---\npromptVersion: 1\nid: broken\nname: Broken\nunknown: field\n---\n\nBody.\n",
  );
  write(
    join(dir, "agent", "shadow-minds", "empty-body.md"),
    "---\npromptVersion: 1\nid: empty-body\nname: Empty body\n---\n",
  );
  write(
    join(dir, "agent", "shadow-minds", "gateless.md"),
    definitionFile({ id: "gateless", name: "Gateless", completionGate: true }),
  );
  write(
    join(dir, "agent", "shadow-minds", "needs-shell.md"),
    definitionFile({ id: "needs-shell", name: "Needs shell", tools: ["read"], requiredTools: ["shell"] }),
  );
  write(
    join(dir, "agent", "shadow-minds", "healthy.md"),
    definitionFile({ id: "healthy", name: "Healthy" }),
  );

  const registry = discoverShadowDefinitions(project, { projectTrusted: true });
  assert.equal(registry.invalid.length, 4);
  const invalidById = Object.fromEntries(registry.invalid.map((entry) => [entry.id, entry]));
  assert.ok(invalidById.broken.errors.some((message) => /unknown field 'unknown'/.test(message)));
  assert.ok(invalidById["empty-body"].errors.some((message) => /explicitly empty/.test(message)));
  assert.ok(invalidById.gateless.errors.some((message) => /completionGate requires/.test(message)));
  assert.ok(invalidById["needs-shell"].errors.some((message) => /outside the final tool set/.test(message)));
  for (const entry of registry.invalid) {
    assert.ok(entry.sources.length >= 1);
  }
  assert.ok(
    registry.definitions.find((definition) => definition.id === "healthy"),
    "valid definitions remain inspectable next to invalid ones",
  );
  assert.ok(
    registry.definitions.find((definition) => definition.id === "project-grounding"),
    "package definitions remain inspectable next to invalid agent ones",
  );
  assert.equal(registry.diagnostics.length, registry.invalid.length, "every invalid definition carries a diagnostic");
});

// ── A broken layer invalidates the whole effective ID ────────────────

await withRoot(async (dir, project) => {
  write(
    join(dir, "agent", "shadow-minds", "project-grounding.md"),
    "---\npromptVersion: 1\nid: project-grounding\nname: Broken overlay\nunknown: field\n---\n\nAgent body.\n",
  );
  const registry = discoverShadowDefinitions(project, { projectTrusted: true });
  assert.ok(
    !registry.definitions.some((definition) => definition.id === "project-grounding"),
    "a broken overlay must not silently continue the package behavior for the same ID",
  );
  const invalid = registry.invalid.find((entry) => entry.id === "project-grounding");
  assert.ok(invalid, "the broken ID is reported as invalid");
  assert.ok(invalid.errors.some((message) => /unknown field 'unknown'/.test(message)));
  assert.ok(
    registry.definitions.some((definition) => definition.id === "completion-check"),
    "unrelated IDs stay effective",
  );
});

// ── Uppercase .MD files are discovered like lowercase ones ───────────

await withRoot(async (dir, project) => {
  write(
    join(dir, "agent", "shadow-minds", "caps.MD"),
    "---\npromptVersion: 1\nid: caps\nname: Caps\n---\n\nBody.\n",
  );
  const registry = discoverShadowDefinitions(project, { projectTrusted: true });
  assert.ok(registry.definitions.some((definition) => definition.id === "caps"), "a .MD file parses and merges");
});

// ── Body inheritance from the package layer ──────────────────────────

await withRoot(async (dir, project) => {
  write(
    join(dir, "agent", "shadow-minds", "completion-check.md"),
    definitionFile({ id: "completion-check", name: "Completion check", priority: 2 }, ""),
  );
  const registry = discoverShadowDefinitions(project, { projectTrusted: true });
  const check = registry.definitions.find((definition) => definition.id === "completion-check");
  assert.ok(check.body.includes("Check the finished answer"), "an overlay without a body inherits the package body");
  assert.equal(check.fieldSources.body.scope, "package");
  assert.equal(check.priority, 2);
});

console.log("shadow-minds definitions tests: OK");
