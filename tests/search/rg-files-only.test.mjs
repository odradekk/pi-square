import assert from "node:assert/strict";

import { loadModule, run, test } from "./lib/test-helpers.mjs";

// ---------- rg JSON match event builder ----------

// Produces a parsed match event in the ripgrep --json wire format.
function matchEvent(path, line, text, subs = [[0, text.length, text]]) {
  return {
    type: "match",
    data: {
      path: { text: path },
      lines: { text },
      line_number: line,
      absolute_offset: 0,
      submatches: subs.map(([s, e, m]) => ({ match: { text: m }, start: s, end: e })),
    },
  };
}

// ---------- formatRgFilesOnly tests ----------

test("filesOnly basic shape: 3 matches across 2 files with correct counts and no match text", async () => {
  const { formatRgFilesOnly } = await loadModule("src/search/rg-output.ts");
  const events = [
    matchEvent("a.ts", 1, "secret-data"),
    matchEvent("a.ts", 5, "secret-data"),
    matchEvent("b.ts", 1, "secret-data"),
  ];
  const result = formatRgFilesOnly(events, {
    offset: 0,
    limit: 10,
    beforeContext: 0,
    afterContext: 0,
    naturalEnd: true,
  });
  assert.equal(result.details.files.length, 2);
  assert.equal(result.details.files[0].path, "a.ts");
  assert.equal(result.details.files[0].matchCount, 2);
  assert.equal(result.details.files[1].path, "b.ts");
  assert.equal(result.details.files[1].matchCount, 1);
  // Match text must not appear anywhere in the output.
  assert.ok(!result.content[0].text.includes("secret-data"), "match text must not appear in output");
  // files entries must carry matchCount, not lines.
  for (const file of result.details.files) {
    assert.ok(!("lines" in file), "filesOnly entries must not have lines");
    assert.ok("matchCount" in file, "filesOnly entries must have matchCount");
  }
});

test("filesOnly paging with offset=1 limit=1 on 3 files returns 1 file with hasMore", async () => {
  const { formatRgFilesOnly } = await loadModule("src/search/rg-output.ts");
  const events = [
    matchEvent("a.ts", 1, "hit"),
    matchEvent("b.ts", 1, "hit"),
    matchEvent("c.ts", 1, "hit"),
  ];
  const result = formatRgFilesOnly(events, {
    offset: 1,
    limit: 1,
    beforeContext: 0,
    afterContext: 0,
    naturalEnd: true,
  });
  assert.equal(result.details.files.length, 1);
  assert.equal(result.details.files[0].path, "b.ts");
  assert.equal(result.details.page.hasMore, true);
  assert.equal(result.details.page.nextOffset, 2);
});

test("filesOnly content budget truncates excess files", async () => {
  const { formatRgFilesOnly } = await loadModule("src/search/rg-output.ts");
  const events = [
    matchEvent("first-file.ts", 1, "hit"),
    matchEvent("second-file.ts", 1, "hit"),
    matchEvent("third-file.ts", 1, "hit"),
    matchEvent("fourth-file.ts", 1, "hit"),
    matchEvent("fifth-file.ts", 1, "hit"),
  ];
  const result = formatRgFilesOnly(events, {
    offset: 0,
    limit: 10,
    beforeContext: 0,
    afterContext: 0,
    naturalEnd: true,
    contentBudget: 100,
  });
  assert.equal(result.details.truncation.contentBudgetReached, true);
  assert.ok(result.details.files.length < 5, "not all files fit under budget");
  assert.ok(result.content[0].text.length <= 100, "text must be within budget");
});

test("filesOnly empty result returns zero files", async () => {
  const { formatRgFilesOnly } = await loadModule("src/search/rg-output.ts");
  const result = formatRgFilesOnly([], {
    offset: 0,
    limit: 10,
    beforeContext: 0,
    afterContext: 0,
    naturalEnd: true,
  });
  assert.equal(result.details.page.returned, 0);
  assert.equal(result.details.files.length, 0);
  assert.equal(result.details.page.hasMore, false);
});

test("filesOnly hasMore detection with more files than limit", async () => {
  const { formatRgFilesOnly } = await loadModule("src/search/rg-output.ts");
  const events = [
    matchEvent("a.ts", 1, "hit"),
    matchEvent("b.ts", 1, "hit"),
    matchEvent("c.ts", 1, "hit"),
  ];
  const result = formatRgFilesOnly(events, {
    offset: 0,
    limit: 2,
    beforeContext: 0,
    afterContext: 0,
    naturalEnd: true,
  });
  assert.equal(result.details.files.length, 2);
  assert.equal(result.details.page.hasMore, true);
  assert.equal(result.details.page.nextOffset, 2);
});

await run();
