import assert from "node:assert/strict";
import jiti from "jiti";

const load = jiti(import.meta.url, { moduleCache: false });
const {
  MEMORY_BLOCK_MAX_BYTES,
  MEMORY_DETAILS_MAX_BYTES,
  MEMORY_BLOCK_SEPARATOR,
  MEMORY_FORMAT_TAG,
  MEMORY_SUMMARY_WRAPPER,
  composeMemorySummary,
  isValidMemoryBlockBody,
  parseMemoryDetails,
  parseMemorySummary,
} = await load("../../src/context-memory/format.ts");
const { paginateTranscript, MEMORY_SOURCE_PAGE_MAX_BYTES } = await load("../../src/context-memory/transcript.ts");

function directory(...items) {
  return { format: MEMORY_FORMAT_TAG, blocks: items };
}

function item(endEntryId, markdownBytes) {
  return { endEntryId, markdownBytes };
}

// ─── details validation: exact shape, bounds, strictness ───────────

{
  const bytes = (text) => Buffer.byteLength(text, "utf8");
  const body1 = "# First block\n\nexact text";
  const body2 = "second block with ünïcödé";
  const details = directory(item("e2", bytes(body1)), item("e5", bytes(body2)));
  const parsed = parseMemoryDetails(details);
  assert.ok(parsed, "a strict two-block directory parses");
  assert.equal(parsed.format, MEMORY_FORMAT_TAG);
  assert.deepEqual(parsed.blocks, [
    { endEntryId: "e2", markdownBytes: bytes(body1) },
    { endEntryId: "e5", markdownBytes: bytes(body2) },
  ]);

  const rejections = [
    ["undefined", undefined],
    ["null", null],
    ["array", []],
    ["missing blocks", { format: MEMORY_FORMAT_TAG }],
    ["missing format", { blocks: [item("e1", 4)] }],
    ["unknown top-level field", { format: MEMORY_FORMAT_TAG, blocks: [item("e1", 4)], extra: 1 }],
    ["wrong format tag", { format: "pi-square.context-memory/2", blocks: [item("e1", 4)] }],
    ["empty blocks array", directory()],
    ["unknown item field", directory({ endEntryId: "e1", markdownBytes: 4, note: "x" })],
    ["missing item field", directory({ endEntryId: "e1" })],
    ["empty endEntryId", item("", 4)],
    ["non-string endEntryId", item(7, 4)],
    ["zero markdownBytes", item("e1", 0)],
    ["negative markdownBytes", item("e1", -3)],
    ["non-integer markdownBytes", item("e1", 4.5)],
    ["over-bound block", item("e1", MEMORY_BLOCK_MAX_BYTES + 1)],
  ];
  for (const [label, value] of rejections) {
    assert.equal(parseMemoryDetails(value), undefined, `${label} details are rejected`);
  }

  // The 64 KiB hard cap on the full details serialization.
  const manySmall = directory(...Array.from({ length: 1700 }, (_, i) => item(`entry-${i}-padding-pad`, 8)));
  assert.ok(
    JSON.stringify(manySmall).length > MEMORY_DETAILS_MAX_BYTES,
    "fixture really exceeds the serialization cap",
  );
  assert.equal(parseMemoryDetails(manySmall), undefined, "an over-cap details serialization is rejected");
  const justUnder = directory(...Array.from({ length: 100 }, (_, i) => item(`entry-${i}`, 4096)));
  assert.notEqual(parseMemoryDetails(justUnder), undefined, "a within-cap directory parses");
}

// ─── summary parsing: wrapper, byte directory, exact framing ───────

