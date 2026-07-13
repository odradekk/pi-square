import assert from "node:assert/strict";

import { loadModule, run, test } from "./lib/test-helpers.mjs";

// ---------- fd NUL-delimited path helpers ----------

function pathsToNul(paths) {
  return Buffer.from(paths.map((p) => p + "\0").join(""));
}

function bufPathsToNul(bufs) {
  const parts = bufs.map((b) => Buffer.concat([b, Buffer.from([0])]));
  return Buffer.concat(parts);
}

// ---------- tests ----------

test("accumulator handles NUL-delimited chunks split at arbitrary boundaries", async () => {
  const { FdAccumulator } = await loadModule("src/search/fd-output.ts");
  const raw = pathsToNul(["src/a.ts", "src/b.ts", "src/c.ts"]);
  const acc = new FdAccumulator({ offset: 0, limit: 10 });
  for (let i = 0; i < raw.length; i += 5) {
    acc.push(raw.subarray(i, i + 5));
  }
  const result = acc.finish({ naturalEnd: true, exitCode: 0, stderr: "" });
  assert.equal(result.details.page.returned, 3);
  assert.equal(result.details.page.total, 3);
});

test("invalid UTF-8 records are kept distinct with base64 details", async () => {
  const { FdAccumulator } = await loadModule("src/search/fd-output.ts");
  const bad1 = Buffer.from([0x66, 0xff, 0xfe, 0x6f]); // fo + invalid bytes + o
  const bad2 = Buffer.from([0x62, 0xff, 0x61, 0x72]); // b + invalid + ar
  const acc = new FdAccumulator({ offset: 0, limit: 10 });
  acc.push(bufPathsToNul([bad1, bad2]));
  const result = acc.finish({ naturalEnd: true, exitCode: 0, stderr: "" });
  const bytePaths = result.details.paths.filter((p) => p.encoding === "bytes");
  assert.equal(bytePaths.length, 2, "both invalid records must be present and distinct");
  for (const p of bytePaths) {
    assert.ok(p.rawBase64, "byte paths must have rawBase64");
  }
  const base64Set = new Set(bytePaths.map((p) => p.rawBase64));
  assert.equal(base64Set.size, 2, "distinct raw bytes must produce distinct base64");
});

test("duplicate records are not removed", async () => {
  const { FdAccumulator } = await loadModule("src/search/fd-output.ts");
  const acc = new FdAccumulator({ offset: 0, limit: 10 });
  acc.push(pathsToNul(["dup.ts", "dup.ts", "dup.ts"]));
  const result = acc.finish({ naturalEnd: true, exitCode: 0, stderr: "" });
  assert.equal(result.details.page.total, 3);
  assert.equal(result.details.page.returned, 3);
});

test("newline and tab in paths are escaped in display", async () => {
  const { FdAccumulator } = await loadModule("src/search/fd-output.ts");
  const acc = new FdAccumulator({ offset: 0, limit: 10 });
  acc.push(bufPathsToNul([Buffer.from("foo\tbar\nbaz")]));
  const result = acc.finish({ naturalEnd: true, exitCode: 0, stderr: "" });
  const p = result.details.paths[0];
  assert.ok(p.displayPath.includes("\\t"), "tab must be escaped");
  assert.ok(p.displayPath.includes("\\n"), "newline must be escaped");
});

test("valid UTF-8 paths have encoding text and unescaped normalized path", async () => {
  const { FdAccumulator } = await loadModule("src/search/fd-output.ts");
  const acc = new FdAccumulator({ offset: 0, limit: 10 });
  acc.push(pathsToNul(["src/foo.ts"]));
  const result = acc.finish({ naturalEnd: true, exitCode: 0, stderr: "" });
  const p = result.details.paths[0];
  assert.equal(p.encoding, "text");
  assert.ok(p.path, "valid UTF-8 path must have unescaped normalized path field");
  assert.equal(p.rawBase64, undefined);
});

