import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import jiti from "jiti";

// #189: `/shadow <request>` authorizes ordinary file work. These flows are
// exactly what the Guide instructs the parent to do — plain writes in the
// two scopes, plain rewrites for modification, platform-shell deletion, an
// explicit master-switch enable that preserves unrelated agent settings —
// verified through production discovery and the production config loader.

const packageRoot = resolve(import.meta.dirname, "..", "..");
const load = jiti(import.meta.url, { moduleCache: false });

const dir = mkdtempSync(join(tmpdir(), "pi-square-shadow-flows-"));
const agentDir = join(dir, "agent");
const project = join(dir, "project");
mkdirSync(join(agentDir, "shadow-minds"), { recursive: true });
mkdirSync(project, { recursive: true });
process.env.PI_AGENT_DIR = agentDir;
process.env.PI_CODING_AGENT_DIR = agentDir;

const { discoverShadowDefinitions } = await load(join(packageRoot, "src", "shadow-minds", "definitions.ts"));
const { loadConfig } = await load(join(packageRoot, "src", "core", "config.ts"));

try {
const agentScope = join(agentDir, "shadow-minds");
const projectScope = join(project, ".pi", "shadow-minds");

function effective(id) {
  const registry = discoverShadowDefinitions(project);
  return registry.definitions.find((definition) => definition.id === id);
}

function invalidFor(id) {
  const registry = discoverShadowDefinitions(project);
  return registry.invalid.find((entry) => entry.id === id);
}

function writeDefinition(scopeDir, id, lines) {
  mkdirSync(scopeDir, { recursive: true });
  writeFileSync(join(scopeDir, `${id}.md`), lines.join("\n"), "utf8");
}

// ── Create in both scopes; the minimal overlay completes against the base ──

writeDefinition(agentScope, "flow-role", [
  "---",
  "promptVersion: 1",
  "id: flow-role",
  "name: Flow role",
  "tools: [read]",
  "---",
  "Watch the flows.",
  "",
]);
writeDefinition(projectScope, "flow-role", [
  "---",
  "promptVersion: 1",
  "id: flow-role",
  "enabled: true",
  "---",
  "",
]);

{
  const merged = effective("flow-role");
  assert.ok(merged, "the agent base plus minimal project overlay is discoverable");
  assert.equal(merged.enabled, true, "the overlay enables the base");
  assert.equal(merged.tools[0], "read", "omitted overlay fields inherit from the base");
  assert.equal(merged.body, "Watch the flows.", "an empty overlay body inherits the base body");
  assert.deepEqual(merged.layers.map((layer) => layer.scope), ["agent", "project"]);
}

// ── Modify through an ordinary rewrite; deletion through the shell ─────

{
  writeDefinition(projectScope, "flow-role", [
    "---",
    "promptVersion: 1",
    "id: flow-role",
    "enabled: true",
    "triggers: [completion]",
    "delivery: notify",
    "---",
    "Report completion findings.",
    "",
  ]);
  const modified = effective("flow-role");
  assert.deepEqual(modified.triggers, ["completion"], "a rewritten overlay changes the effective triggers");
  assert.equal(modified.delivery, "notify");
  assert.equal(modified.body, "Report completion findings.", "a provided body replaces the base body");

  // The Guide's deletion path: the active platform shell removes the file.
  rmSync(join(projectScope, "flow-role.md"));
  const revealed = effective("flow-role");
  assert.ok(revealed, "the agent base survives the overlay deletion");
  assert.equal(revealed.enabled, false, "deleting the overlay reveals the base defaults");
  assert.deepEqual(revealed.triggers, [], "base-only effective fields return");
  assert.equal(revealed.body, "Watch the flows.");
}

// ── Deleting the base leaves an incomplete overlay diagnosed, not run ──

writeDefinition(projectScope, "incomplete-role", [
  "---",
  "promptVersion: 1",
  "id: incomplete-role",
  "enabled: true",
  "---",
  "",
]);

{
  const registry = discoverShadowDefinitions(project);
  assert.ok(registry.definitions.some((definition) => definition.id === "flow-role"), "unrelated valid IDs keep running");
  const incomplete = invalidFor("incomplete-role");
  assert.ok(incomplete, "a project-only overlay without a base is excluded");
  assert.ok(incomplete.errors.length > 0, "the exclusion carries actionable diagnostics");
}

// ── Deleting the agent base strands a dependent minimal overlay ────────

writeDefinition(agentScope, "stranded-role", [
  "---",
  "promptVersion: 1",
  "id: stranded-role",
  "name: Stranded role",
  "tools: [read]",
  "---",
  "Base body.",
  "",
]);
writeDefinition(projectScope, "stranded-role", [
  "---",
  "promptVersion: 1",
  "id: stranded-role",
  "enabled: true",
  "---",
  "",
]);
{
  assert.ok(effective("stranded-role"), "the dependent overlay is complete while its base exists");

  // The literal base-deletion flow: the platform shell removes the base file.
  rmSync(join(agentScope, "stranded-role.md"));
  const stranded = invalidFor("stranded-role");
  assert.ok(stranded, "deleting the agent base strands the minimal overlay as incomplete");
  assert.ok(stranded.errors.length > 0, "the stranded overlay is diagnosed, never run");
  assert.ok(effective("flow-role"), "unrelated valid IDs keep running");
}

// ── Invalid file recovery through an ordinary rewrite ─────────────────

writeDefinition(agentScope, "broken-role", [
  "---",
  "promptVersion: 1",
  "id: broken-role",
  "name: Broken role",
  "color: red",
  "---",
  "Body.",
  "",
]);

{
  const broken = invalidFor("broken-role");
  assert.ok(broken, "the invalid definition is excluded per ID");
  assert.ok(broken.errors.some((error) => error.includes("color")), "the diagnostic names the unknown field");
  assert.ok(effective("flow-role"), "the unrelated valid definition stays active");

  // Best-effort self-check recovery: rewrite the file with valid content.
  writeDefinition(agentScope, "broken-role", [
    "---",
    "promptVersion: 1",
    "id: broken-role",
    "name: Healed role",
    "tools: [read, grep]",
    "---",
    "Healed body.",
    "",
  ]);
  const healed = effective("broken-role");
  assert.ok(healed, "the rewritten definition returns to the effective catalog");
  assert.equal(healed.name, "Healed role");
}

// ── Explicit enablement preserves unrelated agent settings ────────────

{
  const configPath = join(agentDir, "config", "pi-square.json");
  mkdirSync(join(agentDir, "config"), { recursive: true });
  // The Guide's explicit-enable flow starts from a complete on-disk read,
  // changes only shadowMinds.enabled, and preserves unrelated and nested
  // Shadow defaults rather than constructing a replacement config from memory.
  const before = {
    version: 2,
    banner: { enabled: false },
    display: { motion: "full" },
    anchoredEditing: { enabled: false, autoRead: false },
    shadowMinds: { enabled: false, defaults: { runTimeoutSeconds: 45 } },
  };
  writeFileSync(configPath, `${JSON.stringify(before, null, 2)}\n`, "utf8");
  const complete = JSON.parse(readFileSync(configPath, "utf8"));
  const after = {
    ...complete,
    shadowMinds: { ...complete.shadowMinds, enabled: true },
  };
  writeFileSync(configPath, `${JSON.stringify(after, null, 2)}\n`, "utf8");

  const loaded = loadConfig(project);
  assert.equal(loaded.config.shadowMinds.enabled, true, "an explicit enable request turns the agent-only master on");
  assert.equal(loaded.config.banner.enabled, false, "unrelated banner settings survive");
  assert.equal(loaded.config.display.motion, "full", "unrelated display settings survive");
  assert.deepEqual(loaded.config.anchoredEditing, { enabled: false, autoRead: false }, "unrelated anchored-edit settings survive");
  assert.equal(loaded.config.shadowMinds.defaults.runTimeoutSeconds, 45, "existing Shadow defaults survive the enable-only change");
  assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), after, "the disk rewrite changes no field except the intended master switch");
  assert.ok(loaded.diagnostics.every((entry) => entry.severity !== "error"), "no diagnostics from the preserved rewrite");

  // A project layer can never enable the master switch.
  const projectConfig = join(project, ".pi", "config", "pi-square.json");
  mkdirSync(join(project, ".pi", "config"), { recursive: true });
  writeFileSync(projectConfig, JSON.stringify({ shadowMinds: { enabled: true } }), "utf8");
  const overridden = loadConfig(project);
  assert.equal(overridden.config.shadowMinds.enabled, false, "a project enabled field fails the layer and stays off");

  rmSync(projectConfig);
}

} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log("shadow-minds guide file-flow tests: OK");
