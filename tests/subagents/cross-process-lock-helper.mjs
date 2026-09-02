// Child-process helper for tests/subagents/cross-process-lock.test.mjs. Runs a
// single lock operation in a real OS process so cross-process behaviour is
// demonstrated with real processes rather than in-process calls. Reads a JSON
// job file (first argv) and writes its result to the job's `resultPath`.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

import jiti from "jiti";

const load = jiti(import.meta.url, { moduleCache: false });
// A caching loader for jobs that must patch one shared module instance (the
// crash-at-boundary failpoint patches the hash-store class the replace
// coordinator actually uses, so both loads must resolve to one instance).
const sharedLoad = jiti(import.meta.url);
const { acquireFileLock, lockFilePath } = await load("../../src/anchored-edit/file-lock.ts");
const { resolveTarget } = await load("../../src/anchored-edit/fs-write.ts");
const { createAnchoredReplaceToolDefinition } = await load("../../src/anchored-edit/workspace-replace.ts");
const { createChildAnchoredWriteTool } = await load("../../src/anchored-edit/child-write.ts");
const { anchoredStoreDir } = await load("../../src/anchored-edit/paths.ts");
const { shutdownHashStore } = await load("../../src/anchored-edit/hash-store.ts");

// The test polls for the result path's existence and parses it immediately, so
// the path must only ever appear complete: write a sibling temporary file in
// the same directory and rename it into place, which is atomic there.
function writeResult(resultPath, value) {
  const tempPath = `${resultPath}.${process.pid}.tmp`;
  writeFileSync(tempPath, JSON.stringify(value));
  renameSync(tempPath, resultPath);
}

async function main() {
  const job = JSON.parse(readFileSync(process.argv[2], "utf8"));
  const { mode, workspace, path, resultPath, sessionDir } = job;
  if (typeof sessionDir !== "string" || sessionDir.trim() === "") {
    throw new Error("helper job must provide sessionDir");
  }
  const workspaceRoot = realpathSync(workspace);
  const storeDir = anchoredStoreDir(sessionDir, workspaceRoot);

  async function canonicalLockPath(file) {
    const target = await resolveTarget(resolve(workspaceRoot, file));
    return lockFilePath(storeDir, target);
  }

  if (mode === "hold") {
    const lock = await acquireFileLock(await canonicalLockPath(path));
    writeResult(resultPath, { locked: lock !== null });
    if (lock) {
      // Keep the event loop alive while holding the lock, until this process
      // is killed by the test (simulating an editor mid-edit).
      setInterval(() => {}, 1000);
      await new Promise(() => {});
    }
    return;
  }

  if (mode === "replace") {
    const replace = createAnchoredReplaceToolDefinition(workspace, undefined, undefined, undefined, sessionDir);
    const result = await replace.execute(
      "replace",
      {
        path,
        remove_from: job.removeFrom,
        remove_to: job.removeTo,
        replacement_text: job.replacement,
      },
      undefined,
      undefined,
      { cwd: workspace },
    );
    writeResult(resultPath, result);
    return;
  }

  if (mode === "write") {
    const write = createChildAnchoredWriteTool(workspace, job.owner ?? "subagent_write", sessionDir);
    try {
      const result = await write.execute(
        "write",
        { path, content: job.content },
        undefined,
        undefined,
        { cwd: workspace },
      );
      writeResult(resultPath, { ok: true, result });
    } catch (error) {
      writeResult(resultPath, { ok: false, error: error.message });
    }
    return;
  }

  // Simulates a replace whose process died exactly at the post-commit
  // boundary, through the real operation coordinator: the target lock is
  // acquired, the range is prepared and validated, the filesystem commit
  // runs, and the process exits inside the store publication that follows —
  // so the crash point is the coordinator's own publication seam, not a
  // synthetic write.
  if (mode === "crash-after-write") {
    const hashStoreModule = await sharedLoad("../../src/anchored-edit/hash-store.ts");
    hashStoreModule.__testables.HashStoreHandleImpl.prototype.publishMutation = function () {
      writeResult(resultPath, { crashed: true });
      process.exit(0);
    };
    const { createAnchoredReplaceToolDefinition: createSharedReplace } = await sharedLoad("../../src/anchored-edit/workspace-replace.ts");
    const replace = createSharedReplace(workspace, undefined, undefined, undefined, sessionDir);
    await replace.execute(
      "crash-after-write",
      {
        path,
        remove_from: job.removeFrom,
        remove_to: job.removeTo,
        replacement_text: job.replacement,
      },
      undefined,
      undefined,
      { cwd: workspace },
    );
    throw new Error("crash-after-write: the publication failpoint did not fire");
  }

  if (mode === "read") {
    const readToolModule = await load("../../src/anchored-edit/read-tool.ts");
    const readTransformModule = await load("../../src/anchored-edit/read-transform.ts");
    const piPackage = await load("@earendil-works/pi-coding-agent");
    const readTool = readToolModule.withAnchoredReadTransform(
      piPackage.createReadToolDefinition(workspace),
      workspace,
      async (content, value, executionCwd, executionSessionDir) =>
        readTransformModule.transformAnchoredReadContent(
          content, value, executionCwd, "parent", { sessionDir: executionSessionDir },
        ),
    );
    const result = await readTool.execute(
      "read",
      { path },
      undefined,
      undefined,
      { cwd: workspace, sessionManager: { getSessionDir: () => sessionDir } },
    );
    writeResult(resultPath, result);
    return;
  }

  if (mode === "probe") {
    const lockPath = await canonicalLockPath(path);
    let exists = false;
    let content = null;
    try {
      content = readFileSync(lockPath, "utf8");
      exists = true;
    } catch {
      // absent
    }
    writeResult(resultPath, { exists, content });
    return;
  }

  throw new Error(`unknown helper mode: ${mode}`);
}

try {
  await main();
} finally {
  shutdownHashStore();
}
