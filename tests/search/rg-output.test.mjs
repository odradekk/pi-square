import assert from "node:assert/strict";

import { loadModule, run, test } from "./lib/test-helpers.mjs";

// ---------- rg JSON line builders ----------

// Uses the REAL ripgrep 15.1.0 wire format: byte fields are { "bytes": "BASE64" }
// (a bare string), not a nested { type, input } object.
function rgMatch(path, line, text, subs, opts = {}) {
  const pathField = opts.pathBase64
    ? { bytes: opts.pathBase64 }
    : { text: path };
  const textField = opts.textBase64
    ? { bytes: opts.textBase64 }
    : { text };
  return JSON.stringify({
    type: "match",
    data: {
      path: pathField,
      lines: textField,
      line_number: line,
      absolute_offset: opts.offset ?? 0,
      submatches: subs.map(([s, e, m]) => ({ match: { text: m }, start: s, end: e })),
    },
  });
}

function rgContext(path, line, text, opts = {}) {
  const pathField = opts.pathBase64
    ? { bytes: opts.pathBase64 }
    : { text: path };
  const textField = opts.textBase64
    ? { bytes: opts.textBase64 }
    : { text };
  return JSON.stringify({
    type: "context",
    data: { path: pathField, lines: textField, line_number: line, absolute_offset: 0, submatches: [] },
  });
}

function rgSummary(matches) {
  return JSON.stringify({
    type: "summary",
    data: {
      elapsed_total: { secs: 0, nanos: 0, human: "0ms" },
      stats: { matches, matched_lines: matches, bytes_searched: 100, bytes_printed: 50 },
    },
  });
}

function rgEnd() {
  return JSON.stringify({ type: "end", data: { path: { text: null } } });
}

// ---------- existing behavior tests (19) ----------

test("accumulator handles arbitrary JSON chunk splits", async () => {
  const { RgAccumulator } = await loadModule("src/search/rg-output.ts");
  const raw = rgMatch("a.ts", 1, "hello", [[0, 5, "hello"]]) + "\n" +
    rgMatch("b.ts", 3, "world", [[0, 5, "world"]]) + "\n" +
    rgSummary(2) + "\n" + rgEnd() + "\n";
  const acc = new RgAccumulator({ offset: 0, limit: 5 });
  for (let i = 0; i < raw.length; i += 7) {
    acc.push(raw.slice(i, i + 7));
  }
  const result = acc.finish({ naturalEnd: true, exitCode: 0, stderr: "" });
  assert.equal(result.details.page.returned, 2);
  assert.ok(result.content[0].text.includes("a.ts"));
  assert.ok(result.content[0].text.includes("b.ts"));
});

test("accumulator with no matches returns empty page", async () => {
  const { RgAccumulator } = await loadModule("src/search/rg-output.ts");
  const acc = new RgAccumulator({ offset: 0, limit: 5 });
  acc.push(rgSummary(0) + "\n" + rgEnd() + "\n");
  const result = acc.finish({ naturalEnd: true, exitCode: 1, stderr: "" });
  assert.equal(result.details.page.returned, 0);
  assert.equal(result.details.page.hasMore, false);
  assert.ok(result.content[0].text.includes("No matches found"));
});

test("accumulator groups results by file", async () => {
  const { RgAccumulator } = await loadModule("src/search/rg-output.ts");
  const acc = new RgAccumulator({ offset: 0, limit: 5 });
  acc.push(
    rgMatch("a.ts", 1, "foo", [[0, 3, "foo"]]) + "\n" +
    rgMatch("b.ts", 1, "foo", [[0, 3, "foo"]]) + "\n" +
    rgSummary(2) + "\n" + rgEnd() + "\n",
  );
  const result = acc.finish({ naturalEnd: true, exitCode: 0, stderr: "" });
  assert.equal(result.details.files.length, 2);
  assert.equal(result.details.files[0].path, "a.ts");
  assert.equal(result.details.files[1].path, "b.ts");
});

test("multiple submatches on one line remain one logical result", async () => {
  const { RgAccumulator } = await loadModule("src/search/rg-output.ts");
  const acc = new RgAccumulator({ offset: 0, limit: 5 });
  acc.push(
    rgMatch("a.ts", 1, "foo bar foo", [[0, 3, "foo"], [8, 11, "foo"]]) + "\n" +
    rgSummary(1) + "\n" + rgEnd() + "\n",
  );
  const result = acc.finish({ naturalEnd: true, exitCode: 0, stderr: "" });
  assert.equal(result.details.page.returned, 1);
  const line = result.details.files[0].lines[0];
  assert.equal(line.kind, "match");
  assert.equal(line.submatches.length, 2);
  assert.deepEqual(line.submatches[0], { startByte: 0, endByte: 3 });
  assert.deepEqual(line.submatches[1], { startByte: 8, endByte: 11 });
});

