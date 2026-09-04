import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jiti from "jiti";

const load = jiti(import.meta.url, { moduleCache: false });
const { resolveDisplayPolicies, resolveDisplayPolicyForTool } = await load("../../src/display/policy.ts");
const { loadConfig, DEFAULT_CONFIG } = await load("../../src/core/config.ts");
const { DISPLAY_CATALOG } = await load("../../src/display/catalog.ts");
const { DEFAULT_DISPLAY_POLICY, DISPLAY_TOOLS_MAX } = await load("../../src/display/types.ts");

// ── Helper: build a config object with display layers ────────────────

function makeConfig({ agent, project } = {}) {
  const motion = project?.config?.motion ?? agent?.config?.motion ?? "full";
  const config = {
    ...structuredClone(DEFAULT_CONFIG),
    display: {
      motion,
      ...(agent ? { agent: { path: agent.path ?? "/agent/config/pi-square.json", config: agent.config } } : {}),
      ...(project ? { project: { path: project.path ?? "/project/.pi/config/pi-square.json", config: project.config } } : {}),
    },
  };
  return config;
}

function resolve(config) {
  return resolveDisplayPolicies(config);
}

function policyFor(result, toolName) {
  return result.policies.get(toolName);
}

// ── Package defaults ─────────────────────────────────────────────────

{
  const result = resolve(makeConfig({}));
  assert.equal(result.motion, "full");
  assert.equal(result.motionProvenance, "default");
  // Every catalog tool resolves to the default policy with "default" provenance
  assert.equal(result.policies.size, DISPLAY_CATALOG.length);
  const pdf = policyFor(result, "pdf_search");
  assert.deepEqual({ ...pdf.policy }, { ...DEFAULT_DISPLAY_POLICY });
  for (const [, value] of result.policies) {
    for (const prov of Object.values(value.provenance)) {
      assert.equal(prov, "default");
    }
  }
}

// ── Immutability: effective policies are frozen ──────────────────────

{
  const result = resolve(makeConfig({}));
  const pdf = policyFor(result, "pdf_search");
  assert.ok(Object.isFrozen(result), "resolved display must be frozen");
  assert.ok(Object.isFrozen(pdf), "effective policy wrapper must be frozen");
  assert.ok(Object.isFrozen(pdf.policy), "effective policy must be frozen");
  assert.ok(Object.isFrozen(pdf.provenance), "provenance must be frozen");
}

// ── Agent defaults overlay ───────────────────────────────────────────

{
  const result = resolve(makeConfig({
    agent: { config: { defaults: { previewLines: 20 } } },
  }));
  const pdf = policyFor(result, "pdf_search");
  assert.equal(pdf.policy.previewLines, 20);
  assert.equal(pdf.provenance.previewLines, "/agent/config/pi-square.json");
  // Fields not overridden keep default provenance
  assert.equal(pdf.provenance.resultMode, "default");
  assert.equal(pdf.policy.resultMode, DEFAULT_DISPLAY_POLICY.resultMode);
}

// ── Agent family overlay ─────────────────────────────────────────────

{
  const result = resolve(makeConfig({
    agent: { config: { families: { search: { previewLines: 15 } } } },
  }));
  const pdf = policyFor(result, "pdf_search");
  assert.equal(pdf.policy.previewLines, 15, "family overlay applies to family member");
  assert.equal(pdf.provenance.previewLines, "/agent/config/pi-square.json");
  // Non-search tools keep default
  const bash = policyFor(result, "bash");
  assert.equal(bash.policy.previewLines, DEFAULT_DISPLAY_POLICY.previewLines);
  assert.equal(bash.provenance.previewLines, "default");
}

// ── Agent tool overlay ───────────────────────────────────────────────

{
  const result = resolve(makeConfig({
    agent: { config: { tools: { pdf_search: { previewLines: 12 } } } },
  }));
  const pdf = policyFor(result, "pdf_search");
  assert.equal(pdf.policy.previewLines, 12);
  assert.equal(pdf.provenance.previewLines, "/agent/config/pi-square.json");
  // Other tools unaffected
  const ssh = policyFor(result, "ssh");
  assert.equal(ssh.provenance.previewLines, "default");
}

// ── Specificity within agent: tool > family > defaults ──────────────

