import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import jiti from "jiti";

const packageRoot = resolve(import.meta.dirname, "..", "..");
const load = jiti(import.meta.url, { moduleCache: false });
const { isWithinWorkspace, resolveWorkspacePath } = await load(join(packageRoot, "src", "core", "paths.ts"));

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test("workspace paths use canonical targets for boundary decisions", () => {
  const parent = mkdtempSync(join(tmpdir(), "pi-workspace-path-"));
  const workspace = join(parent, "workspace");
  const nested = join(workspace, "nested");
  const outside = join(parent, "outside");
  mkdirSync(nested, { recursive: true });
  mkdirSync(outside);

  try {
    const inside = resolveWorkspacePath(workspace, "nested");
    assert.equal(inside.workspaceRoot, workspace);
    assert.equal(inside.absolutePath, nested);
    assert.equal(inside.isInsideWorkspace, true);
    assert.equal(isWithinWorkspace(workspace, nested), true);

    const directOutside = resolveWorkspacePath(workspace, outside);
    assert.equal(directOutside.absolutePath, outside);
    assert.equal(directOutside.isInsideWorkspace, false);

    if (process.platform !== "win32") {
      symlinkSync(outside, join(workspace, "escape"), "dir");
      const escaped = resolveWorkspacePath(workspace, "escape");
      assert.equal(escaped.absolutePath, outside);
      assert.equal(escaped.isInsideWorkspace, false);
    }
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`PASS: ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL: ${name} - ${error instanceof Error ? error.stack : String(error)}`);
  }
}
console.log(`\n${tests.length} tests, ${failed} failed`);
if (failed) process.exit(1);