test("column counts Unicode code points, not UTF-8 bytes or UTF-16 units", async () => {
  const { RgAccumulator } = await loadModule("src/search/rg-output.ts");
  // "\u{1F600}\u{1F600}foo" — two 4-byte emoji then foo
  // byte offset of "foo" = 8; code points before = 2; column = 3
  // UTF-16 units before = 4 (two surrogate pairs); would give column 5
  const text = "\u{1F600}\u{1F600}foo";
  const acc = new RgAccumulator({ offset: 0, limit: 5 });
  acc.push(
    rgMatch("a.ts", 1, text, [[8, 11, "foo"]]) + "\n" +
    rgSummary(1) + "\n" + rgEnd() + "\n",
  );
  const result = acc.finish({ naturalEnd: true, exitCode: 0, stderr: "" });
  const col = result.details.files[0].lines[0].column;
  assert.equal(col, 3, `column must be 3 (code points), got ${col}`);
});

test("display metadata maps UTF-8 submatches to safe UTF-16 display ranges", async () => {
  const { RgAccumulator } = await loadModule("src/search/rg-output.ts");
  const text = "a�😀targetz";
  const acc = new RgAccumulator({ offset: 0, limit: 5 });
  acc.push(
    rgMatch("a.ts", 1, text, [[8, 14, "target"]]) + "\n" +
    rgSummary(1) + "\n" + rgEnd() + "\n",
  );
  const result = acc.finish({ naturalEnd: true, exitCode: 0, stderr: "" });
  const display = result.details.files[0].lines[0].display;
  assert.equal(display.text, text);
  assert.deepEqual(display.highlights, [{ start: 4, end: 10 }]);
  assert.equal(display.excerpted, false);
});

test("byte-encoded display uses \\xNN tokens with byte-accurate highlights", async () => {
  const { RgAccumulator } = await loadModule("src/search/rg-output.ts");
  const bytes = Buffer.from([0xff, 0x41, 0x00]);
  const acc = new RgAccumulator({ offset: 0, limit: 5 });
  acc.push(
    rgMatch("a.ts", 1, "unused", [[0, 1, "invalid"]], { textBase64: bytes.toString("base64") }) + "\n" +
    rgSummary(1) + "\n" + rgEnd() + "\n",
  );
  const result = acc.finish({ naturalEnd: true, exitCode: 0, stderr: "" });
  const display = result.details.files[0].lines[0].display;
  assert.equal(display.text, "\\xffA\\x00");
  assert.deepEqual(display.highlights, [{ start: 0, end: 4 }]);
});

test("base64 path and text fields are preserved in details", async () => {
  const { RgAccumulator } = await loadModule("src/search/rg-output.ts");
  const acc = new RgAccumulator({ offset: 0, limit: 5 });
  acc.push(
    rgMatch("binary", 1, "data", [[0, 4, "data"]], {
      pathBase64: "YmluL2Zvby5iaW4=",
      textBase64: "AAAA",
    }) + "\n" +
    rgSummary(1) + "\n" + rgEnd() + "\n",
  );
  const result = acc.finish({ naturalEnd: true, exitCode: 0, stderr: "" });
  const file = result.details.files[0];
  assert.ok(file.rawPathBase64, "rawPathBase64 must be present for byte paths");
  const line = file.lines[0];
  assert.ok(line.rawTextBase64, "rawTextBase64 must be present for byte text");
});

test("details contain exact page, truncation, and file keys", async () => {
  const { RgAccumulator } = await loadModule("src/search/rg-output.ts");
  const acc = new RgAccumulator({ offset: 0, limit: 5 });
  acc.push(rgMatch("a.ts", 1, "x", [[0, 1, "x"]]) + "\n" + rgSummary(1) + "\n" + rgEnd() + "\n");
  const result = acc.finish({ naturalEnd: true, exitCode: 0, stderr: "" });
  const page = result.details.page;
  for (const key of ["offset", "limit", "returned", "hasMore", "nextOffset", "total"]) {
    assert.ok(key in page, `page must have ${key}`);
  }
  const trunc = result.details.truncation;
  for (const key of ["lineExcerpts", "contextLinesOmitted", "contentBudgetReached"]) {
    assert.ok(key in trunc, `truncation must have ${key}`);
  }
  assert.equal(result.details.binary, undefined, "binary is added by tool layer, not accumulator");
});

test("overlapping context windows merge by path and line number", async () => {
  const { RgAccumulator } = await loadModule("src/search/rg-output.ts");
  const acc = new RgAccumulator({ offset: 0, limit: 5, afterContext: 3 });
  // match at line 1 (context 2-3-4), match at line 3 (context 4-5-6)
  // line 4 overlaps -> must appear once
  acc.push(
    rgMatch("a.ts", 1, "m1", [[0, 2, "m1"]]) + "\n" +
    rgContext("a.ts", 2, "c2") + "\n" +
    rgContext("a.ts", 3, "c3") + "\n" +
    rgMatch("a.ts", 4, "m2", [[0, 2, "m2"]]) + "\n" +
    rgContext("a.ts", 5, "c5") + "\n" +
    rgContext("a.ts", 6, "c6") + "\n" +
    rgContext("a.ts", 7, "c7") + "\n" +
    rgSummary(2) + "\n" + rgEnd() + "\n",
  );
  const result = acc.finish({ naturalEnd: true, exitCode: 0, stderr: "" });
  const lines = result.details.files[0].lines;
  const lineNumbers = lines.map((l) => l.line);
  const uniqueLines = [...new Set(lineNumbers)];
  assert.equal(lineNumbers.length, uniqueLines.length, "no duplicate line numbers within a file");
});

