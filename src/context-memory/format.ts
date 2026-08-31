/**
 * The v1 Context Memory persisted format (odradekk/pi-square#215, #217).
 *
 * Pi's latest compaction entry on the current leaf is the complete carrier of
 * all current Memory blocks. The model-visible compaction `summary` carries
 * the fixed wrapper followed by every block body; the extension metadata
 * `details` carries only the format tag plus an ordered byte directory that
 * makes the summary mechanically parseable without reserving any delimiter
 * inside user-authored Markdown (#215: "Parse arbitrary block Markdown by the
 * versioned wrapper and byte directory").
 *
 * The wrapper, separator, and tag literals are package-owned, deterministic,
 * versioned, and contain no dynamic identifiers, timestamps, or token counts.
 * They have exact literal snapshot coverage; changing any of them is a format
 * change that invalidates every existing compaction (old entries become
 * opaque Pi summaries, never repaired or guessed).
 */


/** Extension metadata format tag identifying Context Memory details (v1). */
export const MEMORY_FORMAT_TAG = "pi-square.context-memory/1";

/** Hard cap on the full `details` JSON serialization (64 KiB UTF-8). */
export const MEMORY_DETAILS_MAX_BYTES = 64 * 1024;

/** One Memory block body is at most 16 KiB canonical UTF-8 (#215). */
export const MEMORY_BLOCK_MAX_BYTES = 16 * 1024;

/**
 * Fixed wrapper opening every Context Memory compaction summary. Rendered as
 * Markdown; ends with a single newline. The wrapper is both the model-visible
 * explanation of what Memory is and the exact byte prefix parsing requires.
 */
export const MEMORY_SUMMARY_WRAPPER = [
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

/**
 * Fixed framing between the wrapper and the first block body, and between
 * adjacent block bodies. Parsing never scans for this literal inside user
 * Markdown: block boundaries come from the details byte directory, and the
 * separator is only required at the computed byte positions.
 */
export const MEMORY_BLOCK_SEPARATOR = "\n---\n\n";

/** One directory item: the block's inclusive source range end and exact body size. */
export interface MemoryDirectoryItem {
  readonly endEntryId: string;
  readonly markdownBytes: number;
}

/** Extension metadata carried by a Context Memory compaction entry. */
export interface MemoryCompactionDetails {
  readonly format: typeof MEMORY_FORMAT_TAG;
  readonly blocks: readonly MemoryDirectoryItem[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Strict `details` validation for parsing: exact field set, exact format tag,
 * non-empty ordered directory, integer byte counts within the block bound,
 * and the full serialization within the 64 KiB cap. Unknown top-level or item
 * fields are rejected (#215).
 */
export function parseMemoryDetails(details: unknown): MemoryCompactionDetails | undefined {
  if (!isPlainObject(details)) return undefined;
  const keys = Object.keys(details).sort();
  if (keys.length !== 2 || keys[0] !== "blocks" || keys[1] !== "format") return undefined;
  if (details.format !== MEMORY_FORMAT_TAG) return undefined;
  if (!Array.isArray(details.blocks) || details.blocks.length === 0) return undefined;
  const blocks: MemoryDirectoryItem[] = [];
  for (const item of details.blocks) {
    if (!isPlainObject(item)) return undefined;
    const itemKeys = Object.keys(item).sort();
    if (itemKeys.length !== 2 || itemKeys[0] !== "endEntryId" || itemKeys[1] !== "markdownBytes") return undefined;
    const endEntryId = item.endEntryId;
    const markdownBytes = item.markdownBytes;
    if (typeof endEntryId !== "string" || endEntryId.length === 0) return undefined;
    if (typeof markdownBytes !== "number" || !Number.isInteger(markdownBytes)) return undefined;
    if (markdownBytes < 1 || markdownBytes > MEMORY_BLOCK_MAX_BYTES) return undefined;
    blocks.push({ endEntryId, markdownBytes });
  }
  const serialized = Buffer.byteLength(JSON.stringify({ format: details.format, blocks }), "utf8");
  if (serialized > MEMORY_DETAILS_MAX_BYTES) return undefined;
  return { format: MEMORY_FORMAT_TAG, blocks };
}

/** Block body content rules shared by parsing and (#218) submission. */
export function isValidMemoryBlockBody(markdown: string): boolean {
  if (typeof markdown !== "string" || markdown.length === 0) return false;
  if (Buffer.byteLength(markdown, "utf8") > MEMORY_BLOCK_MAX_BYTES) return false;
  // NUL and C0 control characters other than tab/newline/carriage return are
  // prohibited in Memory block bodies (#215).
  for (const char of markdown) {
    const code = char.codePointAt(0)!;
    if (code === 0 || (code < 0x20 && char !== "\t" && char !== "\n" && char !== "\r")) return false;
  }
  return true;
}

/**
 * Parse the compaction `summary` against the validated byte directory:
 * the summary must begin with the exact wrapper literal, each block body must
 * be reachable at its computed byte position through the fixed separator, and
 * the last body must end exactly at the summary end. Any deviation — missing
 * wrapper, wrong byte counts, trailing bytes, invalid body content — makes
 * the compaction opaque, with no guessed repair and no fallback to older
 * Memory entries (#217).
 */
export function parseMemorySummary(
  summary: string,
  directory: MemoryCompactionDetails,
): readonly string[] | undefined {
  if (typeof summary !== "string") return undefined;
  const bytes = Buffer.from(summary, "utf8");
  const wrapperBytes = Buffer.from(MEMORY_SUMMARY_WRAPPER, "utf8");
  const separatorBytes = Buffer.from(MEMORY_BLOCK_SEPARATOR, "utf8");
  if (bytes.length < wrapperBytes.length) return undefined;
  if (!bytes.subarray(0, wrapperBytes.length).equals(wrapperBytes)) return undefined;

  const bodies: string[] = [];
  let offset = wrapperBytes.length;
  for (const item of directory.blocks) {
    if (bytes.length < offset + separatorBytes.length) return undefined;
    if (!bytes.subarray(offset, offset + separatorBytes.length).equals(separatorBytes)) return undefined;
    offset += separatorBytes.length;
    if (offset + item.markdownBytes > bytes.length) return undefined;
    const body = bytes.subarray(offset, offset + item.markdownBytes).toString("utf8");
    // A boundary that splits a code point decodes to U+FFFD, which would be a
    // silent repair. Re-encoding a split body never matches its declared byte
    // count, so this rejects the compaction instead of guessing (#215).
    if (Buffer.byteLength(body, "utf8") !== item.markdownBytes) return undefined;
    if (!isValidMemoryBlockBody(body)) return undefined;
    bodies.push(body);
    offset += item.markdownBytes;
  }
  if (offset !== bytes.length) return undefined;
  return bodies;
}

/**
 * Compose a compaction `summary` from ordered block bodies — the inverse of
 * {@link parseMemorySummary} and the single composition path #218's submission
 * transaction will reuse. Bodies are used exactly as provided; validity is the
 * caller's responsibility.
 */
export function composeMemorySummary(bodies: readonly string[]): string {
  return MEMORY_SUMMARY_WRAPPER + bodies.map((body) => MEMORY_BLOCK_SEPARATOR + body).join("");
}