{
  const body1 = "# Fix login flow\n\n- session cookie set before redirect\n- redirect kept relative";
  const body2 = "second block";
  const summary = composeMemorySummary([body1, body2]);
  assert.ok(summary.startsWith(MEMORY_SUMMARY_WRAPPER), "the composed summary opens with the wrapper");
  const directoryTwo = directory(item("e2", Buffer.byteLength(body1, "utf8")), item("e5", Buffer.byteLength(body2, "utf8")));
  const bodies = parseMemorySummary(summary, directoryTwo);
  assert.deepEqual(bodies, [body1, body2], "byte-directory parsing recovers exact block bodies");

  // Round-trip stability: parse(compose(x)) === x with multibyte bodies.
  const multibyte = "## 中文记忆\n\n— émigré naïve —\n\n漢字とひらがな";
  const round = composeMemorySummary([multibyte, body2]);
  const parsedRound = parseMemorySummary(round, directory(
    item("e2", Buffer.byteLength(multibyte, "utf8")),
    item("e5", Buffer.byteLength(body2, "utf8")),
  ));
  assert.deepEqual(parsedRound, [multibyte, body2], "multibyte bodies round-trip exactly");
}

// ─── #219: appending preserves every existing byte exactly ─────────

{
  const body1 = "# First\n\n- exact bytes survive an append";
  const body2 = "# Second\n\n- appended after the unchanged prefix";
  const body3 = "# Third\n\n— multibyte tail —";
  const one = composeMemorySummary([body1]);
  const two = composeMemorySummary([body1, body2]);
  const three = composeMemorySummary([body1, body2, body3]);

  // Append-only divergence: each longer rendering keeps the complete
  // previous rendering as its exact byte prefix and adds only the separator
  // plus the new body after it.
  assert.ok(two.startsWith(one), "appending keeps the previous rendering byte-identical");
  assert.ok(three.startsWith(two), "a repeated append keeps the two-block rendering byte-identical");
  assert.equal(two.slice(one.length), MEMORY_BLOCK_SEPARATOR + body2,
    "divergence begins exactly at the separator before the new body");
  assert.equal(three.slice(two.length), MEMORY_BLOCK_SEPARATOR + body3);

  // The first directory entries are carried unchanged; each append adds
  // exactly one ordered item.
  const bytes = (text) => Buffer.byteLength(text, "utf8");
  const dirOne = directory(item("e3", bytes(body1)));
  const dirTwo = directory(item("e3", bytes(body1)), item("e7", bytes(body2)));
  const dirThree = directory(item("e3", bytes(body1)), item("e7", bytes(body2)), item("e9", bytes(body3)));
  assert.deepEqual(dirTwo.blocks.slice(0, 1), dirOne.blocks, "existing directory entries stay byte-identical");
  assert.deepEqual(dirThree.blocks.slice(0, 2), dirTwo.blocks);
  assert.equal(dirThree.blocks.length, 3, "the append adds exactly one directory item");

  // Repeated rendering of the same list is byte-identical (compose is
  // deterministic; no timestamps or dynamic identifiers participate).
  assert.equal(composeMemorySummary([body1, body2, body3]), three);
}

{
  const body = "# one";
  const valid = directory(item("e1", Buffer.byteLength(body, "utf8")));
  const composed = composeMemorySummary([body]);
  const rejections = [
    ["no wrapper prefix", `Not Context Memory\n${body}`],
    ["trailing bytes", `${composed}\nextra`],
    ["byte count too small", composed.slice(0, composed.length - 1)],
    ["byte count too large", `${composed}x`],
    ["empty summary", ""],
    ["non-string summary", undefined],
  ];
  for (const [label, value] of rejections) {
    assert.equal(parseMemorySummary(value, valid), undefined, `${label} is rejected`);
  }

  // A directory whose second count no longer matches the summary fails
  // without partial repair.
  const two = composeMemorySummary(["one", "two"]);
  assert.equal(
    parseMemorySummary(two, directory(item("e1", 3), item("e5", 5))),
    undefined,
    "a wrong second byte count is rejected",
  );
}

