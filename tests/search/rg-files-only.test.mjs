import assert from "node:assert/strict";

import { loadModule, run, test } from "./lib/test-helpers.mjs";

// ---------- rg JSON line builders ----------

function rgMatch(path, line, text, subs) {
  return JSON.stringify({
    type: "match",
    data: {
      path: { text: path },
      lines: { text },
      line_number: line,
      absolute_offset: 0,
      submatches: subs.map(([s, e, m]) => ({ match: { text: m }, start: s, end: e })),
    },
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

function opts(overrides = {}) {
  return {
    offset: 0,
    limit: 5,
    beforeContext: 0,
    afterContext: 0,
    naturalEnd: true,
    ...overrides,
  };
}

// ---------- formatRgFilesOnly tests ----------

test("formatRgFilesOnly returns file paths with match counts", async () => {
  const { formatRgFilesOnly } = await loadModule("src/search/rg-output.ts");
  const events = [
    JSON.parse(rgMatch("a.ts", 1, "hello", [[0, 5, "hello"]])),
    JSON.parse(rgMatch("a.ts", 5, "hello", [[0, 5, "hello"]])),
    JSON.parse(rgMatch("b.ts", 3, "world", [[0, 5, "world"]])),
    JSON.parse(rgSummary(3)),
    JSON.parse(rgEnd()),
  ];
  const result = formatRgFilesOnly(events, opts());
  assert.equal(result.details.files.length, 2);
  assert.equal(result.details.files[0].path, "a.ts");
  assert.equal(result.details.files[0].matchCount, 2);
  assert.equal(result.details.files[1].path, "b.ts");
  assert.equal(result.details.files[1].matchCount, 1);
  assert.ok(result.content[0].text.includes("a.ts"));
  assert.ok(result.content[0].text.includes("2 matches"));
  assert.ok(result.content[0].text.includes("b.ts"));
  assert.ok(result.content[0].text.includes("1 match"));
});

test("formatRgFilesOnly pages the file list with offset/limit", async () => {
  const { formatRgFilesOnly } = await loadModule("src/search/rg-output.ts");
  const events = [];
  for (let i = 0; i < 7; i++) {
    events.push(JSON.parse(rgMatch(`file${i}.ts`, 1, "x", [[0, 1, "x"]])));
  }
  events.push(JSON.parse(rgSummary(7)));
  events.push(JSON.parse(rgEnd()));

  // Page 1: files 0-2
  const r1 = formatRgFilesOnly(events, opts({ offset: 0, limit: 3 }));
  assert.equal(r1.details.page.returned, 3);
  assert.equal(r1.details.page.hasMore, true);
  assert.equal(r1.details.page.nextOffset, 3);
  assert.equal(r1.details.files[0].path, "file0.ts");

  // Page 2: files 3-5
  const r2 = formatRgFilesOnly(events, opts({ offset: 3, limit: 3 }));
  assert.equal(r2.details.page.returned, 3);
  assert.equal(r2.details.page.hasMore, true);
  assert.equal(r2.details.page.nextOffset, 6);
  assert.equal(r2.details.files[0].path, "file3.ts");

  // Page 3: file 6 only
  const r3 = formatRgFilesOnly(events, opts({ offset: 6, limit: 3 }));
  assert.equal(r3.details.page.returned, 1);
  assert.equal(r3.details.page.hasMore, false);
  assert.equal(r3.details.page.nextOffset, null);
});

test("formatRgFilesOnly respects content budget", async () => {
  const { formatRgFilesOnly } = await loadModule("src/search/rg-output.ts");
  const events = [];
  for (let i = 0; i < 5; i++) {
    events.push(JSON.parse(rgMatch(`file_with_long_name_${i}.ts`, 1, "x", [[0, 1, "x"]])));
  }
  events.push(JSON.parse(rgSummary(5)));
  events.push(JSON.parse(rgEnd()));

  const result = formatRgFilesOnly(events, opts({ contentBudget: 120 }));
  assert.ok(result.details.page.returned < 5, "budget should limit returned files");
  assert.equal(result.details.truncation.contentBudgetReached, true);
  assert.ok(result.details.page.hasMore, true);
});

test("formatRgFilesOnly returns empty result for no matches", async () => {
  const { formatRgFilesOnly } = await loadModule("src/search/rg-output.ts");
  const events = [
    JSON.parse(rgSummary(0)),
    JSON.parse(rgEnd()),
  ];
  const result = formatRgFilesOnly(events, opts());
  assert.equal(result.details.files.length, 0);
  assert.equal(result.details.page.returned, 0);
  assert.equal(result.details.page.hasMore, false);
  assert.ok(result.content[0].text.includes("No files found"));
});

test("formatRgFilesOnly reports total and hasMore correctly with naturalEnd", async () => {
  const { formatRgFilesOnly } = await loadModule("src/search/rg-output.ts");
  const events = [];
  for (let i = 0; i < 3; i++) {
    events.push(JSON.parse(rgMatch(`f${i}.ts`, 1, "x", [[0, 1, "x"]])));
  }
  events.push(JSON.parse(rgSummary(3)));
  events.push(JSON.parse(rgEnd()));

  const result = formatRgFilesOnly(events, opts({ limit: 2 }));
  assert.equal(result.details.page.returned, 2);
  assert.equal(result.details.page.hasMore, true);
  assert.equal(result.details.page.nextOffset, 2);
  assert.equal(result.details.page.total, 3);
  assert.ok(result.content[0].text.includes("total=3"));
});

await run();
