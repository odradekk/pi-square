import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import jiti from "jiti";

const root = mkdtempSync(join(tmpdir(), "pi-square-shell-output-"));
const load = jiti(import.meta.url, { moduleCache: false });
const { ShellOutputAccumulator } = await load(resolve(import.meta.dirname, "..", "..", "src", "shell", "output.ts"));

try {
  {
    const output = new ShellOutputAccumulator({ maxLines: 10, maxBytes: 100, tempFilePath: () => join(root, "small.log") });
    const bytes = Buffer.from("A😀中B\n", "utf8");
    output.append(bytes.subarray(0, 3));
    output.append(bytes.subarray(3, 7));
    output.append(bytes.subarray(7));
    output.finish();
    const snapshot = output.snapshot();
    assert.equal(snapshot.content, "A😀中B\n");
    assert.equal(snapshot.truncation.truncated, false);
    assert.equal(snapshot.fullOutputPath, undefined);
    await output.close();
  }

  {
    const fullPath = join(root, "lines.log");
    const output = new ShellOutputAccumulator({ maxLines: 3, maxBytes: 100, tempFilePath: () => fullPath });
    output.append(Buffer.from("one\ntwo\nthree\nfour\nfive\n"));
    output.finish();
    const snapshot = output.snapshot({ persistIfTruncated: true });
    assert.equal(snapshot.truncation.truncated, true);
    assert.equal(snapshot.truncation.truncatedBy, "lines");
    assert.equal(snapshot.content, "three\nfour\nfive");
    assert.equal(snapshot.fullOutputPath, fullPath);
    await output.close();
    assert.equal(readFileSync(fullPath, "utf8"), "one\ntwo\nthree\nfour\nfive\n");
    if (process.platform !== "win32") assert.equal(statSync(fullPath).mode & 0o777, 0o600);
  }

  {
    const output = new ShellOutputAccumulator({
      maxLines: 1,
      maxBytes: 1,
      tempFilePath: () => join(root, "missing", "output.log"),
    });
    output.append(Buffer.from("too much output"));
    output.finish();
    await assert.rejects(() => output.close(), /ENOENT/);
  }

  {
    const fullPath = join(root, "bytes.log");
    const output = new ShellOutputAccumulator({ maxLines: 20, maxBytes: 8, tempFilePath: () => fullPath });
    output.append(Buffer.from("0123456789abcdef"));
    output.finish();
    const snapshot = output.snapshot({ persistIfTruncated: true });
    assert.equal(snapshot.truncation.truncated, true);
    assert.equal(snapshot.truncation.truncatedBy, "bytes");
    assert.match(snapshot.content, /cdef$/);
    assert.ok(Buffer.byteLength(snapshot.content, "utf8") <= 8);
    await output.close();
    assert.equal(readFileSync(fullPath, "utf8"), "0123456789abcdef");
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("shell output accumulator tests: OK");