test("shouldStop waits for after-context after extra match", async () => {
  const { RgAccumulator } = await loadModule("src/search/rg-output.ts");
  const acc = new RgAccumulator({ offset: 0, limit: 1, afterContext: 2 });
  const m1 = rgMatch("a.ts", 1, "m1", [[0, 2, "m1"]]) + "\n";
  const m2 = rgMatch("a.ts", 2, "m2", [[0, 2, "m2"]]) + "\n"; // extra match
  const c3 = rgContext("a.ts", 3, "c3") + "\n";
  const c4 = rgContext("a.ts", 4, "c4") + "\n";

  acc.push(m1);
  assert.equal(acc.shouldStop(), false, "not yet: only 1 match, need extra");

  acc.push(m2);
  assert.equal(acc.shouldStop(), false, "not yet: extra seen but after-context (lines 3-4) not closed");

  acc.push(c3);
  acc.push(c4);
  assert.equal(acc.shouldStop(), true, "now: extra match seen AND after-context closed");

  const result = acc.finish({ naturalEnd: false, exitCode: null, stderr: "" });
  assert.equal(result.details.page.returned, 1);
  assert.equal(result.details.page.hasMore, true);
});

test("intentional stop discards a trailing partial JSON record", async () => {
  const { RgAccumulator } = await loadModule("src/search/rg-output.ts");
  const acc = new RgAccumulator({ offset: 0, limit: 1, afterContext: 0 });
  acc.push(
    rgMatch("a.ts", 1, "returned", [[0, 8, "returned"]]) + "\n" +
    rgMatch("a.ts", 2, "extra", [[0, 5, "extra"]]) + "\n" +
    '{"type":"context","data":',
  );

  assert.equal(acc.shouldStop(), true, "the complete extra match should request pagination stop");
  const result = acc.finish({ naturalEnd: false, exitCode: null, stderr: "" });
  assert.equal(result.details.page.returned, 1);
  assert.equal(result.details.page.hasMore, true);
});

test("extra match is never rendered as context", async () => {
  const { RgAccumulator } = await loadModule("src/search/rg-output.ts");
  const acc = new RgAccumulator({ offset: 0, limit: 1, afterContext: 2 });
  acc.push(
    rgMatch("a.ts", 1, "returned", [[0, 8, "returned"]]) + "\n" +
    rgMatch("a.ts", 2, "extra-secret", [[0, 12, "extra-secret"]]) + "\n" +
    rgContext("a.ts", 3, "c3") + "\n" +
    rgContext("a.ts", 4, "c4") + "\n",
  );
  const result = acc.finish({ naturalEnd: false, exitCode: null, stderr: "" });
  const text = result.content[0].text;
  assert.ok(!text.includes("extra-secret"), "extra match text must not appear in output");
  const lines = result.details.files[0].lines;
  const contextKinds = lines.filter((l) => l.kind === "context");
  for (const cl of contextKinds) {
    assert.notEqual(cl.text, "extra-secret", "extra match must not be a context line");
  }
});

test("rg excerpts respect injected 300-unit line limit", async () => {
  const { RgAccumulator } = await loadModule("src/search/rg-output.ts");
  const longLine = "x".repeat(800);
  const acc = new RgAccumulator({ offset: 0, limit: 5, lineExcerptLimit: 300 });
  acc.push(
    rgMatch("a.ts", 1, longLine, [[0, 1, "x"]]) + "\n" +
    rgSummary(1) + "\n" + rgEnd() + "\n",
  );
  const result = acc.finish({ naturalEnd: true, exitCode: 0, stderr: "" });
  const text = result.content[0].text;
  // The match line excerpt should not contain the full 800-unit line
  assert.ok(text.length < 800 + 200, "excerpt must be truncated well below raw line length");
  assert.ok(result.details.truncation.lineExcerpts > 0, "lineExcerpts must be positive");
});

test("rg header format: rg returned=N offset=N hasMore=B nextOffset=N|null[ total=N]", async () => {
  const { RgAccumulator } = await loadModule("src/search/rg-output.ts");
  const acc = new RgAccumulator({ offset: 0, limit: 5 });
  acc.push(rgMatch("a.ts", 1, "foo", [[0, 3, "foo"]]) + "\n" + rgSummary(1) + "\n" + rgEnd() + "\n");
  const result = acc.finish({ naturalEnd: true, exitCode: 0, stderr: "" });
  const firstLine = result.content[0].text.split("\n")[0];
  assert.equal(firstLine, "rg returned=1 offset=0 hasMore=false nextOffset=null total=1");
});