test("Linux paths are normalized without conflation", async () => {
  const { FdAccumulator } = await loadModule("src/search/fd-output.ts");
  const acc = new FdAccumulator({ offset: 0, limit: 10 });
  acc.push(pathsToNul(["src/a.ts", "src/b.ts"]));
  const result = acc.finish({ naturalEnd: true, exitCode: 0, stderr: "" });
  assert.equal(result.details.paths.length, 2);
  assert.equal(result.details.paths[0].path, "src/a.ts");
  assert.equal(result.details.paths[1].path, "src/b.ts");
});

test("Windows drive paths are normalized with injected platform", async () => {
  const { FdAccumulator } = await loadModule("src/search/fd-output.ts");
  const acc = new FdAccumulator({ offset: 0, limit: 10, platform: "win32" });
  acc.push(bufPathsToNul([Buffer.from("C:\\Users\\foo\\bar.ts"), Buffer.from("D:\\baz.ts")]));
  const result = acc.finish({ naturalEnd: true, exitCode: 0, stderr: "" });
  assert.equal(result.details.paths.length, 2);
  for (const p of result.details.paths) {
    assert.ok(!p.displayPath.includes("\\"), "backslashes must be normalized to forward slashes");
  }
});

test("Windows UNC paths are normalized with injected platform", async () => {
  const { FdAccumulator } = await loadModule("src/search/fd-output.ts");
  const acc = new FdAccumulator({ offset: 0, limit: 10, platform: "win32" });
  acc.push(bufPathsToNul([Buffer.from("\\\\server\\share\\file.ts")]));
  const result = acc.finish({ naturalEnd: true, exitCode: 0, stderr: "" });
  assert.equal(result.details.paths.length, 1);
  assert.ok(result.details.paths[0].displayPath.length > 0, "UNC path must produce a display path");
});

test("raw deterministic sorting uses byte order, not locale", async () => {
  const { FdAccumulator } = await loadModule("src/search/fd-output.ts");
  const acc = new FdAccumulator({ offset: 0, limit: 10 });
  acc.push(pathsToNul(["b", "A", "B", "a", "c"]));
  const result = acc.finish({ naturalEnd: true, exitCode: 0, stderr: "" });
  const order = result.details.paths.map((p) => p.path);
  // ASCII byte order: A(0x41) B(0x42) a(0x61) b(0x62) c(0x63)
  assert.deepEqual(order, ["A", "B", "a", "b", "c"]);
});

test("exact total is returned after complete scan", async () => {
  const { FdAccumulator } = await loadModule("src/search/fd-output.ts");
  const acc = new FdAccumulator({ offset: 0, limit: 3 });
  acc.push(pathsToNul(["a", "b", "c", "d", "e"]));
  const result = acc.finish({ naturalEnd: true, exitCode: 0, stderr: "" });
  assert.equal(result.details.page.total, 5);
  assert.equal(result.details.page.returned, 3);
});

test("offset paging skips entries correctly", async () => {
  const { FdAccumulator } = await loadModule("src/search/fd-output.ts");
  const acc = new FdAccumulator({ offset: 2, limit: 2 });
  acc.push(pathsToNul(["a", "b", "c", "d", "e"]));
  const result = acc.finish({ naturalEnd: true, exitCode: 0, stderr: "" });
  assert.equal(result.details.page.offset, 2);
  assert.equal(result.details.page.returned, 2);
  const paths = result.details.paths.map((p) => p.path);
  assert.deepEqual(paths, ["c", "d"]);
  assert.equal(result.details.page.nextOffset, 4);
});

test("content respects injected budget at path boundaries", async () => {
  const { FdAccumulator } = await loadModule("src/search/fd-output.ts");
  const acc = new FdAccumulator({ offset: 0, limit: 50, contentBudget: 100 });
  const paths = Array.from({ length: 20 }, (_, i) => `path/number${i}.ts`);
  acc.push(pathsToNul(paths));
  const result = acc.finish({ naturalEnd: true, exitCode: 0, stderr: "" });
  assert.ok(
    result.content[0].text.length <= 100,
    `content must be within budget (got ${result.content[0].text.length})`,
  );
  assert.ok(result.details.page.returned < 20, "not all paths fit");
  assert.equal(result.details.page.hasMore, true);
});

