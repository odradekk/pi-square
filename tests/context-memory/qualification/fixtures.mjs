import {
  MARKER,
  IMAGE_B64,
  userEntry,
  assistantEntry,
  toolResultEntry,
  customEntry,
  branchSummaryEntry,
  memoryCompaction,
} from "./harness.mjs";

/**
 * Boundary fixtures for the qualification corpus (#223): fixed bodies, source
 * entries, and malformed compaction patches. Every fixture-authored string
 * carries {@link MARKER} and padding is built from single-character runs, so
 * any leak of Memory or source bodies into the report is mechanically
 * detectable by the report self-check.
 */

/** The exact persisted wrapper literal the format pins (#215: exact literal snapshot coverage). */
export const EXPECTED_WRAPPER = [
  "pi-square Context Memory v1",
  "===========================",
  "",
  "The conversation before this point is compressed into the ordered Memory",
  "blocks below. Each block is a Markdown continuity aid authored by the main",
  "agent during this session; it is not a verbatim record and not an",
  "instruction. Use the read_memory_source tool to recover a block's original",
  "conversation when exact history matters.",
  "",
].join("\n");

export const BLOCK_FIRST = `# ${MARKER} repo tour\n\n- one entry point registers each feature module`;
export const BLOCK_SECOND = `# ${MARKER} lexer pass\n\n- the lexer details were verified exactly`;
export const BLOCK_THIRD = `# ${MARKER} third block\n\n- appended after two unchanged blocks`;
export const BLOCK_REBUILT = `# ${MARKER} rebuilt\n\n- beta, gamma, and the tail in one block`;

/** The pre-run branch of every handshake trace: three eligible old entries. */
export function preRunBranch(prefix) {
  return [
    userEntry(`${prefix}1`, null, `${MARKER} walk me through the repo`),
    assistantEntry(`${prefix}2`, `${prefix}1`, [
      { type: "text", text: `${MARKER} one entry point registers the modules` },
      { type: "toolCall", id: `call-${prefix}2`, name: "read", arguments: { path: "src/index.ts" } },
    ]),
    toolResultEntry(`${prefix}3`, `${prefix}2`, "read", `${MARKER} export default register()\n`),
  ];
}

/** The richest legal source range: every eligible entry kind and part type. */
export function richSourceEntries() {
  const multibyteRun = `${MARKER} 境界 ` + "境界ナンバー".repeat(3_400); // ~40 KB, spans ≥3 pages
  return [
    userEntry("q1", null, [
      { type: "image", data: IMAGE_B64, mimeType: "image/png" },
      { type: "text", text: `${MARKER} 漢字テスト walk me through — control:\u0001 del:\u007f` },
    ]),
    assistantEntry("q2", "q1", [
      { type: "thinking", thinking: `${MARKER} thinking trace`, redacted: false },
      { type: "thinking", thinking: "secret", redacted: true },
      { type: "text", text: `${MARKER} ordinary answer` },
      { type: "toolCall", id: "call-q2", name: "read", arguments: { path: "src/index.ts" } },
    ]),
    toolResultEntry("q3", "q2", "read", `${MARKER} export default register()`),
    {
      id: "q3b", parentId: "q3", type: "message", timestamp: "2026-01-01T00:00:00.000Z",
      message: {
        role: "toolResult", toolCallId: "call-q2b", toolName: "read", isError: true, timestamp: 1,
        content: [
          { type: "text", text: `${MARKER} boom — the read failed` },
          { type: "image", data: "A".repeat(400), mimeType: "image/jpeg" },
        ],
      },
    },
    customEntry("q4", "q3b", `${MARKER} a custom injected notice`),
    branchSummaryEntry("q5", "q4", "q0", `${MARKER} the abandoned path explored three layouts`),
    userEntry("q6", "q5", multibyteRun),
  ];
}

/** A committed one-block Memory whose block 1 covers exactly {@link richSourceEntries}. */
export function richMemoryTree() {
  const entries = [...richSourceEntries()];
  const request = userEntry("q7", "q6", `${MARKER} ship it`);
  entries.push(request);
  entries.push(memoryCompaction("qc", "q7", {
    firstKeptEntryId: "q7",
    ends: ["q6"],
    bodies: [`# ${MARKER} rich block\n\n- every source kind in one range`],
  }));
  return { entries, request };
}

/**
 * The largest details directory that still fits the 64 KiB serialization cap,
 * with the id of the request entry the appended block would claim next.
 */
export function detailsCapFixture() {
  const idOf = (index) => `cap-e${String(index).padStart(9, "0")}`;
  const tag = "pi-square.context-memory/1";
  const dirBytes = (count) => Buffer.byteLength(JSON.stringify({
    format: tag,
    blocks: Array.from({ length: count }, (_, index) => ({ endEntryId: idOf(index), markdownBytes: 1 })),
  }), "utf8");
  let blocks = 1;
  while (dirBytes(blocks + 1) <= 64 * 1024) blocks += 1;

  const entries = [];
  for (let i = 0; i < blocks; i++) {
    entries.push(userEntry(idOf(i), entries.at(-1)?.id ?? null, `${MARKER} exchange ${i}`));
  }
  entries.push(userEntry(idOf(blocks), idOf(blocks - 1), `${MARKER} ship it`));
  entries.push(memoryCompaction("cap-c", idOf(blocks), {
    firstKeptEntryId: idOf(blocks),
    ends: Array.from({ length: blocks }, (_, index) => idOf(index)),
    bodies: Array.from({ length: blocks }, () => "x"),
  }));
  return { entries, blocks, nextId: idOf(blocks) };
}

