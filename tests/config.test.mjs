import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jiti from "jiti";

const agentDir = mkdtempSync(join(tmpdir(), "pi-square-config-agent-"));
const projectDir = mkdtempSync(join(tmpdir(), "pi-square-config-project-"));
const previous = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;

try {
  mkdirSync(join(agentDir, "config"), { recursive: true });
  mkdirSync(join(projectDir, ".pi", "config"), { recursive: true });
  writeFileSync(join(agentDir, "config", "pi-square.json"), JSON.stringify({
    version: 1,
    statusline: { shortcut: "alt+x" },
  }));
  writeFileSync(join(projectDir, ".pi", "config", "pi-square.json"), JSON.stringify({
    version: 1,
    statusline: { enabled: false },
    banner: { enabled: false },
  }));

  const load = jiti(import.meta.url, { moduleCache: false });
  const { loadConfig, DEFAULT_CONFIG } = await load("../src/core/config.ts");
  assert.equal(DEFAULT_CONFIG.banner.enabled, true);
  const loaded = loadConfig(projectDir);
  assert.equal(loaded.config.statusline.enabled, false);
  assert.equal(loaded.config.statusline.shortcut, "alt+x");
  assert.equal(loaded.config.banner.enabled, false);
  assert.equal(loaded.diagnostics.length, 0);

  writeFileSync(join(projectDir, ".pi", "config", "pi-square.json"), JSON.stringify({ version: 1, unknown: true }));
  const invalid = loadConfig(projectDir);
  assert.equal(invalid.config.statusline.shortcut, "alt+x");
  assert.equal(invalid.diagnostics.length, 1);
  assert.match(invalid.diagnostics[0].message, /config ignored/);
  console.log("config tests: OK");
} finally {
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previous;
  rmSync(agentDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
}