test("single overlong path returns error, not zero-progress page", async () => {
  const { FdAccumulator } = await loadModule("src/search/fd-output.ts");
  const acc = new FdAccumulator({ offset: 0, limit: 5, contentBudget: 50 });
  const long = "x".repeat(200);
  acc.push(pathsToNul([long]));
  let error = null;
  try {
    acc.finish({ naturalEnd: true, exitCode: 0, stderr: "" });
  } catch (e) {
    error = e;
  }
  assert.ok(error, "overlong path must produce an error, not a zero-progress page");
});

test("accumulator rejects output exceeding injected stdout cap without partial output", async () => {
  const { FdAccumulator } = await loadModule("src/search/fd-output.ts");
  const acc = new FdAccumulator({ offset: 0, limit: 5, stdoutCap: 10 });
  let rejected = false;
  try {
    acc.push(pathsToNul(["aaaaaaaaaa", "bbbbbbbbbb", "cccccccccc"]));
    acc.finish({ naturalEnd: true, exitCode: 0, stderr: "" });
  } catch {
    rejected = true;
  }
  assert.ok(rejected, "must reject without partial output");
});

test("fd header format: fd returned=N offset=N total=N hasMore=B nextOffset=N|null", async () => {
  const { FdAccumulator } = await loadModule("src/search/fd-output.ts");
  const acc = new FdAccumulator({ offset: 0, limit: 2 });
  acc.push(pathsToNul(["a", "b", "c"]));
  const result = acc.finish({ naturalEnd: true, exitCode: 0, stderr: "" });
  const firstLine = result.content[0].text.split("\n")[0];
  assert.equal(firstLine, "fd returned=2 offset=0 total=3 hasMore=true nextOffset=2");
});

test("formatFdResult produces text and details from raw path buffers", async () => {
  const { formatFdResult } = await loadModule("src/search/fd-output.ts");
  const rawPaths = [Buffer.from("a.ts"), Buffer.from("b.ts")];
  const result = formatFdResult(rawPaths, { offset: 0, limit: 5 });
  assert.ok(result.content[0].text.startsWith("fd returned=2"));
  assert.equal(result.details.page.total, 2);
  assert.equal(result.details.paths.length, 2);
});

// ---------- Cwd contract regressions ----------

test("POSIX: absolute path inside cwd becomes cwd-relative", async () => {
  const { FdAccumulator } = await loadModule("src/search/fd-output.ts");
  const acc = new FdAccumulator({ offset: 0, limit: 10, cwd: "/home/user" });
  acc.push(pathsToNul(["/home/user/src/a.ts"]));
  const result = acc.finish({ naturalEnd: true, exitCode: 0, stderr: "" });
  assert.equal(result.details.paths[0].path, "src/a.ts");
});

test("POSIX: absolute path outside cwd stays absolute", async () => {
  const { FdAccumulator } = await loadModule("src/search/fd-output.ts");
  const acc = new FdAccumulator({ offset: 0, limit: 10, cwd: "/home/user" });
  acc.push(pathsToNul(["/etc/passwd"]));
  const result = acc.finish({ naturalEnd: true, exitCode: 0, stderr: "" });
  assert.equal(result.details.paths[0].path, "/etc/passwd");
});

test("POSIX: sibling directory with shared prefix is not stripped", async () => {
  const { FdAccumulator } = await loadModule("src/search/fd-output.ts");
  const acc = new FdAccumulator({ offset: 0, limit: 10, cwd: "/home/user" });
  acc.push(pathsToNul(["/home/usertest/file.ts"]));
  const result = acc.finish({ naturalEnd: true, exitCode: 0, stderr: "" });
  assert.equal(result.details.paths[0].path, "/home/usertest/file.ts");
});

test("POSIX: relative path with leading ./ loses the prefix", async () => {
  const { FdAccumulator } = await loadModule("src/search/fd-output.ts");
  const acc = new FdAccumulator({ offset: 0, limit: 10 });
  acc.push(pathsToNul(["./src/a.ts"]));
  const result = acc.finish({ naturalEnd: true, exitCode: 0, stderr: "" });
  assert.equal(result.details.paths[0].path, "src/a.ts");
});