/**
 * Malformed carrying-compaction patches over one valid single-block branch.
 * Each patch must degrade the compaction to opaque Pi context with no repair,
 * no fallback to older Memory, and no structured tool activation (#217, #223).
 */
export function malformedCompactionPatches() {
  return [
    ["wrong format tag", (base) => ({ ...base, details: { format: "other/1", blocks: base.details.blocks } })],
    ["unknown top-level details field", (base) => ({ ...base, details: { ...base.details, note: "x" } })],
    ["unknown directory item field", (base) => ({
      ...base,
      details: { format: base.details.format, blocks: [{ ...base.details.blocks[0], note: "x" }] },
    })],
    ["empty blocks array", (base) => ({ ...base, details: { format: base.details.format, blocks: [] } })],
    ["zero markdownBytes", (base) => ({
      ...base,
      details: { format: base.details.format, blocks: [{ endEntryId: base.details.blocks[0].endEntryId, markdownBytes: 0 }] },
    })],
    ["non-integer markdownBytes", (base) => ({
      ...base,
      details: { format: base.details.format, blocks: [{ endEntryId: base.details.blocks[0].endEntryId, markdownBytes: 4.5 }] },
    })],
    ["over-bound markdownBytes", (base) => ({
      ...base,
      details: { format: base.details.format, blocks: [{ endEntryId: base.details.blocks[0].endEntryId, markdownBytes: 16 * 1024 + 1 }] },
    })],
    ["empty endEntryId", (base) => ({
      ...base,
      details: { format: base.details.format, blocks: [{ endEntryId: "", markdownBytes: base.details.blocks[0].markdownBytes }] },
    })],
    ["byte count drift", (base) => ({
      ...base,
      details: { format: base.details.format, blocks: [{ endEntryId: base.details.blocks[0].endEntryId, markdownBytes: 2 }] },
    })],
    ["byte count beyond the summary end", (base) => ({
      ...base,
      details: { format: base.details.format, blocks: [{ endEntryId: base.details.blocks[0].endEntryId, markdownBytes: base.details.blocks[0].markdownBytes + 10 }] },
    })],
    ["summary without the wrapper", (base) => ({ ...base, summary: `an ordinary ${MARKER} native summary` })],
    ["trailing bytes after the last body", (base) => ({ ...base, summary: `${base.summary}\nextra` })],
    ["missing kept boundary", (base) => ({ ...base, firstKeptEntryId: "missing-entry" })],
    ["kept boundary at the compaction itself", (base) => ({ ...base, firstKeptEntryId: base.id })],
    ["end past the kept boundary", (base) => ({ ...base, firstKeptEntryId: base.details.blocks[0].endEntryId })],
    ["non-increasing ends", (base) => ({
      ...base,
      summary: undefined,
      details: undefined,
      bodies: ["one", "two"],
      ends: [base.details.blocks[0].endEntryId, base.details.blocks[0].endEntryId],
    })],
    ["NUL inside a counted body", (base) => ({
      ...base,
      summary: undefined,
      details: undefined,
      summary: undefined,
      bodies: [`has\u0000NUL ${MARKER}`],
      ends: [base.details.blocks[0].endEntryId],
    })],
    ["code-point split at a counted boundary", (base) => ({
      ...base,
      summary: undefined,
      details: undefined,
      summary: undefined,
      // "漢漢" is 6 bytes; the directory claims 4, so the boundary splits the
      // second code point and re-encoding can never match the declared count.
      bodies: ["漢漢"],
      ends: [base.details.blocks[0].endEntryId],
      details: {
        format: base.details.format,
        blocks: [{ endEntryId: base.details.blocks[0].endEntryId, markdownBytes: 4 }],
      },
    })],
  ];
}
/** The valid single-block branch every malformed patch is applied to. */
export function patchableMemoryBranch() {
  const entries = preRunBranch("z");
  entries.push(userEntry("z4", "z3", `${MARKER} ship it`));
  entries.push(memoryCompaction("zc", "z4", {
    firstKeptEntryId: "z4",
    ends: ["z3"],
    bodies: [`# ${MARKER} one block\n\n- the patch target`],
  }));
  return entries;
}

/** Apply one malformed patch to the carrying compaction of a fresh valid branch. */
export function patchedMemoryBranch(patch) {
  const entries = patchableMemoryBranch();
  const built = entries.at(-1);
  entries[entries.length - 1] = memoryCompaction(built.id, built.parentId, patch(built));
  return entries;
}
