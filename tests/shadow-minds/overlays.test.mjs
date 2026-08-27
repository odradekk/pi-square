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
  writeShadowOverlay: rawWriteShadowOverlay,
} = await load(join(packageRoot, "src", "shadow-minds", "overlays.ts"));
const { discoverShadowDefinitions } = await load(join(packageRoot, "src", "shadow-minds", "definitions.ts"));
const { newShadowDefinitionDraft, serializeShadowDefinition } = await load(
  join(packageRoot, "src", "shadow-minds", "serialize.ts"),
);
const { installShadowFixtures } = await import("./lib/fixtures.mjs");

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
  installShadowFixtures(join(dir, "agent"));
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
async function writeShadowOverlay(input, hooks) {
  let reviewContextFingerprint = input.reviewContextFingerprint;
  let reviewIdentity = input.reviewIdentity;
  if (reviewContextFingerprint === undefined || reviewIdentity === undefined) {
    const review = await readShadowOverlaySnapshot(input.scope, input.cwd, input.fields.id, {
    });
    reviewContextFingerprint ??= review.contextFingerprint;
    reviewIdentity ??= review.identity;
  }
  return rawWriteShadowOverlay({ ...input, reviewContextFingerprint, reviewIdentity }, hooks);
}

async function reviewedDelete(input, hooks) {
  let reviewContextFingerprint = input.reviewContextFingerprint;
  let reviewIdentity = input.reviewIdentity;
  if (reviewContextFingerprint === undefined || reviewIdentity === undefined) {
    const review = await readShadowOverlaySnapshot(input.scope, input.cwd, input.id, {
      filePath: input.filePath,
    });
    reviewContextFingerprint ??= review.contextFingerprint;
    reviewIdentity ??= review.identity;
  }
  return deleteShadowOverlay({ ...input, reviewContextFingerprint, reviewIdentity }, hooks);
}
// ── Write a new project overlay, then discover it merged over the template ──

await withRoot(async (dir, project) => {
  mkdirSync(project, { recursive: true });
  const draft = { id: "project-grounding", enabled: true, priority: 7 };
  const snapshot = await readShadowOverlaySnapshot("project", project, "project-grounding");
  assert.equal(snapshot.fingerprint, MISSING_OVERLAY_FINGERPRINT, "a missing overlay reviews as the empty-content fingerprint");
  const result = await writeShadowOverlay({
    cwd: project,
    scope: "project",
    fields: draft,
    reviewFingerprint: snapshot.fingerprint,
  });
  assert.equal(result.filePath, join(project, ".pi", "shadow-minds", "project-grounding.md"));
  const registry = discoverShadowDefinitions(project);
  const grounding = registry.definitions.find((definition) => definition.id === "project-grounding");
  assert.ok(grounding, "the written overlay is discovered");
  assert.equal(grounding.enabled, true);
  assert.equal(grounding.priority, 7);
  assert.equal(grounding.triggers.join(","), "tool_turn,completion", "unmentioned fields inherit the agent base");
  assert.equal(grounding.fieldSources.enabled.scope, "project");
  assert.equal(grounding.fieldSources.triggers.scope, "agent");
  assert.equal(grounding.layers.length, 2);
});

// ── Agent overlays write to the agent directory as the base layer ────

await withRoot(async (dir, project) => {
  mkdirSync(project, { recursive: true });
  const fields = { ...newShadowDefinitionDraft("agent-role", "Agent role", "Own the agent-layer body."), triggers: [] };
  const snapshot = await readShadowOverlaySnapshot("agent", project, "agent-role");
  await writeShadowOverlay({
    cwd: project,
    scope: "agent",
    fields,
    reviewFingerprint: snapshot.fingerprint,
  });
  const registry = discoverShadowDefinitions(project);
  const role = registry.definitions.find((definition) => definition.id === "agent-role");
  assert.ok(role);
  assert.equal(role.triggers.length, 0, "a new agent definition starts with no automatic triggers");
  assert.equal(role.enabled, false, "a new agent definition starts disabled");
  assert.ok(role.body.includes("agent-layer body"), "the agent layer owns the body it wrote");
  assert.equal(role.layers.length, 1, "no other scope claims the new ID");
});

// ── Writes follow discovery into an ancestor project directory ───────