test("rg match line uses > LINE:COLUMN | TEXT prefix", async () => {
  const { RgAccumulator } = await loadModule("src/search/rg-output.ts");
  const acc = new RgAccumulator({ offset: 0, limit: 5 });
  acc.push(rgMatch("a.ts", 42, "hello", [[0, 5, "hello"]]) + "\n" + rgSummary(1) + "\n" + rgEnd() + "\n");
  const result = acc.finish({ naturalEnd: true, exitCode: 0, stderr: "" });
  const text = result.content[0].text;
  assert.ok(text.includes("file: a.ts"), "file group must start with 'file: PATH'");
  assert.ok(text.includes("> 42:1 | hello"), "match line must use '> LINE:COLUMN | TEXT'");
});

test("rg context line uses double-space LINE- | TEXT prefix", async () => {
  const { RgAccumulator } = await loadModule("src/search/rg-output.ts");
  const acc = new RgAccumulator({ offset: 0, limit: 5, afterContext: 1 });
  acc.push(
    rgMatch("a.ts", 1, "match", [[0, 5, "match"]]) + "\n" +
    rgContext("a.ts", 2, "ctx") + "\n" +
    rgSummary(1) + "\n" + rgEnd() + "\n",
  );
  const result = acc.finish({ naturalEnd: true, exitCode: 0, stderr: "" });
  assert.ok(result.content[0].text.includes("  2- | ctx"), "context must use '  LINE- | TEXT'");
});

test("content respects injected 12000-unit budget", async () => {
  const { RgAccumulator } = await loadModule("src/search/rg-output.ts");
  const acc = new RgAccumulator({ offset: 0, limit: 50, contentBudget: 200 });
  let raw = "";
  for (let i = 1; i <= 30; i++) {
    raw += rgMatch("a.ts", i, `match${i}padding`.repeat(5), [[0, 6, `match${i}`]]) + "\n";
  }
  raw += rgSummary(30) + "\n" + rgEnd() + "\n";
  acc.push(raw);
  const result = acc.finish({ naturalEnd: true, exitCode: 0, stderr: "" });
  assert.ok(
    result.content[0].text.length <= 200,
    `content must be within budget (got ${result.content[0].text.length})`,
  );
  assert.equal(result.details.truncation.contentBudgetReached, true);
  assert.ok(result.details.page.returned < 30, "not all results fit");
  assert.equal(result.details.page.hasMore, true);
});

test("accumulator rejects output exceeding injected stdout cap", async () => {
  const { RgAccumulator } = await loadModule("src/search/rg-output.ts");
  const acc = new RgAccumulator({ offset: 0, limit: 5, stdoutCap: 10 });
  let rejected = false;
  try {
    acc.push(Buffer.from("x".repeat(200)));
    acc.finish({ naturalEnd: true, exitCode: 0, stderr: "" });
  } catch {
    rejected = true;
  }
  assert.ok(rejected, "must reject output exceeding stdout cap without partial result");
});

test("total is present on natural end, absent on intentional stop", async () => {
  const { RgAccumulator } = await loadModule("src/search/rg-output.ts");

  const accNatural = new RgAccumulator({ offset: 0, limit: 5 });
  accNatural.push(rgMatch("a.ts", 1, "x", [[0, 1, "x"]]) + "\n" + rgSummary(1) + "\n" + rgEnd() + "\n");
  const natural = accNatural.finish({ naturalEnd: true, exitCode: 0, stderr: "" });
  assert.equal(natural.details.page.total, 1);
  assert.ok(natural.content[0].text.includes("total=1"));

  const accStopped = new RgAccumulator({ offset: 0, limit: 1 });
  accStopped.push(
    rgMatch("a.ts", 1, "x", [[0, 1, "x"]]) + "\n" +
    rgMatch("a.ts", 2, "y", [[0, 1, "y"]]) + "\n",
  );
  const stopped = accStopped.finish({ naturalEnd: false, exitCode: null, stderr: "" });
  assert.equal(stopped.details.page.total, undefined, "total must be absent on intentional stop");
  assert.ok(!stopped.content[0].text.includes("total="), "header must omit total on stop");
});

test("accumulator rejects malformed JSON without partial output", async () => {
  const { RgAccumulator } = await loadModule("src/search/rg-output.ts");
  const acc = new RgAccumulator({ offset: 0, limit: 5 });
  acc.push(
    rgMatch("a.ts", 1, "good", [[0, 4, "good"]]) + "\n" +
    "{this is not valid json}\n" +
    rgMatch("b.ts", 2, "also", [[0, 4, "also"]]) + "\n",
  );
  let error = null;
  try {
    acc.finish({ naturalEnd: true, exitCode: 0, stderr: "" });
  } catch (e) {
    error = e;
  }
  assert.ok(error, "must reject malformed JSON");
});