{
  // The separator may appear inside user Markdown: boundaries come from the
  // byte directory, never from scanning for the literal.
  const body1 = `before${MEMORY_BLOCK_SEPARATOR}inside user markdown`;
  const body2 = "after";
  const summary = composeMemorySummary([body1, body2]);
  const parsed = parseMemorySummary(
    summary,
    directory(item("e1", Buffer.byteLength(body1, "utf8")), item("e2", Buffer.byteLength(body2, "utf8"))),
  );
  assert.deepEqual(parsed, [body1, body2], "a separator inside a body is not a block boundary");
}

// ─── block body content rules ──────────────────────────────────────

{
  assert.ok(isValidMemoryBlockBody("plain text"), "plain text is valid");
  assert.ok(isValidMemoryBlockBody("tabs\tand\nnewlines\r\nallowed"), "tab/newline/carriage return are allowed");
  assert.ok(isValidMemoryBlockBody("漢".repeat(100)), "multibyte text is valid");
  assert.equal(isValidMemoryBlockBody(""), false, "empty body is invalid");
  assert.equal(isValidMemoryBlockBody("has\u0000NUL"), false, "NUL is invalid");
  assert.equal(isValidMemoryBlockBody("has\u0001control"), false, "C0 control characters are invalid");

  const exactlyMax = "a".repeat(MEMORY_BLOCK_MAX_BYTES);
  assert.ok(isValidMemoryBlockBody(exactlyMax), "exactly 16 KiB is valid");
  assert.equal(isValidMemoryBlockBody(`${exactlyMax}x`), false, "over 16 KiB is invalid");

  // A summary carrying a NUL inside a counted body is malformed.
  const nulBody = "has\u0000NUL";
  const summary = composeMemorySummary([nulBody]);
  assert.equal(
    parseMemorySummary(summary, directory(item("e1", Buffer.byteLength(nulBody, "utf8")))),
    undefined,
    "a NUL inside a counted body makes the compaction malformed",
  );
}

// ─── fixed 16 KiB code-point-safe paging ───────────────────────────

{
  const page = MEMORY_SOURCE_PAGE_MAX_BYTES;
  assert.deepEqual(paginateTranscript(""), [], "an empty transcript has no pages");

  const small = "context-memory source transcript v1\n\n[user]\nhello\n";
  assert.deepEqual(paginateTranscript(small), [small], "a page-sized transcript is one exact page");

  const exactly = "a".repeat(page);
  assert.deepEqual(paginateTranscript(exactly), [exactly], "exactly 16 KiB is one page");

  const over = `b`.repeat(page + 1);
  const pages = paginateTranscript(over);
  assert.equal(pages.length, 2, "16 KiB + 1 byte is two pages");
  assert.equal(Buffer.byteLength(pages[0], "utf8"), page, "the first page is a full page");

  // A multibyte code point straddling the boundary moves wholly to the next
  // page: page one backs off to the code-point start, page two starts with it.
  const straddle = `${"a".repeat(page - 2)}漢${"c".repeat(10)}`;
  const straddlePages = paginateTranscript(straddle);
  assert.equal(straddlePages.length, 2);
  assert.equal(Buffer.byteLength(straddlePages[0], "utf8"), page - 2, "the boundary backs off to the code point");
  assert.ok(straddlePages[1].startsWith("漢"), "the straddling code point starts page two intact");
  assert.equal(straddlePages.join(""), straddle, "pages reassemble the transcript exactly");
  for (const p of straddlePages) {
    assert.ok(Buffer.byteLength(p, "utf8") <= page, "no page exceeds 16 KiB");
    assert.ok(!/\uFFFD/.test(p), "no page contains a replacement character");
  }

  // Long multi-page transcripts reassemble exactly with fixed page counts.
  const long = paginateTranscript(`${"x".repeat(page * 3 - 7)}`);
  assert.equal(long.length, 3, "page count is ceil(bytes/16 KiB)");
  assert.equal(long.join(""), "x".repeat(page * 3 - 7));
}

console.log("context-memory format tests: OK");
