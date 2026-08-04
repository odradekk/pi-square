import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jiti from "jiti";

const root = mkdtempSync(join(tmpdir(), "pi-square-display-preview-"));
const outside = mkdtempSync(join(tmpdir(), "pi-square-display-preview-outside-"));
const load = jiti(import.meta.url, { moduleCache: false });
const { inspectWritePreview, DISPLAY_FILE_PREVIEW_MAX_BYTES } = await load("../../src/display/file-preview.ts");

try {
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "file.txt"), "before\r\ntext\n");

  const overwrite = await inspectWritePreview(root, "src/file.txt", "after\ntext\n");
  assert.equal(overwrite.kind, "overwrite");
  assert.equal(overwrite.path, "src/file.txt");
  assert.equal(overwrite.before, "before\r\ntext\n");
  assert.equal(overwrite.after, "after\ntext\n");
  assert.equal(overwrite.projected, true);

  const create = await inspectWritePreview(root, "src/new.txt", "new content");
  assert.deepEqual(create, { kind: "create", path: "src/new.txt", after: "new content" });

  const traversal = await inspectWritePreview(root, "../outside.txt", "x");
  assert.equal(traversal.kind, "metadata");
  assert.equal(traversal.reason, "outside");

  writeFileSync(join(outside, "secret.txt"), "secret");
  symlinkSync(join(outside, "secret.txt"), join(root, "escape.txt"));
  const escaped = await inspectWritePreview(root, "escape.txt", "x");
  assert.equal(escaped.kind, "metadata");
  assert.equal(escaped.reason, "outside");
  assert.doesNotMatch(JSON.stringify(escaped), /secret$/);

  symlinkSync(join(root, "src", "file.txt"), join(root, "alias.txt"));
  const alias = await inspectWritePreview(root, "alias.txt", "alias after");
  assert.equal(alias.kind, "overwrite");
  assert.equal(alias.path, "src/file.txt");

  symlinkSync(join(root, "src"), join(root, "alias-dir"));
  const canonicalCreate = await inspectWritePreview(root, "alias-dir/new.txt", "new");
  assert.deepEqual(canonicalCreate, { kind: "create", path: "src/new.txt", after: "new" });

  mkdirSync(join(root, "directory"));
  const directory = await inspectWritePreview(root, "directory", "x");
  assert.equal(directory.kind, "metadata");
  assert.equal(directory.reason, "non-regular");

  writeFileSync(join(root, "large.txt"), "x".repeat(DISPLAY_FILE_PREVIEW_MAX_BYTES + 1));
  const oversized = await inspectWritePreview(root, "large.txt", "x");
  assert.equal(oversized.kind, "metadata");
  assert.equal(oversized.reason, "oversized");
  assert.equal(oversized.size, DISPLAY_FILE_PREVIEW_MAX_BYTES + 1);

  const unresolved = await inspectWritePreview(root, "missing/child.txt", "x");
  assert.equal(unresolved.kind, "metadata");
  assert.equal(unresolved.reason, "unresolved");

  console.log("display file preview tests: OK");
} finally {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
}
