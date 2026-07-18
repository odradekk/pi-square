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
    version: 2,
    footer: { mode: "native" },
    banner: { enabled: false },
    ssh: {
      maxSessions: 6,
      profiles: [{
        name: "ops",
        defaultTarget: "primary",
        targets: [{
          name: "primary",
          host: "ops.example.test",
          username: "deploy",
          fingerprints: ["SHA256:AAAAAAAAAAAAAAAAAAAAAA"],
        }],
        auth: { method: "agent" },
        maxSessions: 2,
      }],
    },
  }));
  writeFileSync(join(projectDir, ".pi", "config", "pi-square.json"), JSON.stringify({
    version: 2,
    footer: { mode: "enhanced" },
    banner: { enabled: true },
  }));

  const load = jiti(import.meta.url, { moduleCache: false });
  const { loadConfig, DEFAULT_CONFIG } = await load("../src/core/config.ts");
  assert.equal(DEFAULT_CONFIG.version, 2);
  assert.equal(DEFAULT_CONFIG.footer.mode, "enhanced");
  assert.equal(DEFAULT_CONFIG.banner.enabled, true);
  const loaded = loadConfig(projectDir);
  assert.equal(loaded.config.version, 2);
  assert.equal(loaded.config.footer.mode, "enhanced");
  assert.equal(loaded.config.banner.enabled, true);
  assert.equal(loaded.config.ssh.maxSessions, 6);
  assert.equal(loaded.config.ssh.profiles.length, 1);
  assert.equal(loaded.config.ssh.profiles[0].targets[0].port, 22);
  assert.equal(loaded.config.ssh.profiles[0].idleTimeoutMinutes, 30);
  assert.equal(Object.hasOwn(loaded.config.ssh.profiles[0], "confirmCommands"), false);
  assert.equal(loaded.diagnostics.length, 0);

  writeFileSync(join(projectDir, ".pi", "config", "pi-square.json"), JSON.stringify({
    version: 2,
    footer: { mode: "enhanced" },
    ssh: { profiles: [] },
  }));
  const projectSsh = loadConfig(projectDir);
  assert.equal(projectSsh.config.footer.mode, "native", "a project layer containing SSH settings must be rejected atomically");
  assert.equal(projectSsh.config.ssh.profiles[0].name, "ops");
  assert.equal(projectSsh.diagnostics.length, 1);
  assert.match(projectSsh.diagnostics[0].message, /config ignored/);

  writeFileSync(join(projectDir, ".pi", "config", "pi-square.json"), JSON.stringify({
    version: 1,
    statusline: { enabled: false },
    banner: { enabled: true },
  }));
  const legacy = loadConfig(projectDir);
  assert.equal(legacy.config.footer.mode, "native", "invalid project layer must not replace valid agent settings");
  assert.equal(legacy.config.banner.enabled, false, "invalid project layer must not replace valid agent settings");
  assert.equal(legacy.diagnostics.length, 1);
  assert.match(legacy.diagnostics[0].message, /configuration V1 and the former statusline settings are no longer supported/);

  writeFileSync(join(projectDir, ".pi", "config", "pi-square.json"), JSON.stringify({ version: 2, unknown: true }));
  const invalid = loadConfig(projectDir);
  assert.equal(invalid.config.footer.mode, "native");
  assert.equal(invalid.config.banner.enabled, false);
  assert.equal(invalid.diagnostics.length, 1);
  assert.match(invalid.diagnostics[0].message, /config ignored/);

  writeFileSync(join(projectDir, ".pi", "config", "pi-square.json"), JSON.stringify({
    version: 2,
    footer: { mode: "decorative" },
  }));
  const invalidMode = loadConfig(projectDir);
  assert.equal(invalidMode.config.footer.mode, "native");
  assert.equal(invalidMode.diagnostics.length, 1);
  assert.match(invalidMode.diagnostics[0].message, /config ignored/);

  writeFileSync(join(agentDir, "config", "pi-square.json"), JSON.stringify({
    version: 2,
    ssh: {
      profiles: [{
        name: "legacy",
        targets: [{ name: "one", host: "host", username: "user", fingerprints: ["SHA256:AAAAAAAAAAAAAAAAAAAAAA"] }],
        auth: { method: "agent" },
        confirmCommands: "always",
      }],
    },
  }));
  rmSync(join(projectDir, ".pi", "config", "pi-square.json"));
  const legacyConfirmation = loadConfig(projectDir);
  assert.equal(legacyConfirmation.config.ssh.profiles.length, 0);
  assert.equal(legacyConfirmation.diagnostics.length, 1);
  assert.match(legacyConfirmation.diagnostics[0].message, /\/ssh\/profiles\/0\/confirmCommands is no longer supported; remove confirmCommands/);

  writeFileSync(join(agentDir, "config", "pi-square.json"), JSON.stringify({
    version: 2,
    ssh: {
      maxSessions: 1,
      profiles: [{
        name: "bad",
        targets: [{ name: "one", host: "host", username: "user", fingerprints: ["SHA256:AAAAAAAAAAAAAAAAAAAAAA"] }],
        auth: { method: "privateKey" },
        maxSessions: 2,
      }],
    },
  }));
  const semanticInvalid = loadConfig(projectDir);
  assert.equal(semanticInvalid.config.ssh.profiles.length, 0);
  assert.equal(semanticInvalid.diagnostics.length, 1);
  assert.match(semanticInvalid.diagnostics[0].message, /privateKey auth requires privateKeyPath|maxSessions exceeds/);
  console.log("config tests: OK");
} finally {
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previous;
  rmSync(agentDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
}