{
  const result = resolve(makeConfig({
    agent: {
      config: {
        defaults: { previewLines: 10 },
        families: { search: { previewLines: 11 } },
        tools: { pdf_search: { previewLines: 12 } },
      },
    },
  }));
  const pdf = policyFor(result, "pdf_search");
  assert.equal(pdf.policy.previewLines, 12, "agent tool wins over family and defaults");

}

// ── Project scope overrides agent scope ──────────────────────────────

{
  const result = resolve(makeConfig({
    agent: { config: { defaults: { previewLines: 10 } } },
    project: { config: { defaults: { previewLines: 20 } } },
  }));
  const pdf = policyFor(result, "pdf_search");
  assert.equal(pdf.policy.previewLines, 20, "project defaults override agent defaults");
  assert.equal(pdf.provenance.previewLines, "/project/.pi/config/pi-square.json");
}

// ── Cross-axis: project defaults > agent tool ───────────────────────

{
  const result = resolve(makeConfig({
    agent: { config: { tools: { pdf_search: { previewLines: 99 } } } },
    project: { config: { defaults: { previewLines: 42 } } },
  }));
  const pdf = policyFor(result, "pdf_search");
  assert.equal(pdf.policy.previewLines, 42, "project defaults must win over agent tool specificity");
  assert.equal(pdf.provenance.previewLines, "/project/.pi/config/pi-square.json");
}

// ── Cross-axis: project tool > project defaults > agent tool ────────

{
  const result = resolve(makeConfig({
    agent: { config: { tools: { pdf_search: { previewLines: 99 } } } },
    project: { config: { defaults: { previewLines: 42 }, tools: { pdf_search: { previewLines: 7 } } } },
  }));
  const pdf = policyFor(result, "pdf_search");
  assert.equal(pdf.policy.previewLines, 7, "project tool wins over everything");
  assert.equal(pdf.provenance.previewLines, "/project/.pi/config/pi-square.json");
}

// ── Cross-axis: project family > agent tool ─────────────────────────

{
  const result = resolve(makeConfig({
    agent: { config: { tools: { pdf_search: { previewLines: 99 } } } },
    project: { config: { families: { search: { previewLines: 33 } } } },
  }));
  const pdf = policyFor(result, "pdf_search");
  assert.equal(pdf.policy.previewLines, 33, "project family wins over agent tool");
}

// ── Per-field independence ───────────────────────────────────────────

{
  const result = resolve(makeConfig({
    agent: { config: { defaults: { previewLines: 10 } } },
    project: { config: { defaults: { wordWrap: false } } },
  }));
  const pdf = policyFor(result, "pdf_search");
  assert.equal(pdf.policy.previewLines, 10, "agent previewLines kept");
  assert.equal(pdf.provenance.previewLines, "/agent/config/pi-square.json");
  assert.equal(pdf.policy.wordWrap, false, "project wordWrap applied");
  assert.equal(pdf.provenance.wordWrap, "/project/.pi/config/pi-square.json");
}

// ── Motion resolution ────────────────────────────────────────────────

{
  const result = resolve(makeConfig({
    agent: { config: { motion: "reduced" } },
    project: { config: { motion: "off" } },
  }));
  assert.equal(result.motion, "off", "project motion wins");
  assert.equal(result.motionProvenance, "/project/.pi/config/pi-square.json");
}
{
  const result = resolve(makeConfig({
    agent: { config: { motion: "reduced" } },
  }));
  assert.equal(result.motion, "reduced", "agent motion applies");
  assert.equal(result.motionProvenance, "/agent/config/pi-square.json");
}

// ── Explicit third-party adapter policy resolution ──────────────────

{
  const config = makeConfig({
    agent: { config: { defaults: { previewLines: 10 }, tools: { "mcp:deploy": { previewLines: 12 } } } },
    project: { config: { families: { remote: { resultMode: "preview" } } } },
  });
  const custom = resolveDisplayPolicyForTool("mcp:deploy", "remote", config.display);
  assert.equal(custom.policy.previewLines, 12);
  assert.equal(custom.policy.resultMode, "preview");
  assert.equal(custom.provenance.previewLines, "/agent/config/pi-square.json");
  assert.equal(custom.provenance.resultMode, "/project/.pi/config/pi-square.json");
}

// ── Integration: file-based loadConfig + resolution ──────────────────

const agentDir = mkdtempSync(join(tmpdir(), "pi-square-policy-agent-"));
const projectDir = mkdtempSync(join(tmpdir(), "pi-square-policy-project-"));
const previous = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;