test("formatRgResult produces text and details from parsed events", async () => {
  const { formatRgResult } = await loadModule("src/search/rg-output.ts");
  const events = [
    JSON.parse(rgMatch("a.ts", 1, "hello", [[0, 5, "hello"]])),
    JSON.parse(rgSummary(1)),
    JSON.parse(rgEnd()),
  ];
  const result = formatRgResult(events, {
    offset: 0,
    limit: 5,
    beforeContext: 0,
    afterContext: 0,
    naturalEnd: true,
  });
  assert.ok(result.content[0].text.startsWith("rg returned=1"));
  assert.ok(result.content[0].text.includes("hello"));
  assert.equal(result.details.page.returned, 1);
});

// ---------- regression: real rg bytes JSON wire format ----------

test("real rg bytes format { bytes: BASE64 } is decoded correctly", async () => {
  const { RgAccumulator } = await loadModule("src/search/rg-output.ts");
  // Captured from real ripgrep 15.1.0: lines with invalid UTF-8 use
  // { "bytes": "BASE64" } where bytes is a bare string.
  // "foo\x80bar\n" -> base64 "Zm9vgGJhcgo="
  const realEvent = JSON.stringify({
    type: "match",
    data: {
      path: { text: "byteline.txt" },
      lines: { bytes: "Zm9vgGJhcgo=" },
      line_number: 1,
      absolute_offset: 0,
      submatches: [{ match: { text: "foo" }, start: 0, end: 3 }],
    },
  });
  const acc = new RgAccumulator({ offset: 0, limit: 5 });
  acc.push(realEvent + "\n" + rgSummary(1) + "\n" + rgEnd() + "\n");
  const result = acc.finish({ naturalEnd: true, exitCode: 0, stderr: "" });
  assert.equal(result.details.page.returned, 1);
  const file = result.details.files[0];
  assert.equal(file.pathEncoding, "text");
  const line = file.lines[0];
  assert.equal(line.textEncoding, "bytes");
  // Trailing \n stripped from text
  assert.ok(!line.text.endsWith("\n"), "terminal LF must be stripped");
  // Submatch byte ranges preserved from rg
  assert.deepEqual(line.submatches[0], { startByte: 0, endByte: 3 });
  // rawTextBase64 present for bytes encoding
  assert.ok(line.rawTextBase64, "rawTextBase64 must be present for bytes-encoded lines");
});

test("literal real-format event with byte path and byte lines", async () => {
  const { RgAccumulator } = await loadModule("src/search/rg-output.ts");
  // Real rg event: path with invalid UTF-8 bytes AND lines with bytes.
  // Path bytes "\xff\xfe.bin" -> base64 "//+uLmJpbg==" ... let's use a simpler one.
  // Path: "a\xff.ts" -> base64. We'll use "Y\xff.ts" manually.
  const pathBuf = Buffer.from([0x61, 0xff, 0x2e, 0x74, 0x73]); // "a\xff.ts"
  const lineBuf = Buffer.from([0x6d, 0x61, 0x74, 0x63, 0x68, 0x0a]); // "match\n"
  const realEvent = JSON.stringify({
    type: "match",
    data: {
      path: { bytes: pathBuf.toString("base64") },
      lines: { bytes: lineBuf.toString("base64") },
      line_number: 1,
      absolute_offset: 0,
      submatches: [{ match: { text: "match" }, start: 0, end: 4 }],
    },
  });
  const acc = new RgAccumulator({ offset: 0, limit: 5 });
  acc.push(realEvent + "\n" + rgSummary(1) + "\n" + rgEnd() + "\n");
  const result = acc.finish({ naturalEnd: true, exitCode: 0, stderr: "" });
  const file = result.details.files[0];
  assert.equal(file.pathEncoding, "bytes");
  // Display path escapes the invalid byte
  assert.ok(file.path.includes("\\xff"), "byte path must show \\x escape for invalid byte");
  assert.ok(file.rawPathBase64, "rawPathBase64 must be present");
});

// ---------- regression: invalid-byte path identity ----------

test("two different byte paths decoding to same replacement stay separate", async () => {
  const { RgAccumulator } = await loadModule("src/search/rg-output.ts");
  // \xff and \xfe both decode to U+FFFD via toString("utf-8"), but must
  // remain distinct file groups because their raw bytes differ.
  const path1 = Buffer.from([0xff]); // invalid byte
  const path2 = Buffer.from([0xfe]); // different invalid byte
  const acc = new RgAccumulator({ offset: 0, limit: 5 });
  acc.push(
    rgMatch("dummy", 1, "m1", [[0, 2, "m1"]], { pathBase64: path1.toString("base64") }) + "\n" +
    rgMatch("dummy", 1, "m2", [[0, 2, "m2"]], { pathBase64: path2.toString("base64") }) + "\n" +
    rgSummary(2) + "\n" + rgEnd() + "\n",
  );
  const result = acc.finish({ naturalEnd: true, exitCode: 0, stderr: "" });
  assert.equal(result.details.files.length, 2, "two different byte paths must produce two file groups");
  assert.notEqual(result.details.files[0].path, result.details.files[1].path, "display paths must differ");
  assert.notEqual(result.details.files[0].rawPathBase64, result.details.files[1].rawPathBase64, "raw base64 must differ");
});