test("POSIX: path equal to cwd becomes dot", async () => {
  const { FdAccumulator } = await loadModule("src/search/fd-output.ts");
  const acc = new FdAccumulator({ offset: 0, limit: 10, cwd: "/home/user" });
  acc.push(pathsToNul(["/home/user"]));
  const result = acc.finish({ naturalEnd: true, exitCode: 0, stderr: "" });
  assert.equal(result.details.paths[0].path, ".");
});

test("POSIX: root cwd returns dot for root and relative names for descendants", async () => {
  const { FdAccumulator } = await loadModule("src/search/fd-output.ts");
  const acc = new FdAccumulator({ offset: 0, limit: 10, cwd: "/" });
  acc.push(pathsToNul(["/", "/src/a.ts"]));
  const result = acc.finish({ naturalEnd: true, exitCode: 0, stderr: "" });
  assert.deepEqual(result.details.paths.map((entry) => entry.path), [".", "src/a.ts"]);
});

test("Windows: same-drive path inside cwd becomes relative (case-insensitive)", async () => {
  const { FdAccumulator } = await loadModule("src/search/fd-output.ts");
  const acc = new FdAccumulator({ offset: 0, limit: 10, cwd: "C:\\Users\\foo", platform: "win32" });
  acc.push(bufPathsToNul([Buffer.from("c:\\users\\foo\\bar.ts")]));
  const result = acc.finish({ naturalEnd: true, exitCode: 0, stderr: "" });
  assert.equal(result.details.paths[0].path, "bar.ts");
});

test("Windows: drive-root cwd returns relative descendants", async () => {
  const { FdAccumulator } = await loadModule("src/search/fd-output.ts");
  const acc = new FdAccumulator({ offset: 0, limit: 10, cwd: "C:\\", platform: "win32" });
  acc.push(bufPathsToNul([Buffer.from("c:\\src\\a.ts"), Buffer.from("C:\\")]));
  const result = acc.finish({ naturalEnd: true, exitCode: 0, stderr: "" });
  assert.deepEqual(result.details.paths.map((entry) => entry.path), [".", "src/a.ts"]);
});

test("Windows: different-drive path stays absolute", async () => {
  const { FdAccumulator } = await loadModule("src/search/fd-output.ts");
  const acc = new FdAccumulator({ offset: 0, limit: 10, cwd: "C:\\Users\\foo", platform: "win32" });
  acc.push(bufPathsToNul([Buffer.from("D:\\baz.ts")]));
  const result = acc.finish({ naturalEnd: true, exitCode: 0, stderr: "" });
  assert.equal(result.details.paths[0].path, "D:/baz.ts");
});

test("Windows: UNC path stays absolute when cwd is a drive path", async () => {
  const { FdAccumulator } = await loadModule("src/search/fd-output.ts");
  const acc = new FdAccumulator({ offset: 0, limit: 10, cwd: "C:\\Users\\foo", platform: "win32" });
  acc.push(bufPathsToNul([Buffer.from("\\\\server\\share\\file.ts")]));
  const result = acc.finish({ naturalEnd: true, exitCode: 0, stderr: "" });
  assert.equal(result.details.paths[0].path, "//server/share/file.ts");
});

test("Windows: UNC path inside UNC cwd becomes relative (case-insensitive)", async () => {
  const { FdAccumulator } = await loadModule("src/search/fd-output.ts");
  const acc = new FdAccumulator({ offset: 0, limit: 10, cwd: "\\\\Server\\Share\\dir", platform: "win32" });
  acc.push(bufPathsToNul([Buffer.from("\\\\server\\share\\dir\\file.ts")]));
  const result = acc.finish({ naturalEnd: true, exitCode: 0, stderr: "" });
  assert.equal(result.details.paths[0].path, "file.ts");
});

