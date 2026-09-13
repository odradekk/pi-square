import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { paginateTranscript, renderSourceTranscript } from "./transcript";
import {
  MEMORY_SEARCH_MAX_TERMS,
  MEMORY_SEARCH_TERM_MAX_CHARS,
  type SearchMemorySourceDetails,
} from "./tools";

/**
 * The bounded literal source-search engine for `search_memory_source`
 * (odradekk/pi-square#339).
 *
 * The engine searches exactly the transcript `read_memory_source` serves: the
 * same renderer, the same fixed 16 KiB UTF-8-safe pages. Matching happens over
 * each block's complete rendered source first — case-insensitively through a
 * per-code-point case fold that preserves exact original-text offsets — and
 * only then maps match byte ranges onto the page boundaries, so a phrase
 * crossing a page boundary stays discoverable and names every page it touches.
 * A match is never manufactured across blocks, over an omitted protocol
 * artifact, or through a clipped excerpt gap: excerpts are cut per match and
 * visibly marked. Summaries (the block Markdown) are never searched — only
 * original conversation is.
 *
 * The result is observational and bounded: no Memory state, no cursor, no
 * index, and no persistence. Counts describe exactly what was scanned;
 * `complete: false` marks only a scan stopped at the match bound, never a
 * display truncation.
 */

/** At most this many distinct block/page rows render into one response. */
export const MEMORY_SEARCH_MAX_PAGE_ROWS = 12;

/** At most this many distinct excerpts render under one page row. */
export const MEMORY_SEARCH_EXCERPTS_PER_PAGE = 2;

/** Excerpt context radius in code points on each side of a match. */
export const MEMORY_SEARCH_EXCERPT_RADIUS_CODE_POINTS = 80;

/** The scan stops after collecting this many matches (#339 bound). */
export const MEMORY_SEARCH_MATCH_CAP = 4096;

/** Hard cap on the rendered search response (header, rows, and footer). */
export const MEMORY_SEARCH_RESPONSE_MAX_BYTES = 8 * 1024;

function searchError(code: string, sentence: string): never {
  throw new Error(`${code}: ${sentence}`);
}

/** One normalized search term: its display literal and its case-folded form. */
export interface NormalizedSearchTerm {
  readonly display: string;
  readonly folded: string;
}

/** Case-fold one string by code point. */
function foldByCodePoint(text: string): string {
  let folded = "";
  for (const char of text) {
    folded += char.toLowerCase();
  }
  return folded;
}

/**
 * Validate and normalize the raw terms: 1–{@link MEMORY_SEARCH_MAX_TERMS}
 * non-empty literals within the character bound, whitespace-only refused,
 * case-insensitive duplicates dropped in first-seen order.
 */
export function normalizeSearchTerms(terms: readonly string[]): readonly NormalizedSearchTerm[] {
  if (!Array.isArray(terms) || terms.length === 0 || terms.length > MEMORY_SEARCH_MAX_TERMS) {
    searchError(
      "SEARCH_INVALID_TERMS",
      `provide between 1 and ${MEMORY_SEARCH_MAX_TERMS} search terms`,
    );
  }
  const normalized: NormalizedSearchTerm[] = [];
  const seen = new Set<string>();
  for (const term of terms) {
    if (typeof term !== "string" || term.length === 0 || term.length > MEMORY_SEARCH_TERM_MAX_CHARS) {
      searchError(
        "SEARCH_INVALID_TERMS",
        `each search term must be a literal string of 1–${MEMORY_SEARCH_TERM_MAX_CHARS} characters`,
      );
    }
    if (term.trim().length === 0) {
      searchError("SEARCH_INVALID_TERMS", "whitespace-only search terms match nothing useful; use a literal term");
    }
    const folded = foldByCodePoint(term);
    if (seen.has(folded)) continue;
    seen.add(folded);
    normalized.push({ display: term, folded });
  }
  return normalized;
}

