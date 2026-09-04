import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import jiti from "jiti";

const load = jiti(import.meta.url, { moduleCache: false });
const pi = resolve(import.meta.dirname, "..", "..");

const {
  SHADOW_DEFAULT_TOOLS,
  SHADOW_SAFE_TOOLS,
  SHADOW_BUILTIN_BASE_ORDER,
  SHADOW_EXTENSION_BASE_ORDER,
  resolveShadowTools,
} = await load(resolve(pi, "src/shadow-minds/tools.ts"));
const { canonicalSchemaJson } = await load(resolve(pi, "src/shadow-minds/prompt.ts"));
const { SUBMIT_SHADOW_RESULT_PARAMETERS } = await load(resolve(pi, "src/shadow-minds/result.ts"));

const cwd = process.cwd();

function ok(input) {
  const outcome = resolveShadowTools(input);
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  return outcome.envelope;
}

// ── AC1: defaults, explicit empty, subset rule ──────────────────────

{
  // Omitted tools default to the local read-only evidence set.
  const envelope = ok({ cwd });
  assert.deepEqual(envelope.toolNames, ["read", "grep", "find", "ls"]);
  assert.deepEqual(envelope.customTools, []);
  assert.deepEqual(envelope.warnings, []);
}

{
  // An explicit empty list stays the no-tool trial.
  const envelope = ok({ cwd, tools: [] });
  assert.deepEqual(envelope.toolNames, []);
  assert.deepEqual(envelope.customTools, []);
}

{
  // requiredTools must be a subset of the requested set.
  const outcome = resolveShadowTools({ cwd, tools: ["read"], requiredTools: ["read", "grep"] });
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /requiredTools must be a subset/i);
  assert.match(outcome.error, /grep/);
}

{
  // Required tools present in the requested set resolve normally.
  const envelope = ok({ cwd, tools: ["read", "grep"], requiredTools: ["grep"] });
  assert.deepEqual(envelope.toolNames, ["read", "grep"]);
}

// ── AC3: catalog membership ─────────────────────────────────────────

{
  // Every Shadow-safe tool resolves.
  const envelope = ok({ cwd, tools: [...SHADOW_SAFE_TOOLS] });
  assert.deepEqual(envelope.toolNames, [
    "read", "grep", "find", "ls",
    "pdf_search", "search", "fetch", "libs", "docs",
  ]);
  assert.deepEqual(envelope.customTools.map((tool) => tool.name), [
    "pdf_search", "search", "fetch", "libs", "docs",
  ]);
}

{
  // Excluded capabilities are not in the catalog and drop with a warning.
  for (const excluded of ["bash", "shell", "pwsh", "write", "edit", "replace", "revert", "ssh", "parse", "delegate", "resume", "todo", "ask"]) {
    const envelope = ok({ cwd, tools: ["read", excluded] });
    assert.deepEqual(envelope.toolNames, ["read"], excluded);
    assert.equal(envelope.warnings.length, 1, excluded);
    assert.match(envelope.warnings[0], new RegExp(`'${excluded}'`), excluded);
  }
}

{
  // A required excluded tool fails the run before prompting.
  const outcome = resolveShadowTools({ cwd, tools: ["read", "bash"], requiredTools: ["bash"] });
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /Required Shadow tools are unavailable: bash/);
}

// ── AC4: canonical ordering and stable hashing ──────────────────────

{
  // Definition text order never changes the envelope or its hash.
  const forward = ok({ cwd, tools: ["docs", "search", "ls", "read", "pdf_search"] });
  const reverse = ok({ cwd, tools: ["pdf_search", "read", "ls", "search", "docs"] });
  assert.deepEqual(forward.toolNames, ["read", "ls", "pdf_search", "search", "docs"]);
  assert.equal(forward.schemaHash, reverse.schemaHash);
}

{
  // Different tool sets produce different hashes.
  const withGrep = ok({ cwd, tools: ["read", "grep"] });
  const withoutGrep = ok({ cwd, tools: ["read"] });
  assert.notEqual(withGrep.schemaHash, withoutGrep.schemaHash);
}

{
  // The hash is stable across working directories.
  const here = ok({ cwd, tools: ["read", "pdf_search"] });
  const elsewhere = ok({ cwd: "/tmp/elsewhere", tools: ["read", "pdf_search"] });
  assert.equal(here.schemaHash, elsewhere.schemaHash);
}

{
  // The hash covers the complete model-visible envelope, submit tool included.
  const envelope = ok({ cwd, tools: ["read"] });
  const read = (await load("@earendil-works/pi-coding-agent")).createReadToolDefinition(cwd);
  const { createSubmitShadowResultTool } = await load(resolve(pi, "src/shadow-minds/result.ts"));
  const submit = createSubmitShadowResultTool({ schema: { type: "object", additionalProperties: false }, onAccepted() {} });
  const expected = createHash("sha256").update(canonicalSchemaJson([
    { name: read.name, description: read.description, parameters: read.parameters },
    { name: submit.name, description: submit.description, parameters: submit.parameters },
  ])).digest("hex").slice(0, 16);
  assert.equal(envelope.schemaHash, expected);
}

// ── AC2: factory sources, never the parent registry ─────────────────

{
  // Built-ins come from Pi public factories: the hashed model-visible shape
  // equals a factory-fresh definition, and resolution accepts no registry.
  const { createReadToolDefinition } = await load("@earendil-works/pi-coding-agent");
  const { createSubmitShadowResultTool } = await load(resolve(pi, "src/shadow-minds/result.ts"));
  const read = createReadToolDefinition(cwd);
  const submit = createSubmitShadowResultTool({ schema: { type: "object", additionalProperties: false }, onAccepted() {} });
  const envelope = ok({ cwd, tools: ["read"] });
  const canonical = createHash("sha256").update(canonicalSchemaJson([
    { name: read.name, description: read.description, parameters: read.parameters },
    { name: submit.name, description: submit.description, parameters: submit.parameters },
  ])).digest("hex").slice(0, 16);
  assert.equal(envelope.schemaHash, canonical);
}

{
  // Extension tools come from the child-safe read-only factories: the
  // Shadow envelope only ever receives catalog definitions, never a
  // shell definition even when adjacent names are requested.
  const envelope = ok({ cwd, tools: ["pdf_search", "search"] });
  assert.equal(envelope.customTools.length, 2);
  for (const tool of envelope.customTools) {
    assert.equal(SHADOW_EXTENSION_BASE_ORDER.includes(tool.name), true);
  }
}

{
  // Duplicates in a requested list resolve once.
  const envelope = ok({ cwd, tools: ["read", "read", "grep"] });
  assert.deepEqual(envelope.toolNames, ["read", "grep"]);
}

// Base order constants document the package-defined canonical order.
assert.deepEqual(SHADOW_BUILTIN_BASE_ORDER, ["read", "grep", "find", "ls"]);
assert.deepEqual(SHADOW_DEFAULT_TOOLS, ["read", "grep", "find", "ls"]);

console.log("shadow-minds tools tests: OK");