test("invalid UTF-8 absolute path inside cwd has prefix stripped at byte level, identity preserved", async () => {
  const { FdAccumulator } = await loadModule("src/search/fd-output.ts");
  // /home/user/ followed by invalid bytes
  const raw = Buffer.concat([Buffer.from("/home/user/"), Buffer.from([0xff, 0xfe, 0x61])]);
  const acc = new FdAccumulator({ offset: 0, limit: 10, cwd: "/home/user" });
  acc.push(bufPathsToNul([raw]));
  const result = acc.finish({ naturalEnd: true, exitCode: 0, stderr: "" });
  const p = result.details.paths[0];
  assert.equal(p.encoding, "bytes");
  const decoded = Buffer.from(p.rawBase64, "base64");
  assert.deepEqual(Array.from(decoded), [0xff, 0xfe, 0x61]);
});

// ---------- Completion contract regressions ----------

test("finish rejects when final record lacks NUL terminator", async () => {
  const { FdAccumulator } = await loadModule("src/search/fd-output.ts");
  const acc = new FdAccumulator({ offset: 0, limit: 10 });
  acc.push(Buffer.from("a\0b\0c"));
  let error = null;
  try {
    acc.finish({ naturalEnd: true, exitCode: 0, stderr: "" });
  } catch (e) {
    error = e;
  }
  assert.ok(error, "must reject incomplete NUL stream");
});

test("finish rejects when naturalEnd is false", async () => {
  const { FdAccumulator } = await loadModule("src/search/fd-output.ts");
  const acc = new FdAccumulator({ offset: 0, limit: 10 });
  acc.push(pathsToNul(["a", "b"]));
  let error = null;
  try {
    acc.finish({ naturalEnd: false, exitCode: 0, stderr: "" });
  } catch (e) {
    error = e;
  }
  assert.ok(error, "must reject non-natural completion");
});

test("finish rejects when exitCode is non-zero", async () => {
  const { FdAccumulator } = await loadModule("src/search/fd-output.ts");
  const acc = new FdAccumulator({ offset: 0, limit: 10 });
  acc.push(pathsToNul(["a", "b"]));
  let error = null;
  try {
    acc.finish({ naturalEnd: true, exitCode: 1, stderr: "" });
  } catch (e) {
    error = e;
  }
  assert.ok(error, "must reject non-zero exit code");
});

test("finish rejects when exitCode is null", async () => {
  const { FdAccumulator } = await loadModule("src/search/fd-output.ts");
  const acc = new FdAccumulator({ offset: 0, limit: 10 });
  acc.push(pathsToNul(["a", "b"]));
  let error = null;
  try {
    acc.finish({ naturalEnd: true, exitCode: null, stderr: "" });
  } catch (e) {
    error = e;
  }
  assert.ok(error, "must reject null exit code");
});

test("empty output is valid and produces no paths", async () => {
  const { FdAccumulator } = await loadModule("src/search/fd-output.ts");
  const acc = new FdAccumulator({ offset: 0, limit: 10 });
  const result = acc.finish({ naturalEnd: true, exitCode: 0, stderr: "" });
  assert.equal(result.details.page.total, 0);
  assert.equal(result.details.paths.length, 0);
});

test("overlong path error reports offset and length without embedding path or control characters", async () => {
  const { FdAccumulator } = await loadModule("src/search/fd-output.ts");
  const acc = new FdAccumulator({ offset: 0, limit: 5, contentBudget: 50 });
  const long = "ab\tcd\nef".repeat(30);
  acc.push(pathsToNul([long]));
  let error = null;
  try {
    acc.finish({ naturalEnd: true, exitCode: 0, stderr: "" });
  } catch (e) {
    error = e;
  }
  assert.ok(error);
  const msg = error.message;
  assert.ok(msg.includes("offset 0"), "must report offset");
  assert.ok(/length \d+/.test(msg), "must report encoded length");
  assert.ok(msg.includes("50"), "must report budget");
  assert.ok(!msg.includes("\t") && !msg.includes("\n"), "no raw control chars in message");
  assert.ok(!msg.includes("ab"), "no path content in message");
});

await run();