try {
  mkdirSync(join(agentDir, "config"), { recursive: true });
  mkdirSync(join(projectDir, ".pi", "config"), { recursive: true });

  writeFileSync(join(agentDir, "config", "pi-square.json"), JSON.stringify({
    version: 2,
    display: {
      motion: "reduced",
      defaults: { previewLines: 10 },
      families: { search: { resultMode: "preview" } },
      tools: { pdf_search: { wordWrap: false } },
    },
  }));
  writeFileSync(join(projectDir, ".pi", "config", "pi-square.json"), JSON.stringify({
    version: 2,
    display: {
      defaults: { showDuration: false },
      tools: { pdf_search: { previewLines: 5 } },
    },
  }));

  const loaded = loadConfig(projectDir);
  assert.equal(loaded.diagnostics.length, 0, `unexpected diagnostics: ${loaded.diagnostics.map((d) => d.message).join("; ")}`);
  assert.equal(loaded.config.display.motion, "reduced", "agent motion applied (no project motion)");

  const resolved = resolveDisplayPolicies(loaded.config);
  const pdf = policyFor(resolved, "pdf_search");
  // Agent defaults previewLines=10, agent tool wordWrap=false, project tool previewLines=5
  assert.equal(pdf.policy.previewLines, 5, "project tool overrides agent defaults");
  assert.equal(pdf.policy.wordWrap, false, "agent tool wordWrap kept (no project override)");
  assert.equal(pdf.policy.showDuration, false, "project defaults showDuration applied");
  assert.equal(pdf.policy.resultMode, "preview", "agent family resultMode applied to search");
  assert.equal(pdf.provenance.previewLines, join(projectDir, ".pi", "config", "pi-square.json"));
  assert.equal(pdf.provenance.wordWrap, join(agentDir, "config", "pi-square.json"));
  assert.equal(pdf.provenance.showDuration, join(projectDir, ".pi", "config", "pi-square.json"));
  assert.equal(pdf.provenance.resultMode, join(agentDir, "config", "pi-square.json"));

  // Non-search tool does not get the family overlay
  const bash = policyFor(resolved, "bash");
  assert.equal(bash.policy.resultMode, DEFAULT_DISPLAY_POLICY.resultMode);
  assert.equal(bash.policy.previewLines, 10, "agent defaults previewLines applied");
  assert.equal(bash.policy.showDuration, false, "project defaults showDuration applied");
} finally {
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previous;
  rmSync(agentDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
}

// ── 128 tools accepted, 129 rejected ─────────────────────────────────

const agentDir2 = mkdtempSync(join(tmpdir(), "pi-square-policy-128-agent-"));
const projectDir2 = mkdtempSync(join(tmpdir(), "pi-square-policy-128-project-"));
const prev2 = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir2;

try {
  mkdirSync(join(agentDir2, "config"), { recursive: true });

  // 128 tools — valid
  const tools128 = {};
  for (let i = 0; i < DISPLAY_TOOLS_MAX; i++) {
    tools128[`tool${i}`] = { previewLines: (i % 80) + 1 };
  }
  writeFileSync(join(agentDir2, "config", "pi-square.json"), JSON.stringify({
    version: 2,
    display: { tools: tools128 },
  }));
  const ok128 = loadConfig(projectDir2);
  assert.equal(ok128.diagnostics.length, 0, `128 tools should be accepted: ${ok128.diagnostics.map((d) => d.message).join("; ")}`);
  assert.ok(ok128.config.display.agent, "agent display layer should be present");

  // 129 tools — rejected atomically
  const tools129 = { ...tools129base() };
  writeFileSync(join(agentDir2, "config", "pi-square.json"), JSON.stringify({
    version: 2,
    display: { tools: tools129 },
  }));
  const bad129 = loadConfig(projectDir2);
  assert.equal(bad129.diagnostics.length, 1, "129 tools should be rejected");
  assert.match(bad129.diagnostics[0].message, /exceeds the maximum/);
  assert.ok(!bad129.config.display.agent, "agent display layer should be absent after rejection");
} finally {
  if (prev2 === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = prev2;
  rmSync(agentDir2, { recursive: true, force: true });
  rmSync(projectDir2, { recursive: true, force: true });
}

function tools129base() {
  const tools = {};
  for (let i = 0; i < DISPLAY_TOOLS_MAX + 1; i++) {
    tools[`tool${i}`] = { previewLines: (i % 80) + 1 };
  }
  return tools;
}

console.log("display policy tests: OK");