await withRoot(async (dir, project) => {
  const parent = join(dir, "parent");
  const child = join(parent, "child");
  mkdirSync(join(parent, ".pi", "shadow-minds"), { recursive: true });
  mkdirSync(child, { recursive: true });
  await writeShadowOverlay({
    cwd: child,
    scope: "project",
    fields: { id: "research-scout", enabled: true },
    reviewFingerprint: MISSING_OVERLAY_FINGERPRINT,
  });
  assert.equal(
    (await readShadowOverlaySnapshot("project", child, "research-scout")).filePath,
    join(parent, ".pi", "shadow-minds", "research-scout.md"),
    "an ancestor discovered directory is the write target",
  );
  const registry = discoverShadowDefinitions(child);
  const scout = registry.definitions.find((definition) => definition.id === "research-scout");
  assert.ok(scout);
  assert.equal(scout.enabled, true);
});

// #188 removed Shadow project trust: every project writes on the same
// terms (the write and delete refusals below cover the remaining guards).
await withRoot(async (_dir, project) => {
  mkdirSync(project, { recursive: true });
  const draft = newShadowDefinitionDraft("x", "X", "Body.");
  const result = await writeShadowOverlay({
    cwd: project,
    scope: "project",
    fields: draft,
    reviewFingerprint: MISSING_OVERLAY_FINGERPRINT,
  });
  assert.ok(result.filePath.endsWith(join(".pi", "shadow-minds", "x.md")), "project writes never require approval");
  const registry = discoverShadowDefinitions(project);
  const written = registry.definitions.find((definition) => definition.id === "x");
  assert.ok(written, "the approval-free project write is discovered immediately");
});

// ── Stale review refuses without losing either version ───────────────