// ---------- regression: cwd path normalization ----------

test("absolute path inside cwd becomes cwd-relative", async () => {
  const { formatRgResult } = await loadModule("src/search/rg-output.ts");
  const events = [
    JSON.parse(rgMatch("/home/user/proj/src/a.ts", 1, "hit", [[0, 3, "hit"]])),
    JSON.parse(rgSummary(1)),
    JSON.parse(rgEnd()),
  ];
  const result = formatRgResult(events, {
    offset: 0, limit: 5, beforeContext: 0, afterContext: 0, naturalEnd: true,
    cwd: "/home/user/proj",
  });
  assert.equal(result.details.files[0].path, "src/a.ts");
  assert.ok(result.content[0].text.includes("file: src/a.ts"));
});

test("path equal to cwd becomes dot", async () => {
  const { formatRgResult } = await loadModule("src/search/rg-output.ts");
  const events = [
    JSON.parse(rgMatch("/home/user/proj", 1, "hit", [[0, 3, "hit"]])),
    JSON.parse(rgSummary(1)),
    JSON.parse(rgEnd()),
  ];
  const result = formatRgResult(events, {
    offset: 0, limit: 5, beforeContext: 0, afterContext: 0, naturalEnd: true,
    cwd: "/home/user/proj",
  });
  assert.equal(result.details.files[0].path, ".");
});

test("Windows path inside cwd becomes relative with forward slashes", async () => {
  const { formatRgResult } = await loadModule("src/search/rg-output.ts");
  const events = [
    JSON.parse(rgMatch("c:\\users\\foo\\src\\a.ts", 1, "hit", [[0, 3, "hit"]])),
    JSON.parse(rgSummary(1)),
    JSON.parse(rgEnd()),
  ];
  const result = formatRgResult(events, {
    offset: 0, limit: 5, beforeContext: 0, afterContext: 0, naturalEnd: true,
    cwd: "C:\\Users\\foo",
    platform: "win32",
  });
  assert.equal(result.details.files[0].path, "src/a.ts");
});

test("Windows path on another drive remains absolute", async () => {
  const { formatRgResult } = await loadModule("src/search/rg-output.ts");
  const events = [
    JSON.parse(rgMatch("D:\\src\\a.ts", 1, "hit", [[0, 3, "hit"]])),
    JSON.parse(rgSummary(1)),
    JSON.parse(rgEnd()),
  ];
  const result = formatRgResult(events, {
    offset: 0, limit: 5, beforeContext: 0, afterContext: 0, naturalEnd: true,
    cwd: "C:\\Users\\foo",
    platform: "win32",
  });
  assert.equal(result.details.files[0].path, "D:/src/a.ts");
});

test("absolute path outside cwd remains absolute", async () => {
  const { formatRgResult } = await loadModule("src/search/rg-output.ts");
  const events = [
    JSON.parse(rgMatch("/etc/passwd", 1, "root", [[0, 4, "root"]])),
    JSON.parse(rgSummary(1)),
    JSON.parse(rgEnd()),
  ];
  const result = formatRgResult(events, {
    offset: 0, limit: 5, beforeContext: 0, afterContext: 0, naturalEnd: true,
    cwd: "/home/user/proj",
  });
  assert.equal(result.details.files[0].path, "/etc/passwd");
});

test("relative path with leading dot-slash loses the prefix", async () => {
  const { formatRgResult } = await loadModule("src/search/rg-output.ts");
  const events = [
    JSON.parse(rgMatch("./src/a.ts", 1, "hit", [[0, 3, "hit"]])),
    JSON.parse(rgSummary(1)),
    JSON.parse(rgEnd()),
  ];
  const result = formatRgResult(events, {
    offset: 0, limit: 5, beforeContext: 0, afterContext: 0, naturalEnd: true,
    cwd: "/home/user/proj",
  });
  assert.equal(result.details.files[0].path, "src/a.ts");
});

test("cwd normalization does not merge two different byte paths", async () => {
  const { RgAccumulator } = await loadModule("src/search/rg-output.ts");
  const path1 = Buffer.from([0xff]);
  const path2 = Buffer.from([0xfe]);
  const acc = new RgAccumulator({ offset: 0, limit: 5, cwd: "/home/user/proj" });
  acc.push(
    rgMatch("dummy", 1, "m1", [[0, 2, "m1"]], { pathBase64: path1.toString("base64") }) + "\n" +
    rgMatch("dummy", 1, "m2", [[0, 2, "m2"]], { pathBase64: path2.toString("base64") }) + "\n" +
    rgSummary(2) + "\n" + rgEnd() + "\n",
  );
  const result = acc.finish({ naturalEnd: true, exitCode: 0, stderr: "" });
  assert.equal(result.details.files.length, 2, "byte paths must stay separate regardless of cwd");
});