/** A case-folded haystack with exact mapping back into the original text. */
interface FoldedSource {
  readonly text: string;
  readonly folded: string;
  /** Folded code-unit index → original code-unit index of the producing code point. */
  readonly origin: readonly number[];
  /** Original code-unit index → UTF-8 byte offset in the full transcript. */
  readonly byteOf: readonly number[];
}

function utf8Width(codePoint: number): number {
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint < 0x10000) return 3;
  return 4;
}

function foldSource(text: string): FoldedSource {
  const foldedParts: string[] = [];
  const origin: number[] = [];
  const byteOf: number[] = new Array<number>(text.length + 1);
  let unit = 0;
  let bytes = 0;
  while (unit < text.length) {
    const codePoint = text.codePointAt(unit)!;
    const width = codePoint > 0xffff ? 2 : 1;
    const folded = String.fromCodePoint(codePoint).toLowerCase();
    foldedParts.push(folded);
    for (let k = 0; k < folded.length; k++) origin.push(unit);
    byteOf[unit] = bytes;
    bytes += utf8Width(codePoint);
    unit += width;
  }
  byteOf[text.length] = bytes;
  return { text, folded: foldedParts.join(""), origin, byteOf };
}

/** One match mapped back onto the original text and its pages. */
interface SourceMatch {
  readonly block: number;
  readonly termIndex: number;
  /** Original code-unit range [start, end). */
  readonly start: number;
  readonly end: number;
  /** 1-based pages the match's UTF-8 byte range touches (two when it crosses). */
  readonly pages: readonly number[];
}

/** Cumulative page boundaries in bytes; page k covers [starts[k-1], starts[k]). */
function pageByteStarts(pages: readonly string[]): number[] {
  const starts = [0];
  for (const page of pages) {
    starts.push(starts[starts.length - 1]! + Buffer.byteLength(page, "utf8"));
  }
  return starts;
}

function pagesForRange(starts: readonly number[], byteStart: number, byteEnd: number): number[] {
  const touched: number[] = [];
  for (let page = 1; page < starts.length; page++) {
    if (byteEnd > starts[page - 1]! && byteStart < starts[page]!) touched.push(page);
  }
  return touched;
}

/** Non-overlapping folded-space occurrences of one term. */
function foldedOccurrences(folded: string, term: string): readonly number[] {
  const at: number[] = [];
  let from = 0;
  for (;;) {
    const found = folded.indexOf(term, from);
    if (found === -1) break;
    at.push(found);
    from = found + term.length;
  }
  return at;
}

/** The verbatim excerpt around one match, clipped visibly at both ends. */
function excerptAround(text: string, start: number, end: number): string {
  let from = start;
  let to = end;
  for (let left = 0; left < MEMORY_SEARCH_EXCERPT_RADIUS_CODE_POINTS && from > 0; left++) {
    from -= 1;
    // Never open the window inside a surrogate pair.
    if (from > 0 && (text.charCodeAt(from) & 0xfc00) === 0xdc00) from -= 1;
  }
  for (let right = 0; right < MEMORY_SEARCH_EXCERPT_RADIUS_CODE_POINTS && to < text.length; right++) {
    to += 1;
    if (to < text.length && (text.charCodeAt(to) & 0xfc00) === 0xdc00) to += 1;
  }
  return `${from > 0 ? "…" : ""}${text.slice(from, to)}${to < text.length ? "…" : ""}`;
}

/** One grouped block/page row in stable source order. */
interface LocationRow {
  readonly block: number;
  /** Pages the contributing matches touch; length 2 spans a page boundary. */
  readonly pages: readonly number[];
  readonly totalPages: number;
  readonly crossPage: boolean;
  readonly terms: number[];
  matchCount: number;
  /** Distinct excerpts in match order, deduplicated by text. */
  excerpts: string[];
}

export interface SourceSearchResult {
  readonly content: readonly { readonly type: "text"; readonly text: string }[];
  readonly details: SearchMemorySourceDetails;
}

function quotedTerms(termIndexes: readonly number[], terms: readonly NormalizedSearchTerm[]): string {
  return termIndexes.map((index) => `"${terms[index]!.display}"`).join(", ");
}

