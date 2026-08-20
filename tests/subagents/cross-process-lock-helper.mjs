// Child-process helper for tests/subagents/cross-process-lock.test.mjs. Runs a
// single lock operation in a real OS process so cross-process behaviour is
// demonstrated with real processes rather than in-process calls. Reads a JSON
// job file (first argv) and writes its result to the job's `resultPath`.
import { readFileSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

import jiti from "jiti";

const load = jiti(import.meta.url, { moduleCache: false });
const { acquireFileLock, lockFilePath } = await load("../../src/anchored-edit/file-lock.ts");
const { resolveTarget } = await load("../../src/anchored-edit/fs-write.ts");
const { createAnchoredReplaceToolDefinition } = await load("../../src/anchored-edit/workspace-replace.ts");
const { createAnchoredRevertToolDefinition } = await load("../../src/anchored-edit/workspace-revert.ts");
const { createChildAnchoredWriteTool } = await load("../../src/anchored-edit/child-write.ts");
const { shutdownHashStore } = await load("../../src/anchored-edit/hash-store.ts");

async function main() {
  const job = JSON.parse(readFileSync(process.argv[2], "utf8"));
  const { mode, workspace, path, resultPath } = job;
  const workspaceRoot = realpathSync(workspace);

  async function canonicalLockPath(file) {
    const target = await resolveTarget(resolve(workspaceRoot, file));
    return lockFilePath(workspaceRoot, target);
  }

  if (mode === "hold") {
    const lock = await acquireFileLock(await canonicalLockPath(path));
    writeFileSync(resultPath, JSON.stringify({ locked: lock !== null }));
    if (lock) {
      // Keep the event loop alive while holding the lock, until this process
      // is killed by the test (simulating an editor mid-edit).
      setInterval(() => {}, 1000);
      await new Promise(() => {});
    }
    return;
  }

  if (mode === "replace") {
    const replace = createAnchoredReplaceToolDefinition(workspace);
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
    writeFileSync(resultPath, JSON.stringify(result));
    return;
  }

  if (mode === "revert") {
    const revert = createAnchoredRevertToolDefinition(workspace);
    const result = await revert.execute("revert", { path }, undefined, undefined, { cwd: workspace });
    writeFileSync(resultPath, JSON.stringify(result));
    return;
  }

  if (mode === "write") {
    const write = createChildAnchoredWriteTool(workspace, job.owner ?? "subagent_write");
    try {
      const result = await write.execute(
        "write",
        { path, content: job.content },
        undefined,
        undefined,
        { cwd: workspace },
      );
      writeFileSync(resultPath, JSON.stringify({ ok: true, result }));
    } catch (error) {
      writeFileSync(resultPath, JSON.stringify({ ok: false, error: error.message }));
    }
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
    writeFileSync(resultPath, JSON.stringify({ exists, content }));
    return;
  }

  throw new Error(`unknown helper mode: ${mode}`);
}

try {
  await main();
} finally {
  shutdownHashStore();
}