// ---------- regression: line-ending cleanup ----------

test("terminal LF is stripped from match line text", async () => {
  const { RgAccumulator } = await loadModule("src/search/rg-output.ts");
  const acc = new RgAccumulator({ offset: 0, limit: 5 });
  // Real rg includes trailing \n in lines.text
  acc.push(
    rgMatch("a.ts", 1, "hello world\n", [[0, 5, "hello"]]) + "\n" +
    rgSummary(1) + "\n" + rgEnd() + "\n",
  );
  const result = acc.finish({ naturalEnd: true, exitCode: 0, stderr: "" });
  const line = result.details.files[0].lines[0];
  assert.equal(line.text, "hello world", "trailing \\n must be stripped");
  assert.ok(!result.content[0].text.includes("hello world\n\n"), "no literal \\n noise in output");
});

test("terminal CRLF is stripped from match line text", async () => {
  const { RgAccumulator } = await loadModule("src/search/rg-output.ts");
  const acc = new RgAccumulator({ offset: 0, limit: 5 });
  acc.push(
    rgMatch("a.ts", 1, "hello world\r\n", [[0, 5, "hello"]]) + "\n" +
    rgSummary(1) + "\n" + rgEnd() + "\n",
  );
  const result = acc.finish({ naturalEnd: true, exitCode: 0, stderr: "" });
  const line = result.details.files[0].lines[0];
  assert.equal(line.text, "hello world", "trailing \\r\\n must be stripped");
});

test("terminal LF is stripped from context line text", async () => {
  const { RgAccumulator } = await loadModule("src/search/rg-output.ts");
  const acc = new RgAccumulator({ offset: 0, limit: 5, afterContext: 1 });
  acc.push(
    rgMatch("a.ts", 1, "match\n", [[0, 5, "match"]]) + "\n" +
    rgContext("a.ts", 2, "context line\n") + "\n" +
    rgSummary(1) + "\n" + rgEnd() + "\n",
  );
  const result = acc.finish({ naturalEnd: true, exitCode: 0, stderr: "" });
  const lines = result.details.files[0].lines;
  const ctx = lines.find((l) => l.kind === "context");
  assert.ok(ctx, "must have a context line");
  assert.equal(ctx.text, "context line", "trailing \\n must be stripped from context");
});

test("byte-encoded line: LF stripped and submatch ranges preserved", async () => {
  const { RgAccumulator } = await loadModule("src/search/rg-output.ts");
  // "match\n" as base64 bytes
  const lineBytes = Buffer.from("match\n", "utf-8");
  const acc = new RgAccumulator({ offset: 0, limit: 5 });
  acc.push(
    rgMatch("a.ts", 1, "unused", [[0, 5, "match"]], { textBase64: lineBytes.toString("base64") }) + "\n" +
    rgSummary(1) + "\n" + rgEnd() + "\n",
  );
  const result = acc.finish({ naturalEnd: true, exitCode: 0, stderr: "" });
  const line = result.details.files[0].lines[0];
  assert.equal(line.text, "match", "trailing \\n stripped from byte-encoded line");
  assert.deepEqual(line.submatches[0], { startByte: 0, endByte: 5 }, "submatch ranges preserved");
  // rawTextBase64 should correspond to stripped bytes
  const decoded = Buffer.from(line.rawTextBase64, "base64").toString("utf-8");
  assert.equal(decoded, "match", "rawTextBase64 must match stripped text");
});

// ---------- regression: stdout cap permanent failure ----------

test("finish throws after stdout cap overflow even if push error is caught", async () => {
  const { RgAccumulator } = await loadModule("src/search/rg-output.ts");
  // Cap large enough for one valid match event, but not for a second large chunk.
  const firstEvent = rgMatch("a.ts", 1, "hi", [[0, 2, "hi"]]) + "\n";
  const acc = new RgAccumulator({ offset: 0, limit: 5, stdoutCap: firstEvent.length + 10 });
  // First push some valid data (fits within cap)
  acc.push(firstEvent);
  // Overflow
  try {
    acc.push(Buffer.from("x".repeat(200)));
  } catch {
    // expected
  }
  // finish must also throw — no partial data
  let finishError = null;
  try {
    acc.finish({ naturalEnd: true, exitCode: 0, stderr: "" });
  } catch (e) {
    finishError = e;
  }
  assert.ok(finishError, "finish must throw after cap overflow");
  assert.ok(
    finishError.message.includes("cap"),
    `error must mention cap, got: ${finishError.message}`,
  );
});