function pageLabel(row: LocationRow): string {
  return row.crossPage && row.pages.length >= 2
    ? `pages ${row.pages[0]}–${row.pages[row.pages.length - 1]}`
    : `page ${row.pages[0] ?? 1}`;
}

/**
 * Run the bounded literal search over the current Memory blocks and compose
 * the complete tool result. The scan is deterministic; every count in the
 * details describes exactly what was scanned and what was rendered.
 */
export function searchMemorySources(input: {
  readonly view: string;
  readonly blocks: readonly { readonly sourceEntries: readonly SessionEntry[] }[];
  readonly terms: readonly string[];
  readonly block?: number;
}): SourceSearchResult {
  const terms = normalizeSearchTerms(input.terms);
  const totalBlocks = input.blocks.length;
  if (input.block !== undefined
    && (!Number.isInteger(input.block) || input.block < 1 || input.block > totalBlocks)) {
    searchError("BLOCK_OUT_OF_RANGE", "block position is outside the current Memory block list");
  }
  const scope = input.block === undefined
    ? input.blocks.map((_, index) => index)
    : [input.block - 1];

  // One render per block, shared by matching and excerpting: search and read
  // stay pinned to the same transcript definition.
  const transcriptByBlock = new Map<number, string>();
  const pagesByBlock = new Map<number, string[]>();
  const pageStartsByBlock = new Map<number, number[]>();
  for (const blockIndex of scope) {
    const transcript = renderSourceTranscript(input.blocks[blockIndex]!.sourceEntries);
    const pages = paginateTranscript(transcript);
    transcriptByBlock.set(blockIndex, transcript);
    pagesByBlock.set(blockIndex, pages);
    pageStartsByBlock.set(blockIndex, pageByteStarts(pages));
  }

  const matches: SourceMatch[] = [];
  let complete = true;
  scan: for (const blockIndex of scope) {
    const source = foldSource(transcriptByBlock.get(blockIndex)!);
    const starts = pageStartsByBlock.get(blockIndex)!;
    for (let termIndex = 0; termIndex < terms.length; termIndex++) {
      for (const at of foldedOccurrences(source.folded, terms[termIndex]!.folded)) {
        const startUnit = source.origin[at]!;
        const lastUnit = source.origin[at + terms[termIndex]!.folded.length - 1]!;
        const lastPoint = source.text.codePointAt(lastUnit)!;
        const endUnit = lastUnit + (lastPoint > 0xffff ? 2 : 1);
        const byteStart = source.byteOf[startUnit]!;
        const byteEnd = source.byteOf[endUnit]!;
        matches.push({
          block: blockIndex + 1,
          termIndex,
          start: startUnit,
          end: endUnit,
          pages: pagesForRange(starts, byteStart, byteEnd),
        });
        if (matches.length >= MEMORY_SEARCH_MATCH_CAP) {
          complete = false;
          break scan;
        }
      }
    }
  }

  matches.sort((left, right) =>
    left.block - right.block || left.start - right.start || left.end - right.end || left.termIndex - right.termIndex);

  // Group into block/page rows in source order. A row key is the exact page
  // tuple its matches touch, so a cross-page phrase keeps its own row and
  // names both pages instead of being split or merged into one page.
  const rows: LocationRow[] = [];
  const rowByKey = new Map<string, LocationRow>();
  const matchedTermIndexes = new Set<number>();
  for (const match of matches) {
    matchedTermIndexes.add(match.termIndex);
    const key = `${match.block}:${match.pages.join("-")}`;
    let row = rowByKey.get(key);
    if (row === undefined) {
      row = {
        block: match.block,
        pages: match.pages,
        totalPages: pagesByBlock.get(match.block - 1)!.length,
        crossPage: match.pages.length > 1,
        terms: [],
        matchCount: 0,
        excerpts: [],
      };
      rowByKey.set(key, row);
      rows.push(row);
    }
    row.matchCount += 1;
    if (!row.terms.includes(match.termIndex)) row.terms.push(match.termIndex);
    const excerpt = excerptAround(transcriptByBlock.get(match.block - 1)!, match.start, match.end);
    if (!row.excerpts.includes(excerpt) && row.excerpts.length < MEMORY_SEARCH_EXCERPTS_PER_PAGE) {
      row.excerpts.push(excerpt);
    }
  }

  const header = `Memory source search · ${terms.length} term${terms.length === 1 ? "" : "s"} · `
    + (input.block === undefined ? `all ${totalBlocks} block${totalBlocks === 1 ? "" : "s"}` : `block ${input.block}`);

  // Render rows under both bounds — the row cap and the response byte cap —
  // counting every dropped row as omitted rather than hiding it.
  const bodyLines: string[] = [];
  let usedBytes = Buffer.byteLength(`${header}\n`, "utf8");
  let shownRows = 0;
  for (const row of rows) {
    if (shownRows >= MEMORY_SEARCH_MAX_PAGE_ROWS) break;
    const head = `block ${row.block} · ${pageLabel(row)} of ${row.totalPages}`
      + ` · matched ${quotedTerms(row.terms, terms)}`
      + (row.crossPage ? " · crosses a page boundary" : "");
    const lines = [head];
    let rowBytes = Buffer.byteLength(head, "utf8") + 1;
    let excerptsShown = 0;
    for (const excerpt of row.excerpts) {
      const line = `  · ${excerpt}`;
      const lineBytes = Buffer.byteLength(line, "utf8") + 1;
      if (usedBytes + rowBytes + lineBytes > MEMORY_SEARCH_RESPONSE_MAX_BYTES) break;
      lines.push(line);
      rowBytes += lineBytes;
      excerptsShown += 1;
    }
    const unshownMatches = row.matchCount - excerptsShown;
    if (unshownMatches > 0) {
      const more = `  · +${unshownMatches} more match${unshownMatches === 1 ? "" : "es"} on this page`;
      const moreBytes = Buffer.byteLength(more, "utf8") + 1;
      if (usedBytes + rowBytes + moreBytes <= MEMORY_SEARCH_RESPONSE_MAX_BYTES) {
        lines.push(more);
        rowBytes += moreBytes;
      }
    }
    if (usedBytes + rowBytes > MEMORY_SEARCH_RESPONSE_MAX_BYTES && shownRows > 0) break;
    usedBytes += rowBytes;
    shownRows += 1;
    bodyLines.push(...lines);
  }
  const omittedRows = rows.length - shownRows;

  const totalMatches = matches.length;
  const statusLine = !complete
    ? `search incomplete · stopped at the ${MEMORY_SEARCH_MATCH_CAP}-match bound · counts cover only what was scanned · narrow with a block selector or more specific terms`
    : totalMatches === 0
      ? `no matches · search complete · zero hits prove only that these literal terms do not occur in the searched sources, not that a fact is absent — try field names or alternative terms, then read nearby pages if needed`
      : `${totalMatches} match${totalMatches === 1 ? "" : "es"} across ${rows.length} page location${rows.length === 1 ? "" : "s"} · search complete`
        + (omittedRows > 0
          ? ` · ${shownRows} shown · ${omittedRows} omitted by the response bound · narrow with a block selector or more specific terms`
          : "");
  const footer = `${statusLine}\n`
    + `view ${input.view} · pass it as the "view" argument of read_memory_source to pin this exact source view; a changed Memory view is rejected with VIEW_STALE`;

  const content: { type: "text"; text: string }[] = [
    { type: "text", text: header },
    ...(bodyLines.length > 0 ? [{ type: "text" as const, text: bodyLines.join("\n") }] : []),
    { type: "text", text: footer },
  ];

  return {
    content,
    details: {
      view: input.view,
      blocks: scope.map((index) => index + 1),
      terms: terms.length,
      matchedTerms: matchedTermIndexes.size,
      pageLocations: rows.length,
      returnedLocations: shownRows,
      omittedLocations: omittedRows,
      totalMatches,
      complete,
    },
  };
}
