import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import jiti from "jiti";

const packageRoot = resolve(import.meta.dirname, "..", "..");
const load = jiti(import.meta.url, { moduleCache: false });
const {
  discoverShadowDefinitions,
  shadowDefinitionScopeDir,
} = await load(join(packageRoot, "src", "shadow-minds", "definitions.ts"));
const { SHADOW_DEFAULT_TOOLS } = await load(join(packageRoot, "src", "shadow-minds", "parser.ts"));

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
  const lines = ["---", "promptVersion: 1", `id: ${fields.id}`];
  if (fields.name !== undefined) lines.push(`name: ${fields.name}`);
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

// ── Two user-owned scopes; packaged assets are never discovered (#188) ─

await withRoot(async (_dir, project) => {
  const registry = discoverShadowDefinitions(project);
  assert.deepEqual(registry.definitions, [], "a clean install discovers no definitions");
  assert.deepEqual(registry.invalid, []);
  assert.deepEqual(registry.diagnostics, [], "no package layer or trust diagnostics exist");
});

// ── Layered merge, provenance, and clearing semantics ────────────────

await withRoot(async (dir, project) => {
  const agent = join(dir, "agent", "shadow-minds");
  write(
    join(agent, "grounding.md"),
    definitionFile({
      id: "grounding",
      name: "Project grounding",
      enabled: true,
      priority: 5,
      triggers: ["tool_turn", "completion"],
      triggerInstructions: { tool_turn: "Ground tool output in the repo.", completion: "Check the finished answer." },
      delivery: "steer",
      tools: ["read", "grep", "find"],
      requiredTools: ["read"],
    }, "Agent-base body for grounding."),
  );
  write(
    join(project, ".pi", "shadow-minds", "grounding.md"),
    definitionFile({
      id: "grounding",
      name: "Grounding overlay",
      priority: 9,
      triggerInstructions: { tool_turn: null, completion: "Overlay completion check." },
      tools: [],
      requiredTools: [],
    }, "Agent-local body for grounding."),
  );

  const registry = discoverShadowDefinitions(project);
  assert.equal(registry.invalid.length, 0, JSON.stringify(registry.invalid));
  assert.equal(registry.definitions.length, 1);
  const grounding = registry.definitions[0];
  assert.equal(grounding.id, "grounding");
  assert.equal(grounding.name, "Grounding overlay", "the project overlay wins scalar fields");
  assert.equal(grounding.enabled, true, "unmentioned fields inherit the agent base");
  assert.equal(grounding.priority, 9);
  assert.equal(grounding.delivery, "steer");
  assert.deepEqual(grounding.triggers, ["tool_turn", "completion"]);
  assert.deepEqual(
    grounding.triggerInstructions,
    { completion: "Overlay completion check." },
    "trigger instructions merge per key; null removes one key",
  );
  assert.deepEqual(grounding.tools, [], "an explicit empty list replaces the inherited list");
  assert.deepEqual(grounding.requiredTools, [], "every explicit empty list replaces its inherited list");
  assert.equal(grounding.body, "Agent-local body for grounding.", "the highest provided body replaces the base body (edge-trimmed)");
  assert.equal(grounding.layers.length, 2, "agent base + project overlay both contribute");
  assert.equal(grounding.layers[0].scope, "agent", "the agent layer is the base");
  assert.equal(grounding.layers[1].scope, "project", "the project overlay is the top layer");
  assert.equal(grounding.fieldSources.name.scope, "project");
  assert.equal(grounding.fieldSources.enabled.scope, "agent", "unmentioned fields keep base provenance");
  assert.equal(grounding.fieldSources["triggerInstructions.tool_turn"].scope, "project", "the clearing overlay owns the cleared key's provenance");
});

// ── Output-schema replacement and default restoration ────────────────