await withRoot(async (_dir, project) => {
  mkdirSync(project, { recursive: true });
  const fields = newShadowDefinitionDraft("research-scout", "Research scout", "First body.");
  await writeShadowOverlay({
    cwd: project,
    scope: "project",
    fields,
    reviewFingerprint: MISSING_OVERLAY_FINGERPRINT,
  });
  const external = serializeShadowDefinition({ ...fields, body: "Externally edited body." });
  write(join(project, ".pi", "shadow-minds", "research-scout.md"), external);
  await rejectsWrite(
    writeShadowOverlay({
      cwd: project,
      scope: "project",
      fields: { ...fields, body: "Second body." },
      reviewFingerprint: MISSING_OVERLAY_FINGERPRINT,
    }),
    "SHADOW_STALE_REVIEW",
  );
  const current = (await readShadowOverlaySnapshot("project", project, "research-scout")).fingerprint;
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
  const fingerprint = (await readShadowOverlaySnapshot("project", project, "alt")).fingerprint;
  await rejectsWrite(
    writeShadowOverlay(
      {
        cwd: project,
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
      scope: "agent",
      fields: {
        id: "gateless",
        name: "Gateless",
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
  let registry = discoverShadowDefinitions(project);
  assert.ok(!registry.definitions.some((definition) => definition.id === "completion-check"), "the broken layer fails the ID closed");
  const snapshot = await readShadowOverlaySnapshot("project", project, "completion-check");
  await writeShadowOverlay({
    cwd: project,
    scope: "project",
    fields: newShadowDefinitionDraft("completion-check", "Completion check", "Repaired body."),
    reviewFingerprint: snapshot.fingerprint,
  });
  registry = discoverShadowDefinitions(project);
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
  const fingerprint = (await readShadowOverlaySnapshot("project", project, "mode")).fingerprint;
  await writeShadowOverlay({
    cwd: project,
    scope: "project",
    fields: { id: "mode", name: "Mode", body: "Body two." },
    reviewFingerprint: fingerprint,
  });
  const { statSync } = await import("node:fs");
  assert.equal(statSync(filePath).mode & 0o777, 0o640, "the existing file mode is preserved");
  // A brand-new file is owner-only.
  await writeShadowOverlay({
    cwd: project,
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
      scope: "project",
      fields: newShadowDefinitionDraft("contended", "Contended", "Body."),
      reviewFingerprint: MISSING_OVERLAY_FINGERPRINT,
    },
    { retryCount: 1, retryDelayMs: 1 },
  );
  const registry = discoverShadowDefinitions(project);
  assert.ok(registry.definitions.some((definition) => definition.id === "contended"));
});

// ── Deletion is reviewed, stale-safe, and scope-checked ──────────────

await withRoot(async (_dir, project) => {
  mkdirSync(project, { recursive: true });
  const fields = newShadowDefinitionDraft("gone", "Gone", "Body.");
  await writeShadowOverlay({
    cwd: project,
    scope: "project",
    fields,
    reviewFingerprint: MISSING_OVERLAY_FINGERPRINT,
  });
  const filePath = join(project, ".pi", "shadow-minds", "gone.md");
  let snapshot = await readShadowOverlaySnapshot("project", project, "gone");
  const removed = await reviewedDelete({
    cwd: project,
    scope: "project",
    id: "gone",
    reviewFingerprint: snapshot.fingerprint,
  });
  assert.equal(removed.removed, true);
  assert.ok(!existsSync(filePath));
  assert.ok(!existsSync(`${filePath}.lock`), "the lock is released after deletion");
  // Deleting an already-missing overlay is a completed no-op.
  snapshot = await readShadowOverlaySnapshot("project", project, "gone");
  const again = await reviewedDelete({
    cwd: project,
    scope: "project",
    id: "gone",
    reviewFingerprint: snapshot.fingerprint,
  });
  assert.equal(again.removed, false);
  // A changed overlay is never deleted against the review.
  await writeShadowOverlay({
    cwd: project,
    scope: "project",
    fields,
    reviewFingerprint: MISSING_OVERLAY_FINGERPRINT,
  });
  write(filePath, serializeShadowDefinition({ ...fields, body: "Changed." }));
  await rejectsWrite(
    reviewedDelete({
      cwd: project,
      scope: "project",
      id: "gone",
      reviewFingerprint: MISSING_OVERLAY_FINGERPRINT,
    }),
    "SHADOW_STALE_REVIEW",
  );
  assert.ok(existsSync(filePath), "the changed overlay survives a stale delete");
});

// Project deletes equally never require approval (#188).
await withRoot(async (_dir, project) => {
  mkdirSync(project, { recursive: true });
  await writeShadowOverlay({
    cwd: project,
    scope: "project",
    fields: newShadowDefinitionDraft("gone-now", "Gone", "Body."),
    reviewFingerprint: MISSING_OVERLAY_FINGERPRINT,
  });
  const review = await readShadowOverlaySnapshot("project", project, "gone-now");
  const outcome = await reviewedDelete({
    cwd: project,
    scope: "project",
    id: "gone-now",
    reviewFingerprint: review.fingerprint,
    reviewIdentity: review.identity,
  });
  assert.equal(outcome.removed, true);
});


// ── Same-content inode replacement is stale by file identity ─────────

await withRoot(async (_dir, project) => {
  mkdirSync(project, { recursive: true });
  const fields = newShadowDefinitionDraft("identity", "Identity", "Body.");
  await writeShadowOverlay({ cwd: project, scope: "project", fields, reviewFingerprint: MISSING_OVERLAY_FINGERPRINT });
  const reviewed = await readShadowOverlaySnapshot("project", project, "identity");
  const replacement = `${reviewed.filePath}.replacement`;
  writeFileSync(replacement, reviewed.content, "utf8");
  const { renameSync } = await import("node:fs");
  renameSync(replacement, reviewed.filePath);
  await rejectsWrite(
    rawWriteShadowOverlay({
      cwd: project,
      scope: "project",
      fields: { ...fields, enabled: true },
      reviewFingerprint: reviewed.fingerprint,
      reviewContextFingerprint: reviewed.contextFingerprint,
      reviewIdentity: reviewed.identity,
    }),
    "SHADOW_STALE_REVIEW",
  );
  const onDisk = await (await import("node:fs/promises")).readFile(reviewed.filePath, "utf8");
  assert.equal(onDisk, reviewed.content, "the same-content replacement survives the stale write");
});

// ── A contributing lower-layer change invalidates the reviewed context ─

await withRoot(async (dir, project) => {
  mkdirSync(project, { recursive: true });
  const agentPath = join(dir, "agent", "shadow-minds", "project-grounding.md");
  write(agentPath, serializeShadowDefinition({ id: "project-grounding", priority: 1 }));
  const reviewed = await readShadowOverlaySnapshot("project", project, "project-grounding");
  write(agentPath, serializeShadowDefinition({ id: "project-grounding", priority: 2 }));
  await rejectsWrite(
    rawWriteShadowOverlay({
      cwd: project,
      scope: "project",
      fields: { id: "project-grounding", enabled: true },
      reviewFingerprint: reviewed.fingerprint,
      reviewContextFingerprint: reviewed.contextFingerprint,
      reviewIdentity: reviewed.identity,
    }),
    "SHADOW_STALE_REVIEW",
  );
  assert.ok(!existsSync(reviewed.filePath), "the stale project candidate is not created");
});

// ── Delete uses identity-safe unlink and exact canonical file targeting ─

await withRoot(async (_dir, project) => {
  mkdirSync(project, { recursive: true });
  const fields = newShadowDefinitionDraft("delete-identity", "Delete identity", "Body.");
  await writeShadowOverlay({ cwd: project, scope: "project", fields, reviewFingerprint: MISSING_OVERLAY_FINGERPRINT });
  const reviewed = await readShadowOverlaySnapshot("project", project, "delete-identity");
  const replacement = `${reviewed.filePath}.replacement`;
  writeFileSync(replacement, reviewed.content, "utf8");
  const { renameSync } = await import("node:fs");
  renameSync(replacement, reviewed.filePath);
  await rejectsWrite(
    deleteShadowOverlay({
      cwd: project,
      scope: "project",
      id: "delete-identity",
      filePath: reviewed.filePath,
      reviewFingerprint: reviewed.fingerprint,
      reviewContextFingerprint: reviewed.contextFingerprint,
      reviewIdentity: reviewed.identity,
    }),
    "SHADOW_STALE_REVIEW",
  );
  assert.ok(existsSync(reviewed.filePath), "the replacement inode survives the stale delete");
});



// ── Context changes during write/delete are detected before mutation ─

await withRoot(async (dir, project) => {
  mkdirSync(project, { recursive: true });
  const agentPath = join(dir, "agent", "shadow-minds", "context-probe.md");
  write(agentPath, serializeShadowDefinition(newShadowDefinitionDraft("context-probe", "Context probe", "Base body.")));
  const reviewed = await readShadowOverlaySnapshot("project", project, "context-probe");
  await rejectsWrite(
    rawWriteShadowOverlay({
      cwd: project,
      scope: "project",
      fields: { id: "context-probe", enabled: true },
      reviewFingerprint: reviewed.fingerprint,
      reviewContextFingerprint: reviewed.contextFingerprint,
      reviewIdentity: reviewed.identity,
    }, {
      beforeRename: () => write(agentPath, serializeShadowDefinition(newShadowDefinitionDraft("context-probe", "Context probe", "Base body two."))),
    }),
    "SHADOW_STALE_REVIEW",
  );
  assert.ok(!existsSync(reviewed.filePath), "the project candidate is not renamed after a late context change");

  const deletable = newShadowDefinitionDraft("late-delete", "Late delete", "Body.");
  await writeShadowOverlay({ cwd: project, scope: "project", fields: deletable, reviewFingerprint: MISSING_OVERLAY_FINGERPRINT });
  const deleteReview = await readShadowOverlaySnapshot("project", project, "late-delete");
  const agentDeletePath = join(dir, "agent", "shadow-minds", "late-delete.md");
  await rejectsWrite(
    deleteShadowOverlay({
      cwd: project,
      scope: "project",
      id: "late-delete",
      filePath: deleteReview.filePath,
      reviewFingerprint: deleteReview.fingerprint,
      reviewContextFingerprint: deleteReview.contextFingerprint,
      reviewIdentity: deleteReview.identity,
    }, {
      beforeRename: () => write(agentDeletePath, serializeShadowDefinition(newShadowDefinitionDraft("late-delete", "Changed lower", "Lower."))),
    }),
    "SHADOW_STALE_REVIEW",
  );
  assert.ok(existsSync(deleteReview.filePath), "the target survives a late context change before delete");
});

// ── Existing uppercase .MD overlays retain their exact discovered path ─

await withRoot(async (_dir, project) => {
  mkdirSync(project, { recursive: true });
  const upperPath = join(project, ".pi", "shadow-minds", "upper.MD");
  write(upperPath, serializeShadowDefinition(newShadowDefinitionDraft("upper", "Upper", "Body.")));
  const reviewed = await readShadowOverlaySnapshot("project", project, "upper", { filePath: upperPath });
  await rawWriteShadowOverlay({
    cwd: project,
    scope: "project",
    fields: { ...newShadowDefinitionDraft("upper", "Upper", "Body."), enabled: true },
    reviewFilePath: reviewed.filePath,
    reviewFingerprint: reviewed.fingerprint,
    reviewContextFingerprint: reviewed.contextFingerprint,
    reviewIdentity: reviewed.identity,
  });
  assert.ok(existsSync(upperPath), "the existing uppercase overlay path is updated in place");
  assert.ok(!existsSync(join(project, ".pi", "shadow-minds", "upper.md")), "no duplicate lowercase overlay is created");
  const refreshed = await readShadowOverlaySnapshot("project", project, "upper", { filePath: upperPath });
  await deleteShadowOverlay({
    cwd: project,
    scope: "project",
    id: "upper",
    filePath: refreshed.filePath,
    reviewFingerprint: refreshed.fingerprint,
    reviewContextFingerprint: refreshed.contextFingerprint,
    reviewIdentity: refreshed.identity,
  });
  assert.ok(!existsSync(upperPath), "the exact uppercase overlay is deleted");
});

console.log("shadow-minds overlay writer tests: OK");