test("push after cap overflow throws again", async () => {
  const { RgAccumulator } = await loadModule("src/search/rg-output.ts");
  const acc = new RgAccumulator({ offset: 0, limit: 5, stdoutCap: 10 });
  try { acc.push(Buffer.from("x".repeat(200))); } catch { /* expected */ }
  let secondError = null;
  try {
    acc.push(Buffer.from("y"));
  } catch (e) {
    secondError = e;
  }
  assert.ok(secondError, "push after overflow must throw");
});

// ---------- regression: overlong-result error ----------

test("overlong result throws instead of returning empty page with hasMore", async () => {
  const { RgAccumulator } = await loadModule("src/search/rg-output.ts");
  // Budget so small that even one file header + match cannot fit
  const acc = new RgAccumulator({ offset: 0, limit: 5, contentBudget: 10 });
  acc.push(
    rgMatch("a.ts", 1, "hello", [[0, 5, "hello"]]) + "\n" +
    rgSummary(1) + "\n" + rgEnd() + "\n",
  );
  let error = null;
  try {
    acc.finish({ naturalEnd: true, exitCode: 0, stderr: "" });
  } catch (e) {
    error = e;
  }
  assert.ok(error, "must throw overlong-result error");
  assert.ok(
    error.message.includes("content budget"),
    `error must mention content budget, got: ${error.message}`,
  );
});

test("overlong result throws when path itself is too long for budget", async () => {
  const { formatRgResult } = await loadModule("src/search/rg-output.ts");
  const longPath = "x".repeat(200);
  const events = [
    JSON.parse(rgMatch(longPath, 1, "m", [[0, 1, "m"]])),
    JSON.parse(rgSummary(1)),
    JSON.parse(rgEnd()),
  ];
  let error = null;
  try {
    formatRgResult(events, {
      offset: 0, limit: 5, beforeContext: 0, afterContext: 0, naturalEnd: true,
      contentBudget: 50,
    });
  } catch (e) {
    error = e;
  }
  assert.ok(error, "must throw when path + match exceeds budget");
});

// ---------- regression: control char escaping in file headers ----------

test("control characters in text path are escaped in file header", async () => {
  const { formatRgResult } = await loadModule("src/search/rg-output.ts");
  // Path containing a tab and newline
  const events = [
    JSON.parse(rgMatch("a\tb\nc.ts", 1, "hit", [[0, 3, "hit"]])),
    JSON.parse(rgSummary(1)),
    JSON.parse(rgEnd()),
  ];
  const result = formatRgResult(events, {
    offset: 0, limit: 5, beforeContext: 0, afterContext: 0, naturalEnd: true,
  });
  const text = result.content[0].text;
  assert.ok(text.includes("\\t"), "tab in path must be escaped");
  assert.ok(text.includes("\\n"), "newline in path must be escaped");
  assert.ok(!text.includes("a\tb"), "raw tab must not appear in output");
});

// ---------- regression: deterministic continuation marker ----------

test("continuation marker includes omitted count and nextOffset", async () => {
  const { RgAccumulator } = await loadModule("src/search/rg-output.ts");
  const acc = new RgAccumulator({ offset: 0, limit: 1, afterContext: 2 });
  acc.push(
    rgMatch("a.ts", 1, "first", [[0, 5, "first"]]) + "\n" +
    rgMatch("a.ts", 2, "second", [[0, 6, "second"]]) + "\n" +
    rgMatch("a.ts", 3, "third", [[0, 5, "third"]]) + "\n" +
    rgContext("a.ts", 4, "ctx4") + "\n",
  );
  const result = acc.finish({ naturalEnd: false, exitCode: null, stderr: "" });
  const text = result.content[0].text;
  // Must include omitted count (2 extra matches on lines 2 and 3)
  assert.ok(text.includes("+2 omitted"), "continuation must include omitted match count");
  // Must include nextOffset (offset 0 + returned 1 = 1)
  assert.ok(text.includes("nextOffset=1"), "continuation must include nextOffset");
  // Must NOT include the extra match text
  assert.ok(!text.includes("second"), "extra match text must not appear");
  assert.ok(!text.includes("third"), "extra match text must not appear");
  assert.deepEqual(result.details.files[0].continuation, { omitted: 2, nextOffset: 1 });
});

test("continuation marker is absent when no extra matches in context window", async () => {
  const { RgAccumulator } = await loadModule("src/search/rg-output.ts");
  const acc = new RgAccumulator({ offset: 0, limit: 5, afterContext: 1 });
  acc.push(
    rgMatch("a.ts", 1, "only", [[0, 4, "only"]]) + "\n" +
    rgContext("a.ts", 2, "ctx") + "\n" +
    rgSummary(1) + "\n" + rgEnd() + "\n",
  );
  const result = acc.finish({ naturalEnd: true, exitCode: 0, stderr: "" });
  assert.ok(
    !result.content[0].text.includes("omitted"),
    "no continuation marker when no extra matches",
  );
});

await run();
