import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import jiti from "jiti";

const packageRoot = resolve(import.meta.dirname, "..", "..");
const load = jiti(import.meta.url, { moduleCache: false });
const {
  MISSING_OVERLAY_FINGERPRINT,
  ShadowOverlayError,
  deleteShadowOverlay,
  readShadowOverlaySnapshot,
  writeShadowOverlay,
} = await load(join(packageRoot, "src", "shadow-minds", "overlays.ts"));
const { discoverShadowDefinitions } = await load(join(packageRoot, "src", "shadow-minds", "definitions.ts"));
const { newShadowDefinitionDraft, serializeShadowDefinition } = await load(
  join(packageRoot, "src", "shadow-minds", "serialize.ts"),
);

function root() {
  return mkdtempSync(join(tmpdir(), `pi-square-shadow-ov-${process.pid}-${Date.now()}`));
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
  mkdirSync(join(dir, "agent"), { recursive: true });
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

function rejectsWrite(promise, code) {
  return assert.rejects(
    () => promise,
    (error) => error instanceof ShadowOverlayError && error.code === code,
  );
}

// ── Write a new project overlay, then discover it merged over the template ──

await withRoot(async (dir, project) => {
  mkdirSync(project, { recursive: true });
  const draft = { id: "project-grounding", enabled: true, priority: 7 };
  const snapshot = await readShadowOverlaySnapshot("project", project, "project-grounding", { projectTrusted: true });
  assert.equal(snapshot.fingerprint, MISSING_OVERLAY_FINGERPRINT, "a missing overlay reviews as the empty-content fingerprint");
  const result = await writeShadowOverlay({
    cwd: project,
    projectTrusted: true,
    scope: "project",
    fields: draft,
    reviewFingerprint: snapshot.fingerprint,
  });
  assert.equal(result.filePath, join(project, ".pi", "shadow-minds", "project-grounding.md"));
  const registry = discoverShadowDefinitions(project, { projectTrusted: true });
  const grounding = registry.definitions.find((definition) => definition.id === "project-grounding");
  assert.ok(grounding, "the written overlay is discovered");
  assert.equal(grounding.enabled, true);
  assert.equal(grounding.priority, 7);
  assert.equal(grounding.triggers.join(","), "tool_turn,completion", "unmentioned fields inherit the package layer");
  assert.equal(grounding.fieldSources.enabled.scope, "project");
  assert.equal(grounding.fieldSources.triggers.scope, "package");
  assert.equal(grounding.layers.length, 2);
});

// ── Agent overlays write to the agent directory and merge over templates ──

await withRoot(async (dir, project) => {
  mkdirSync(project, { recursive: true });
  const fields = { id: "alternative-explorer", triggers: [] };
  const snapshot = await readShadowOverlaySnapshot("agent", project, "alternative-explorer", { projectTrusted: false });
  await writeShadowOverlay({
    cwd: project,
    projectTrusted: false,
    scope: "agent",
    fields,
    reviewFingerprint: snapshot.fingerprint,
  });
  const registry = discoverShadowDefinitions(project, { projectTrusted: false });
  const explorer = registry.definitions.find((definition) => definition.id === "alternative-explorer");
  assert.ok(explorer);
  assert.equal(explorer.triggers.length, 0, "explicit empty triggers clear the package subscription");
  assert.equal(explorer.enabled, false);
  assert.ok(explorer.body.includes("alternative"), "the name and body inherit from the package layer");
});

// ── Writes follow discovery into an ancestor project directory ───────

await withRoot(async (dir, project) => {
  const parent = join(dir, "parent");
  const child = join(parent, "child");
  mkdirSync(join(parent, ".pi", "shadow-minds"), { recursive: true });
  mkdirSync(child, { recursive: true });
  await writeShadowOverlay({
    cwd: child,
    projectTrusted: true,
    scope: "project",
    fields: { id: "research-scout", enabled: true },
    reviewFingerprint: MISSING_OVERLAY_FINGERPRINT,
  });
  assert.equal(
    (await readShadowOverlaySnapshot("project", child, "research-scout", { projectTrusted: true })).filePath,
    join(parent, ".pi", "shadow-minds", "research-scout.md"),
    "an ancestor discovered directory is the write target",
  );
  const registry = discoverShadowDefinitions(child, { projectTrusted: true });
  const scout = registry.definitions.find((definition) => definition.id === "research-scout");
  assert.ok(scout);
  assert.equal(scout.enabled, true);
});

// ── Untrusted projects cannot write project overlays ─────────────────

await withRoot(async (_dir, project) => {
  mkdirSync(project, { recursive: true });
  await rejectsWrite(
    writeShadowOverlay({
      cwd: project,
      projectTrusted: false,
      scope: "project",
      fields: newShadowDefinitionDraft("x", "X", "Body."),
      reviewFingerprint: MISSING_OVERLAY_FINGERPRINT,
    }),
    "SHADOW_PROJECT_UNTRUSTED",
  );
  assert.ok(!existsSync(join(project, ".pi")), "a refused write creates no directories");
});

// ── Stale review refuses without losing either version ───────────────

await withRoot(async (_dir, project) => {
  mkdirSync(project, { recursive: true });
  const fields = newShadowDefinitionDraft("research-scout", "Research scout", "First body.");
  await writeShadowOverlay({
    cwd: project,
    projectTrusted: true,
    scope: "project",
    fields,
    reviewFingerprint: MISSING_OVERLAY_FINGERPRINT,
  });
  const external = serializeShadowDefinition({ ...fields, body: "Externally edited body." });
  write(join(project, ".pi", "shadow-minds", "research-scout.md"), external);
  await rejectsWrite(
    writeShadowOverlay({
      cwd: project,
      projectTrusted: true,
      scope: "project",
      fields: { ...fields, body: "Second body." },
      reviewFingerprint: MISSING_OVERLAY_FINGERPRINT,
    }),
    "SHADOW_STALE_REVIEW",
  );
  const current = (await readShadowOverlaySnapshot("project", project, "research-scout", { projectTrusted: true })).fingerprint;
  const onDisk = await import("node:fs/promises").then((fs) => fs.readFile(join(project, ".pi", "shadow-minds", "research-scout.md"), "utf8"));
  assert.ok(onDisk.includes("Externally edited body."), "the external version survives");
  assert.notEqual(current, "", "the refreshed fingerprint reflects the external version");
});

// ── An external change during the write is detected before rename ────

await withRoot(async (_dir, project) => {
  mkdirSync(project, { recursive: true });
  const fields = newShadowDefinitionDraft("alt", "Alt", "Body one.");
  const filePath = join(project, ".pi", "shadow-minds", "alt.md");
  write(filePath, serializeShadowDefinition(fields));
  const fingerprint = (await readShadowOverlaySnapshot("project", project, "alt", { projectTrusted: true })).fingerprint;
  await rejectsWrite(
    writeShadowOverlay(
      {
        cwd: project,
        projectTrusted: true,
        scope: "project",
        fields: { ...fields, body: "Body two." },
        reviewFingerprint: fingerprint,
      },
      {
        beforeRename: () => {
          writeFileSync(filePath, serializeShadowDefinition({ ...fields, body: "Raced body." }), "utf8");
        },
      },
    ),
    "SHADOW_STALE_REVIEW",
  );
  const onDisk = await import("node:fs/promises").then((fs) => fs.readFile(filePath, "utf8"));
  assert.ok(onDisk.includes("Raced body."), "the raced version survives");
  const leftovers = readdirSync(join(project, ".pi", "shadow-minds")).filter((name) => name.includes(".tmp"));
  assert.deepEqual(leftovers, [], "no temporary file survives a refused write");
  assert.ok(!existsSync(`${filePath}.lock`), "the lock is released after a refused write");
});

// ── Symlinked targets and scope segments are refused ─────────────────

await withRoot(async (dir, project) => {
  mkdirSync(join(project, ".pi"), { recursive: true });
  const outside = join(dir, "outside.md");
  write(outside, serializeShadowDefinition(newShadowDefinitionDraft("evil", "Evil", "Body.")));
  symlinkSync(outside, join(project, ".pi", "shadow-minds" + ".link"));
  mkdirSync(join(project, ".pi", "shadow-minds"));
  symlinkSync(outside, join(project, ".pi", "shadow-minds", "evil.md"));
  await rejectsWrite(
    writeShadowOverlay({
      cwd: project,
      projectTrusted: true,
      scope: "project",
      fields: newShadowDefinitionDraft("evil", "Evil", "Body."),
      reviewFingerprint: MISSING_OVERLAY_FINGERPRINT,
    }),
    "SHADOW_SCOPE_ESCAPED",
  );
  rmSync(join(project, ".pi", "shadow-minds", "evil.md"));
  rmSync(join(project, ".pi", "shadow-minds"), { recursive: true, force: true });
  symlinkSync(join(dir, "elsewhere"), join(project, ".pi", "shadow-minds"));
  await rejectsWrite(
    writeShadowOverlay({
      cwd: project,
      projectTrusted: true,
      scope: "project",
      fields: newShadowDefinitionDraft("evil", "Evil", "Body."),
      reviewFingerprint: MISSING_OVERLAY_FINGERPRINT,
    }),
    "SHADOW_SCOPE_ESCAPED",
  );
});

// ── Complete effective-candidate validation blocks invalid merges ────

await withRoot(async (_dir, project) => {
  mkdirSync(project, { recursive: true });
  // requiredTools outside the final tool set invalidates the effective merge.
  await rejectsWrite(
    writeShadowOverlay({
      cwd: project,
      projectTrusted: true,
      scope: "project",
      fields: {
        id: "completion-check",
        name: "Completion check",
        requiredTools: ["shell"],
        body: "Body.",
      },
      reviewFingerprint: MISSING_OVERLAY_FINGERPRINT,
    }),
    "SHADOW_CANDIDATE_INVALID",
  );
  assert.ok(!existsSync(join(project, ".pi", "shadow-minds", "completion-check.md")), "nothing is written for an invalid candidate");
  // A completion gate without a completion subscription is equally invalid.
  await rejectsWrite(
    writeShadowOverlay({
      cwd: project,
      projectTrusted: true,
      scope: "agent",
      fields: {
        id: "completion-check",
        name: "Completion check",
        completionGate: true,
        triggers: ["mutation"],
        body: "Body.",
      },
      reviewFingerprint: MISSING_OVERLAY_FINGERPRINT,
    }),
    "SHADOW_CANDIDATE_INVALID",
  );
});

// ── Repairing a broken overlay through a fresh write ─────────────────

await withRoot(async (_dir, project) => {
  mkdirSync(project, { recursive: true });
  write(join(project, ".pi", "shadow-minds", "completion-check.md"), "not frontmatter at all\n");
  let registry = discoverShadowDefinitions(project, { projectTrusted: true });
  assert.ok(!registry.definitions.some((definition) => definition.id === "completion-check"), "the broken layer fails the ID closed");
  const snapshot = await readShadowOverlaySnapshot("project", project, "completion-check", { projectTrusted: true });
  await writeShadowOverlay({
    cwd: project,
    projectTrusted: true,
    scope: "project",
    fields: newShadowDefinitionDraft("completion-check", "Completion check", "Repaired body."),
    reviewFingerprint: snapshot.fingerprint,
  });
  registry = discoverShadowDefinitions(project, { projectTrusted: true });
  const repaired = registry.definitions.find((definition) => definition.id === "completion-check");
  assert.ok(repaired, "writing a valid overlay over a broken one restores the ID");
  assert.equal(repaired.enabled, false);
});

// ── File permission preservation and defaults ────────────────────────

await withRoot(async (_dir, project) => {
  mkdirSync(join(project, ".pi", "shadow-minds"), { recursive: true });
  const filePath = join(project, ".pi", "shadow-minds", "mode.md");
  write(filePath, serializeShadowDefinition(newShadowDefinitionDraft("mode", "Mode", "Body.")));
  chmodSync(filePath, 0o640);
  const fingerprint = (await readShadowOverlaySnapshot("project", project, "mode", { projectTrusted: true })).fingerprint;
  await writeShadowOverlay({
    cwd: project,
    projectTrusted: true,
    scope: "project",
    fields: { id: "mode", name: "Mode", body: "Body two." },
    reviewFingerprint: fingerprint,
  });
  const { statSync } = await import("node:fs");
  assert.equal(statSync(filePath).mode & 0o777, 0o640, "the existing file mode is preserved");
  // A brand-new file is owner-only.
  await writeShadowOverlay({
    cwd: project,
    projectTrusted: true,
    scope: "project",
    fields: newShadowDefinitionDraft("fresh", "Fresh", "Body."),
    reviewFingerprint: MISSING_OVERLAY_FINGERPRINT,
  });
  assert.equal(statSync(join(project, ".pi", "shadow-minds", "fresh.md")).mode & 0o777, 0o600, "new overlays are owner-only");
});

// ── Lock contention refuses instead of blocking indefinitely ─────────

await withRoot(async (_dir, project) => {
  mkdirSync(project, { recursive: true });
  mkdirSync(join(project, ".pi", "shadow-minds"), { recursive: true });
  const { open, unlink } = await import("node:fs/promises");
  const lockPath = join(project, ".pi", "shadow-minds", "contended.md.lock");
  const handle = await open(lockPath, "w", 0o600);
  await handle.writeFile(JSON.stringify({ token: "someone-else", created: Date.now() }), "utf8");
  await handle.close();
  await rejectsWrite(
    writeShadowOverlay(
      {
        cwd: project,
        projectTrusted: true,
        scope: "project",
        fields: newShadowDefinitionDraft("contended", "Contended", "Body."),
        reviewFingerprint: MISSING_OVERLAY_FINGERPRINT,
      },
      { retryCount: 1, retryDelayMs: 1 },
    ),
    "SHADOW_LOCK_TIMEOUT",
  );
  await unlink(lockPath);
  // A stale lock (aged payload and mtime) is reclaimed and the write succeeds.
  const stale = await open(lockPath, "w", 0o600);
  await stale.writeFile(JSON.stringify({ token: "gone", created: Date.now() - 60_000 }), "utf8");
  await stale.close();
  const aged = new Date(Date.now() - 60_000);
  await (await import("node:fs")).promises.utimes(lockPath, aged, aged);
  await writeShadowOverlay(
    {
      cwd: project,
      projectTrusted: true,
      scope: "project",
      fields: newShadowDefinitionDraft("contended", "Contended", "Body."),
      reviewFingerprint: MISSING_OVERLAY_FINGERPRINT,
    },
    { retryCount: 1, retryDelayMs: 1 },
  );
  const registry = discoverShadowDefinitions(project, { projectTrusted: true });
  assert.ok(registry.definitions.some((definition) => definition.id === "contended"));
});

// ── Deletion is reviewed, stale-safe, and scope-checked ──────────────

await withRoot(async (_dir, project) => {
  mkdirSync(project, { recursive: true });
  const fields = newShadowDefinitionDraft("gone", "Gone", "Body.");
  await writeShadowOverlay({
    cwd: project,
    projectTrusted: true,
    scope: "project",
    fields,
    reviewFingerprint: MISSING_OVERLAY_FINGERPRINT,
  });
  const filePath = join(project, ".pi", "shadow-minds", "gone.md");
  let snapshot = await readShadowOverlaySnapshot("project", project, "gone", { projectTrusted: true });
  const removed = await deleteShadowOverlay({
    cwd: project,
    projectTrusted: true,
    scope: "project",
    id: "gone",
    reviewFingerprint: snapshot.fingerprint,
  });
  assert.equal(removed.removed, true);
  assert.ok(!existsSync(filePath));
  assert.ok(!existsSync(`${filePath}.lock`), "the lock is released after deletion");
  // Deleting an already-missing overlay is a completed no-op.
  snapshot = await readShadowOverlaySnapshot("project", project, "gone", { projectTrusted: true });
  const again = await deleteShadowOverlay({
    cwd: project,
    projectTrusted: true,
    scope: "project",
    id: "gone",
    reviewFingerprint: snapshot.fingerprint,
  });
  assert.equal(again.removed, false);
  // A changed overlay is never deleted against the review.
  await writeShadowOverlay({
    cwd: project,
    projectTrusted: true,
    scope: "project",
    fields,
    reviewFingerprint: MISSING_OVERLAY_FINGERPRINT,
  });
  write(filePath, serializeShadowDefinition({ ...fields, body: "Changed." }));
  await rejectsWrite(
    deleteShadowOverlay({
      cwd: project,
      projectTrusted: true,
      scope: "project",
      id: "gone",
      reviewFingerprint: MISSING_OVERLAY_FINGERPRINT,
    }),
    "SHADOW_STALE_REVIEW",
  );
  assert.ok(existsSync(filePath), "the changed overlay survives a stale delete");
});

// ── Untrusted projects cannot delete project overlays ────────────────

await withRoot(async (_dir, project) => {
  mkdirSync(project, { recursive: true });
  await rejectsWrite(
    deleteShadowOverlay({
      cwd: project,
      projectTrusted: false,
      scope: "project",
      id: "anything",
      reviewFingerprint: MISSING_OVERLAY_FINGERPRINT,
    }),
    "SHADOW_PROJECT_UNTRUSTED",
  );
});

console.log("shadow-minds overlay writer tests: OK");
