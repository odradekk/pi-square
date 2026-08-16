import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
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
    anchoredEditing: { enabled: true },
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
  assert.equal(DEFAULT_CONFIG.banner.enabled, true);
  assert.equal(DEFAULT_CONFIG.anchoredEditing.enabled, false);
  const loaded = loadConfig(projectDir);
  assert.equal(loaded.config.version, 2);
  assert.equal(loaded.config.banner.enabled, true);
  assert.equal(loaded.config.anchoredEditing.enabled, true);
  assert.equal(loaded.config.ssh.maxSessions, 6);
  assert.equal(loaded.config.ssh.profiles.length, 1);
  assert.equal(loaded.config.ssh.profiles[0].targets[0].port, 22);
  assert.equal(loaded.config.ssh.profiles[0].idleTimeoutMinutes, 30);
  assert.equal(Object.hasOwn(loaded.config.ssh.profiles[0], "confirmCommands"), false);
  assert.equal(loaded.diagnostics.length, 2, "both valid layers with footer.mode emit deprecation warnings");
  assert.ok(loaded.diagnostics.every((d) => /footer\.mode.*deprecated/.test(d.message)), "diagnostics must be footer.mode deprecation warnings");

  writeFileSync(join(projectDir, ".pi", "config", "pi-square.json"), JSON.stringify({
    version: 2,
    footer: { mode: "enhanced" },
    ssh: { profiles: [] },
  }));
  const projectSsh = loadConfig(projectDir);
  assert.equal(projectSsh.config.banner.enabled, false, "a project layer containing SSH settings must be rejected atomically");
  assert.equal(projectSsh.config.ssh.profiles[0].name, "ops");
  assert.equal(projectSsh.diagnostics.length, 2, "agent footer.mode deprecation + project SSH rejection");
  assert.ok(projectSsh.diagnostics.some((d) => /footer\.mode.*deprecated/.test(d.message)));
  assert.ok(projectSsh.diagnostics.some((d) => /config ignored/.test(d.message)));

  writeFileSync(join(projectDir, ".pi", "config", "pi-square.json"), JSON.stringify({
    version: 2,
    anchoredEditing: { enabled: false },
  }));
  const projectAnchoredEditing = loadConfig(projectDir);
  assert.equal(projectAnchoredEditing.config.anchoredEditing.enabled, true, "a project layer must not override agent-only anchored editing");
  assert.ok(projectAnchoredEditing.diagnostics.some((d) => /config ignored/.test(d.message)));

  writeFileSync(join(projectDir, ".pi", "config", "pi-square.json"), JSON.stringify({
    version: 1,
    statusline: { enabled: false },
    banner: { enabled: true },
  }));
  const legacy = loadConfig(projectDir);
  assert.equal(legacy.config.banner.enabled, false, "invalid project layer must not replace valid agent settings");
  assert.equal(legacy.diagnostics.length, 2, "agent footer.mode deprecation + project V1 rejection");
  assert.ok(legacy.diagnostics.some((d) => /footer\.mode.*deprecated/.test(d.message)));
  assert.ok(legacy.diagnostics.some((d) => /configuration V1 and the former statusline settings are no longer supported/.test(d.message)));

  writeFileSync(join(projectDir, ".pi", "config", "pi-square.json"), JSON.stringify({ version: 2, unknown: true }));
  const invalid = loadConfig(projectDir);
  assert.equal(invalid.config.banner.enabled, false);
  assert.equal(invalid.diagnostics.length, 2, "agent footer.mode deprecation + project unknown-key rejection");
  assert.ok(invalid.diagnostics.some((d) => /footer\.mode.*deprecated/.test(d.message)));
  assert.ok(invalid.diagnostics.some((d) => /config ignored/.test(d.message)));

  writeFileSync(join(projectDir, ".pi", "config", "pi-square.json"), JSON.stringify({
    version: 2,
    footer: { mode: "decorative" },
  }));
  const invalidMode = loadConfig(projectDir);
  assert.equal(invalidMode.config.banner.enabled, false);
  assert.equal(invalidMode.diagnostics.length, 2, "agent footer.mode deprecation + project invalid-mode rejection");
  assert.ok(invalidMode.diagnostics.some((d) => /footer\.mode.*deprecated/.test(d.message)));
  assert.ok(invalidMode.diagnostics.some((d) => /config ignored/.test(d.message)));

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

  // ── Display config validation ──────────────────────────────────

  writeFileSync(join(agentDir, "config", "pi-square.json"), JSON.stringify({
    version: 2,
    display: { motion: "reduced", defaults: { previewLines: 10 } },
  }));
  rmSync(join(projectDir, ".pi", "config", "pi-square.json"), { force: true });

  const displayAgent = loadConfig(projectDir);
  assert.equal(displayAgent.diagnostics.length, 0, `unexpected display diagnostics: ${displayAgent.diagnostics.map((d) => d.message).join("; ")}`);
  assert.equal(displayAgent.config.display.motion, "reduced");
  assert.ok(displayAgent.config.display.agent, "agent display layer present");

  writeFileSync(join(projectDir, ".pi", "config", "pi-square.json"), JSON.stringify({
    version: 2,
    display: { defaults: { wordWrap: false } },
  }));
  const displayProject = loadConfig(projectDir);
  assert.equal(displayProject.diagnostics.length, 0);
  assert.equal(displayProject.config.display.project?.config.defaults.wordWrap, false);
  assert.equal(displayProject.config.display.motion, "reduced", "agent motion preserved");

  // Invalid tool name → atomic rejection
  writeFileSync(join(projectDir, ".pi", "config", "pi-square.json"), JSON.stringify({
    version: 2,
    display: { tools: { "bad name!": { previewLines: 5 } } },
  }));
  const badToolName = loadConfig(projectDir);
  assert.equal(badToolName.diagnostics.length, 1);
  assert.match(badToolName.diagnostics[0].message, /does not match the required tool name pattern/);
  assert.ok(!badToolName.config.display.project, "project display must be absent after rejection");

  // Out-of-bounds value → schema rejection
  writeFileSync(join(projectDir, ".pi", "config", "pi-square.json"), JSON.stringify({
    version: 2,
    display: { defaults: { previewLines: 999 } },
  }));
  const oobValue = loadConfig(projectDir);
  assert.equal(oobValue.diagnostics.length, 1);
  assert.match(oobValue.diagnostics[0].message, /config ignored/);

  // ── Display config writer ───────────────────────────────────────

  const writeModule = await load("../src/core/config-write.ts");
  const {
    writeDisplayConfig,
    fingerprintConfigContent,
    readConfigFingerprint,
    readDisplayConfigSnapshot,
    displayConfigPath,
    DisplayConfigWriteError,
  } = writeModule;

  // Fresh temp dirs for writer tests
  const wAgentDir = mkdtempSync(join(tmpdir(), "pi-square-writer-agent-"));
  const wProjectDir = mkdtempSync(join(tmpdir(), "pi-square-writer-project-"));
  const wPrev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = wAgentDir;

  try {
    mkdirSync(join(wAgentDir, "config"), { recursive: true });
    mkdirSync(join(wProjectDir, ".pi", "config"), { recursive: true });

    // Agent write creates new file
    const agentPath = displayConfigPath("agent", wProjectDir);
    const fp1 = await readConfigFingerprint(agentPath);
    const result1 = await writeDisplayConfig(
      { fingerprint: fp1, display: { motion: "reduced", defaults: { previewLines: 10 } } },
      { cwd: wProjectDir, isProjectTrusted: true },
    );
    assert.equal(result1.path, agentPath);
    const written1 = JSON.parse(readFileSync(agentPath, "utf8"));
    assert.equal(written1.display.motion, "reduced");
    assert.equal(written1.display.defaults.previewLines, 10);
    assert.equal(statSync(agentPath).mode & 0o777, 0o600, "new config files must default to owner-only mode");
    const snapshot1 = await readDisplayConfigSnapshot("agent", {
      cwd: wProjectDir,
      isProjectTrusted: true,
    });
    assert.equal(snapshot1.path, agentPath);
    assert.equal(snapshot1.fingerprint, await readConfigFingerprint(agentPath));
    assert.deepEqual(snapshot1.display, written1.display);
    assert.equal(snapshot1.footerModePresent, false);

    // Preserve unrelated keys
    writeFileSync(agentPath, JSON.stringify({
      version: 2,
      banner: { enabled: false },
      ssh: { maxSessions: 4, profiles: [] },
      footer: { mode: "native" },
    }));
    const fp2 = await readConfigFingerprint(agentPath);
    await writeDisplayConfig(
      { fingerprint: fp2, display: { motion: "off" } },
      { cwd: wProjectDir, isProjectTrusted: true },
    );
    const written2 = JSON.parse(readFileSync(agentPath, "utf8"));
    assert.equal(written2.version, 2, "version preserved");
    assert.equal(written2.banner.enabled, false, "banner preserved");
    assert.equal(written2.ssh.maxSessions, 4, "ssh preserved");
    assert.equal(written2.footer.mode, "native", "footer preserved");
    assert.equal(written2.display.motion, "off");
    assert.equal((await readDisplayConfigSnapshot("agent", {
      cwd: wProjectDir,
      isProjectTrusted: true,
    })).footerModePresent, true);

    // File mode preservation
    writeFileSync(agentPath, JSON.stringify({ version: 2 }));
    chmodSync(agentPath, 0o600);
    assert.equal(statSync(agentPath).mode & 0o777, 0o600, "precondition: file mode is 0o600");
    const fp3 = await readConfigFingerprint(agentPath);
    await writeDisplayConfig(
      { fingerprint: fp3, display: { defaults: { previewLines: 5 } } },
      { cwd: wProjectDir, isProjectTrusted: true },
    );
    const modeAfter = statSync(agentPath).mode & 0o777;
    assert.equal(modeAfter, 0o600, "file mode must be preserved");

    // Stale review rejection
    writeFileSync(agentPath, JSON.stringify({ version: 2, banner: { enabled: true } }));
    const staleFp = fingerprintConfigContent(JSON.stringify({ version: 2, banner: { enabled: false } }));
    await assert.rejects(
      () => writeDisplayConfig(
        { fingerprint: staleFp, display: { motion: "off" } },
        { cwd: wProjectDir, isProjectTrusted: true },
      ),
      (err) => err instanceof DisplayConfigWriteError && err.code === "DISPLAY_STALE_REVIEW",
    );

    // Concurrent writers reviewed from the same content: one wins and one observes stale state.
    writeFileSync(agentPath, JSON.stringify({ version: 2 }));
    const concurrentFingerprint = await readConfigFingerprint(agentPath);
    const concurrent = await Promise.allSettled([
      writeDisplayConfig(
        { fingerprint: concurrentFingerprint, display: { motion: "full" } },
        { cwd: wProjectDir, isProjectTrusted: true },
      ),
      writeDisplayConfig(
        { fingerprint: concurrentFingerprint, display: { motion: "off" } },
        { cwd: wProjectDir, isProjectTrusted: true },
      ),
    ]);
    assert.equal(concurrent.filter((result) => result.status === "fulfilled").length, 1);
    const concurrentFailure = concurrent.find((result) => result.status === "rejected");
    assert.ok(
      concurrentFailure?.reason instanceof DisplayConfigWriteError
      && concurrentFailure.reason.code === "DISPLAY_STALE_REVIEW",
      "the losing writer must reject a stale review after acquiring the lock",
    );

    // Project trust requirement
    const projectPath = displayConfigPath("project", wProjectDir);
    const fpProj = await readConfigFingerprint(projectPath);
    await assert.rejects(
      () => writeDisplayConfig(
        { fingerprint: fpProj, display: { motion: "off" } },
        { cwd: wProjectDir, isProjectTrusted: false },
        "project",
      ),
      (err) => err instanceof DisplayConfigWriteError && err.code === "DISPLAY_PROJECT_UNTRUSTED",
    );
    const projResult = await writeDisplayConfig(
      { fingerprint: fpProj, display: { motion: "reduced" } },
      { cwd: wProjectDir, isProjectTrusted: true },
      "project",
    );
    assert.equal(projResult.path, projectPath);
    const projWritten = JSON.parse(readFileSync(projectPath, "utf8"));
    assert.equal(projWritten.display.motion, "reduced");
    assert.ok(!projWritten.ssh, "project write must not create SSH");

    // Lock timeout with a live lock. Tests inject a zero-delay wait without changing retry count.
    writeFileSync(agentPath, JSON.stringify({ version: 2 }));
    const lockPath = agentPath + ".lock";
    writeFileSync(lockPath, JSON.stringify({ token: "other-owner", created: Date.now() }));
    const fpLive = await readConfigFingerprint(agentPath);
    await assert.rejects(
      () => writeDisplayConfig(
        { fingerprint: fpLive, display: { motion: "off" } },
        { cwd: wProjectDir, isProjectTrusted: true },
        "agent",
        { sleep: async () => {} },
      ),
      (err) => err instanceof DisplayConfigWriteError
        && err.code === "DISPLAY_LOCK_TIMEOUT"
        && err.message.includes(lockPath),
    );
    assert.equal(JSON.parse(readFileSync(lockPath, "utf8")).token, "other-owner", "live lock must not be stolen");
    rmSync(lockPath, { force: true });

    const externalLock = join(wProjectDir, "external-lock.json");
    const externalLockContent = JSON.stringify({ token: "outside", created: 0 });
    writeFileSync(externalLock, externalLockContent);
    symlinkSync(externalLock, lockPath);
    await assert.rejects(
      () => writeDisplayConfig(
        { fingerprint: fpLive, display: { motion: "off" } },
        { cwd: wProjectDir, isProjectTrusted: true },
        "agent",
        { sleep: async () => {} },
      ),
      (err) => err instanceof DisplayConfigWriteError && err.code === "DISPLAY_SCOPE_ESCAPED",
    );
    assert.equal(readFileSync(externalLock, "utf8"), externalLockContent, "lock symlink target must remain untouched");
    rmSync(lockPath, { force: true });

    // An old claimed timestamp with a fresh filesystem identity is still live.
    writeFileSync(lockPath, JSON.stringify({ token: "fresh-owner", created: Date.now() - 31_000 }));
    await assert.rejects(
      () => writeDisplayConfig(
        { fingerprint: fpLive, display: { motion: "off" } },
        { cwd: wProjectDir, isProjectTrusted: true },
        "agent",
        { sleep: async () => {} },
      ),
      (err) => err instanceof DisplayConfigWriteError && err.code === "DISPLAY_LOCK_TIMEOUT",
    );
    rmSync(lockPath, { force: true });

    // Stale reclaim requires both payload time and unchanged file mtime to be old.
    const staleTime = new Date(Date.now() - 31_000);
    writeFileSync(lockPath, JSON.stringify({ token: "stale-owner", created: staleTime.getTime() }));
    utimesSync(lockPath, staleTime, staleTime);
    const fpStaleLock = await readConfigFingerprint(agentPath);
    const staleLockResult = await writeDisplayConfig(
      { fingerprint: fpStaleLock, display: { motion: "full" } },
      { cwd: wProjectDir, isProjectTrusted: true },
    );
    assert.equal(staleLockResult.path, agentPath);
    assert.equal(existsSync(lockPath), false, "owned lock must be removed after write");

    // A malformed lock is reclaimable only after its filesystem mtime becomes stale.
    writeFileSync(lockPath, "not-json");
    utimesSync(lockPath, staleTime, staleTime);
    const fpMalformedLock = await readConfigFingerprint(agentPath);
    const malformedLockResult = await writeDisplayConfig(
      { fingerprint: fpMalformedLock, display: { motion: "reduced" } },
      { cwd: wProjectDir, isProjectTrusted: true },
    );
    assert.equal(malformedLockResult.path, agentPath);
    assert.equal(existsSync(lockPath), false, "stale malformed lock must be reclaimed");

    // Reject config-file, config-directory, and project .pi symlinks.
    const symlinkTarget = mkdtempSync(join(tmpdir(), "pi-square-symlink-target-"));
    try {
      const fileLinkAgent = mkdtempSync(join(tmpdir(), "pi-square-writer-file-link-"));
      const previousAgent = process.env.PI_CODING_AGENT_DIR;
      process.env.PI_CODING_AGENT_DIR = fileLinkAgent;
      try {
        mkdirSync(join(fileLinkAgent, "config"), { recursive: true });
        symlinkSync(join(symlinkTarget, "evil.json"), join(fileLinkAgent, "config", "pi-square.json"));
        await assert.rejects(
          () => writeDisplayConfig(
            { fingerprint: fingerprintConfigContent(""), display: { motion: "off" } },
            { cwd: wProjectDir, isProjectTrusted: true },
          ),
          (err) => err instanceof DisplayConfigWriteError && err.code === "DISPLAY_SCOPE_ESCAPED",
        );
        await assert.rejects(
          () => readConfigFingerprint(join(fileLinkAgent, "config", "pi-square.json")),
          (err) => err instanceof DisplayConfigWriteError && err.code === "DISPLAY_SCOPE_ESCAPED",
        );
      } finally {
        process.env.PI_CODING_AGENT_DIR = previousAgent;
        rmSync(fileLinkAgent, { recursive: true, force: true });
      }

      const dirLinkAgent = mkdtempSync(join(tmpdir(), "pi-square-writer-dir-link-"));
      process.env.PI_CODING_AGENT_DIR = dirLinkAgent;
      try {
        symlinkSync(symlinkTarget, join(dirLinkAgent, "config"));
        await assert.rejects(
          () => writeDisplayConfig(
            { fingerprint: fingerprintConfigContent(""), display: { motion: "off" } },
            { cwd: wProjectDir, isProjectTrusted: true },
          ),
          (err) => err instanceof DisplayConfigWriteError && err.code === "DISPLAY_SCOPE_ESCAPED",
        );
      } finally {
        process.env.PI_CODING_AGENT_DIR = wAgentDir;
        rmSync(dirLinkAgent, { recursive: true, force: true });
      }

      const projectLink = mkdtempSync(join(tmpdir(), "pi-square-writer-project-link-"));
      try {
        symlinkSync(symlinkTarget, join(projectLink, ".pi"));
        await assert.rejects(
          () => writeDisplayConfig(
            { fingerprint: fingerprintConfigContent(""), display: { motion: "off" } },
            { cwd: projectLink, isProjectTrusted: true },
            "project",
          ),
          (err) => err instanceof DisplayConfigWriteError && err.code === "DISPLAY_SCOPE_ESCAPED",
        );
      } finally {
        rmSync(projectLink, { recursive: true, force: true });
      }
    } finally {
      process.env.PI_CODING_AGENT_DIR = wAgentDir;
      rmSync(symlinkTarget, { recursive: true, force: true });
    }

    // Remove footer.mode migration
    writeFileSync(agentPath, JSON.stringify({ version: 2, footer: { mode: "native" } }));
    const fpMig = await readConfigFingerprint(agentPath);
    await writeDisplayConfig(
      { fingerprint: fpMig, display: { motion: "off" }, removeFooterMode: true },
      { cwd: wProjectDir, isProjectTrusted: true },
    );
    const migWritten = JSON.parse(readFileSync(agentPath, "utf8"));
    assert.ok(!migWritten.footer, "footer must be removed when removeFooterMode is true");
    assert.equal(migWritten.display.motion, "off");

    // Invalid candidate rejection
    writeFileSync(agentPath, JSON.stringify({ version: 2 }));
    const fpInvalid = await readConfigFingerprint(agentPath);
    await assert.rejects(
      () => writeDisplayConfig(
        { fingerprint: fpInvalid, display: { defaults: { previewLines: 9999 } } },
        { cwd: wProjectDir, isProjectTrusted: true },
      ),
      (err) => err instanceof DisplayConfigWriteError && err.code === "DISPLAY_CANDIDATE_INVALID",
    );
    // Original file untouched
    assert.deepEqual(JSON.parse(readFileSync(agentPath, "utf8")), { version: 2 });

    // A non-cooperating external write between review and rename is detected and preserved.
    writeFileSync(agentPath, JSON.stringify({ version: 2 }));
    const fpLateStale = await readConfigFingerprint(agentPath);
    const externalContent = JSON.stringify({ version: 2, banner: { enabled: false } });
    await assert.rejects(
      () => writeDisplayConfig(
        { fingerprint: fpLateStale, display: { motion: "off" } },
        { cwd: wProjectDir, isProjectTrusted: true },
        "agent",
        { beforeRename: async () => { writeFileSync(agentPath, externalContent); } },
      ),
      (err) => err instanceof DisplayConfigWriteError && err.code === "DISPLAY_STALE_REVIEW",
    );
    assert.equal(readFileSync(agentPath, "utf8"), externalContent);
    assert.equal(existsSync(lockPath), false, "lock must be released after late stale review");

    // Injected rename failure leaves the reviewed config, lock, and temp namespace clean.
    const fpRename = await readConfigFingerprint(agentPath);
    await assert.rejects(
      () => writeDisplayConfig(
        { fingerprint: fpRename, display: { motion: "off" } },
        { cwd: wProjectDir, isProjectTrusted: true },
        "agent",
        { rename: async () => { throw new Error("injected rename failure"); } },
      ),
      (err) => err instanceof DisplayConfigWriteError && err.code === "DISPLAY_RENAME_FAILED",
    );
    assert.deepEqual(JSON.parse(readFileSync(agentPath, "utf8")), { version: 2, banner: { enabled: false } });
    assert.equal(existsSync(lockPath), false, "lock must be released after rename failure");
    assert.deepEqual(
      readdirSync(join(wAgentDir, "config")).filter((name) => name.endsWith(".tmp")),
      [],
      "temporary config files must be removed after rename failure",
    );

    // No lock remains after any failed writer path above.
    assert.ok(!existsSync(lockPath), "lock must be released after writer failures");
  } finally {
    if (wPrev === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = wPrev;
    rmSync(wAgentDir, { recursive: true, force: true });
    rmSync(wProjectDir, { recursive: true, force: true });
  }

  console.log("config tests: OK");
} finally {
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previous;
  rmSync(agentDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
}