await withRoot(async (dir, project) => {
  const agent = join(dir, "agent", "shadow-minds");
  const customSchema = {
    type: "object",
    properties: { findings: { type: "array", items: { type: "string", maxLength: 500 } } },
    required: ["findings"],
    additionalProperties: false,
  };
  write(
    join(agent, "schema-probe.md"),
    definitionFile({ id: "schema-probe", name: "Schema probe", outputSchema: customSchema }),
  );
  const overlay = join(project, ".pi", "shadow-minds", "schema-probe.md");

  let registry = discoverShadowDefinitions(project);
  assert.equal(registry.definitions[0].outputSchema.properties.findings.type, "array");
  assert.equal(registry.definitions[0].fieldSources.outputSchema.scope, "agent");

  write(overlay, definitionFile({ id: "schema-probe", name: "Schema overlay", outputSchema: { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"], additionalProperties: false } }));
  registry = discoverShadowDefinitions(project);
  assert.equal(registry.definitions[0].outputSchema.properties.verdict.type, "string", "outputSchema is replaced atomically, never field-merged");
  assert.equal(registry.definitions[0].fieldSources.outputSchema.scope, "project");

  write(overlay, definitionFile({ id: "schema-probe", name: "Schema overlay", outputSchema: null }));
  registry = discoverShadowDefinitions(project);
  assert.deepEqual(
    registry.definitions[0].outputSchema,
    { type: "object", properties: { summary: { type: "string", minLength: 1, maxLength: 12000 } }, required: ["summary"], additionalProperties: false },
    "outputSchema: null restores the default summary schema",
  );

  write(overlay, definitionFile({ id: "schema-probe", name: "Schema overlay" }));
  registry = discoverShadowDefinitions(project);
  assert.deepEqual(
    registry.definitions[0].outputSchema.properties,
    { findings: { type: "array", items: { type: "string", maxLength: 500 } } },
    "an overlay that never mentions outputSchema keeps the base schema",
  );
});

// ── New definitions default to the documented starting shape ─────────

await withRoot(async (dir, _project) => {
  write(
    join(dir, "agent", "shadow-minds", "fresh.md"),
    definitionFile({ id: "fresh", name: "Fresh" }),
  );
  const registry = discoverShadowDefinitions(join(dir, "project"));
  assert.equal(registry.definitions.length, 1);
  const fresh = registry.definitions[0];
  assert.equal(fresh.enabled, false, "definitions stay disabled until their files enable them");
  assert.equal(fresh.hidden, false);
  assert.equal(fresh.priority, 0);
  assert.deepEqual(fresh.triggers, []);
  assert.equal(fresh.delivery, "steer");
  assert.equal(fresh.completionGate, false);
  assert.equal(fresh.debug, false);
  // Omitted `tools` stays absent in the effective definition: the default
  // local evidence set resolves at run assembly (tools.ts), not in discovery.
  assert.equal(fresh.tools, undefined, "an omitted tools list defers to the runtime default set");
  assert.deepEqual([...SHADOW_DEFAULT_TOOLS], ["read", "grep", "find", "ls"]);
  assert.deepEqual(fresh.requiredTools, []);
  assert.equal(fresh.timeoutSeconds, undefined);
  assert.equal(fresh.maxTurns, undefined);
  assert.equal(fresh.maxToolCalls, undefined);
});

// ── Minimal project overlays inherit agent-base identity and body ────

await withRoot(async (dir, project) => {
  write(
    join(dir, "agent", "shadow-minds", "minimal.md"),
    definitionFile({
      id: "minimal",
      name: "Minimal base",
      enabled: false,
      triggers: ["tool_turn"],
    }, "Agent-base body for minimal."),
  );
  write(
    join(project, ".pi", "shadow-minds", "minimal.md"),
    definitionFile({ id: "minimal", enabled: true }, ""),
  );
  const registry = discoverShadowDefinitions(project);
  assert.equal(registry.invalid.length, 0, JSON.stringify(registry.invalid));
  const minimal = registry.definitions[0];
  assert.ok(minimal, "a minimal overlay must keep the agent-base definition effective");
  assert.equal(minimal.name, "Minimal base", "identity inherits from the agent base");
  assert.equal(minimal.enabled, true, "the overlay still overrides what it names");
  assert.equal(minimal.body, "Agent-base body for minimal.", "the body inherits from the agent base");
  assert.equal(minimal.fieldSources.name.scope, "agent");
  assert.equal(minimal.fieldSources.enabled.scope, "project");
});

// ── Project-only complete IDs participate without any trust concept ──

await withRoot(async (dir, project) => {
  write(
    join(project, ".pi", "shadow-minds", "project-only.md"),
    definitionFile({
      id: "project-only",
      name: "Project-only Shadow",
      triggers: ["failure"],
      delivery: "notify",
      tools: ["read", "ls"],
    }, "Fully owned by this project."),
  );
  // No agent base exists: the project file must be complete on its own.
  const registry = discoverShadowDefinitions(project);
  assert.equal(registry.invalid.length, 0, JSON.stringify(registry.invalid));
  assert.equal(registry.definitions.length, 1);
  assert.equal(registry.definitions[0].id, "project-only");
  assert.equal(registry.definitions[0].name, "Project-only Shadow");
  assert.deepEqual(registry.definitions[0].triggers, ["failure"]);
  assert.deepEqual(registry.definitions[0].tools, ["read", "ls"]);
  assert.equal(registry.diagnostics.length, 0, "project participation produces no trust diagnostics");
});

// ── Nearest project directory wins; outer projects are ignored ───────

await withRoot(async (dir, project) => {
  const inner = join(project, "inner");
  write(
    join(project, ".pi", "shadow-minds", "outer.md"),
    definitionFile({ id: "outer", name: "Outer Shadow" }),
  );
  write(
    join(inner, ".pi", "shadow-minds", "inner.md"),
    definitionFile({ id: "inner", name: "Inner Shadow" }),
  );
  const registry = discoverShadowDefinitions(inner);
  assert.deepEqual(
    registry.definitions.map((definition) => definition.id),
    ["inner"],
    "discovery stops at the nearest .pi/shadow-minds; outer scopes are ignored",
  );
});

// ── Project paths remain canonical and workspace-bounded ─────────────

await withRoot(async (dir, project) => {
  const outsideFile = join(dir, "outside", "escaped.md");
  mkdirSync(join(project, ".pi", "shadow-minds"), { recursive: true });
  mkdirSync(join(dir, "outside"), { recursive: true });
  writeFileSync(outsideFile, definitionFile({ id: "escaped", name: "Escaped" }));
  symlinkSync(outsideFile, join(project, ".pi", "shadow-minds", "escaped.md"));
  write(
    join(project, ".pi", "shadow-minds", "kept.md"),
    definitionFile({ id: "kept", name: "Kept" }),
  );
  const registry = discoverShadowDefinitions(project);
  assert.equal(registry.definitions.length, 1, "the symlinked escape is not discovered");
  assert.equal(registry.definitions[0].id, "kept");
  assert.ok(
    registry.invalid.some((entry) => entry.id === "escaped"),
    "the escaped file is reported as an invalid ID",
  );
});

// ── Per-ID fail-closed isolation ─────────────────────────────────────

await withRoot(async (dir, project) => {
  const agent = join(dir, "agent", "shadow-minds");
  write(join(agent, "good.md"), definitionFile({ id: "good", name: "Good" }));
  write(join(agent, "broken.md"), "---\npromptVersion: 1\nid: broken\nname: Broken\nbogus: value\n---\nBody");
  write(
    join(project, ".pi", "shadow-minds", "also-good.md"),
    definitionFile({ id: "also-good", name: "Also good", triggers: ["completion"] }),
  );
  const registry = discoverShadowDefinitions(project);
  assert.deepEqual(
    registry.definitions.map((definition) => definition.id),
    ["also-good", "good"],
    "invalid definitions are excluded while unrelated valid IDs stay active",
  );
  assert.equal(registry.invalid.length, 1);
  assert.equal(registry.invalid[0].id, "broken");
  assert.ok(registry.invalid[0].errors.some((message) => message.includes("unknown field 'bogus'")));
  assert.ok(
    registry.diagnostics.some((entry) => entry.message.includes("Shadow definition 'broken' is excluded")),
    "exclusions are diagnosed visibly",
  );
});

// ── Same-scope duplicate files invalidate the whole ID ───────────────

await withRoot(async (dir, project) => {
  const agent = join(dir, "agent", "shadow-minds");
  write(join(agent, "dup.md"), definitionFile({ id: "dup", name: "Dup one" }));
  // Agent + project layers for one ID still merge.
  mkdirSync(join(project, ".pi", "shadow-minds"), { recursive: true });
  write(join(project, ".pi", "shadow-minds", "dup.md"), definitionFile({ id: "dup", name: "Dup project" }));
  let registry = discoverShadowDefinitions(project);
  assert.equal(registry.definitions.length, 1, "agent + project layers for one ID still merge");

  // Now claim the same ID twice inside the agent scope via case variants.
  write(join(agent, "dup.MD"), definitionFile({ id: "dup", name: "Dup case" }));
  registry = discoverShadowDefinitions(project);
  assert.equal(registry.definitions.length, 0, "the same-scope conflict invalidates the ID");
  assert.equal(registry.invalid.length, 1);
  assert.equal(registry.invalid[0].id, "dup");
  assert.equal(registry.invalid[0].sources.length, 2, "every claiming file is reported");
});

// ── A broken layer invalidates the whole effective ID ────────────────

await withRoot(async (dir, project) => {
  write(
    join(dir, "agent", "shadow-minds", "keep-base.md"),
    definitionFile({ id: "keep-base", name: "Keep base", triggers: ["tool_turn"] }),
  );
  write(
    join(project, ".pi", "shadow-minds", "keep-base.md"),
    definitionFile({ id: "keep-base", name: "Keep overlay", priority: "not-a-number" }),
  );
  const registry = discoverShadowDefinitions(project);
  assert.equal(registry.definitions.length, 0, "a broken overlay must not silently continue the agent-base behavior");
  assert.equal(registry.invalid.length, 1);
  assert.equal(registry.invalid[0].id, "keep-base");
});

// ── Effective completeness gates activation ─────────────────────────

await withRoot(async (dir, project) => {
  const agent = join(dir, "agent", "shadow-minds");
  // No layer ever provides a name: the effective definition is incomplete.
  write(join(agent, "nameless.md"), definitionFile({ id: "nameless" }, ""));
  write(
    join(project, ".pi", "shadow-minds", "nameless.md"),
    definitionFile({ id: "nameless", priority: 1 }, ""),
  );
  // completionGate without a completion subscription.
  write(join(agent, "gated.md"), definitionFile({ id: "gated", name: "Gated", completionGate: true }));
  // requiredTools outside the final tool set.
  write(join(agent, "required.md"), definitionFile({ id: "required", name: "Required", tools: ["read"], requiredTools: ["grep"] }));
  // Empty effective body.
  write(join(agent, "bodiless.md"), definitionFile({ id: "bodiless", name: "Bodiless" }, ""));
  const registry = discoverShadowDefinitions(project);
  assert.equal(registry.definitions.length, 0);
  const ids = registry.invalid.map((entry) => entry.id).sort();
  assert.deepEqual(ids, ["bodiless", "gated", "nameless", "required"]);
  const byId = new Map(registry.invalid.map((entry) => [entry.id, entry]));
  assert.ok(byId.get("nameless").errors.some((message) => message.includes("effective name is missing")));
  assert.ok(byId.get("gated").errors.some((message) => message.includes("completionGate requires a completion trigger")));
  assert.ok(byId.get("required").errors.some((message) => message.includes("required tool 'grep' is outside the final tool set")));
  assert.ok(byId.get("bodiless").errors.some((message) => message.includes("effective body is explicitly empty")));
});

// ── Uppercase .MD files are discovered like lowercase ones ───────────

await withRoot(async (dir, project) => {
  write(join(dir, "agent", "shadow-minds", "upper.MD"), definitionFile({ id: "upper", name: "Upper" }));
  const registry = discoverShadowDefinitions(project);
  assert.equal(registry.definitions.length, 1);
  assert.equal(registry.definitions[0].id, "upper");
});

// ── Filename and frontmatter id must match exactly ───────────────────

await withRoot(async (dir, project) => {
  write(
    join(dir, "agent", "shadow-minds", "real-name.md"),
    definitionFile({ id: "different-id", name: "Mismatch" }),
  );
  const registry = discoverShadowDefinitions(project);
  assert.equal(registry.definitions.length, 0);
  assert.equal(registry.invalid[0].id, "real-name");
  assert.ok(
    registry.invalid[0].errors.some((message) => message.includes("must equal the Markdown filename stem")),
  );
});

// ── Scope-directory targeting still follows discovery ────────────────

await withRoot(async (dir, project) => {
  assert.equal(
    shadowDefinitionScopeDir("agent", project),
    join(dir, "agent", "shadow-minds"),
    "the agent scope targets the Pi agent directory",
  );
  assert.equal(
    shadowDefinitionScopeDir("project", project),
    join(project, ".pi", "shadow-minds"),
    "a workspace without an existing overlay targets .pi/shadow-minds",
  );
  mkdirSync(join(project, ".pi", "shadow-minds"), { recursive: true });
  const inner = join(project, "nested");
  mkdirSync(inner, { recursive: true });
  assert.equal(
    shadowDefinitionScopeDir("project", inner),
    join(project, ".pi", "shadow-minds"),
    "writes follow the nearest discovered project scope",
  );
});

console.log("shadow-minds definitions tests: OK");
