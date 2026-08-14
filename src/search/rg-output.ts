// Incremental rg JSON accumulator and result formatter.
//
// Frames newline-delimited JSON across arbitrary Buffer chunks, counts raw
// bytes against a cap before any decode, decodes text/base64 fields with
// explicit encoding metadata, converts UTF-8 byte offsets to one-based
// Unicode-code-point columns, counts one logical result per path/line,
// merges overlapping context windows, and emits a continuation marker for
// extra matches inside a returned match's context window instead of
// rendering them as context lines.

import { posix, win32 } from "node:path";

import {
  CONTENT_BUDGET,
  DEFAULT_LIMIT,
  DEFAULT_OFFSET,
  MIN_CONTEXT,
  RG_LINE_EXCERPT_LIMIT,
  STDOUT_CAP,
} from "./contracts";
import type {
  DisplayRange,
  LineKind,
  PageDetails,
  RgFileDetail,
  RgFileOnlyDetail,
  RgLineDetail,
  RgLineDisplay,
  Submatch,
  TextContent,
  TextEncoding,
  TruncationDetails,
} from "./contracts";

// ---------- option / result types ----------

interface AccumulatorOptions {
  offset?: number;
  limit?: number;
  cwd?: string;
  platform?: string;
  beforeContext?: number;
  afterContext?: number;
  stdoutCap?: number;
  lineExcerptLimit?: number;
  contentBudget?: number;
}

interface FinishOptions {
  naturalEnd: boolean;
  exitCode: number | null;
  stderr: string;
}

interface FormatOptions {
  offset: number;
  limit: number;
  beforeContext: number;
  afterContext: number;
  naturalEnd: boolean;
  cwd?: string;
  platform?: string;
  lineExcerptLimit?: number;
  contentBudget?: number;
}

interface RgResult {
  content: TextContent[];
  details: {
    page: PageDetails;
    truncation: TruncationDetails;
    files: RgFileDetail[];
  };
}

interface FilesOnlyResult {
  content: TextContent[];
  details: {
    page: PageDetails;
    truncation: TruncationDetails;
    files: RgFileOnlyDetail[];
  };
}

// ---------- internal representations ----------

interface LineEvent {
  kind: LineKind;
  pathKey: string;
  displayPath: string;
  pathEncoding: TextEncoding;
  rawPathBase64?: string;
  line: number;
  text: string;
  textEncoding: TextEncoding;
  rawTextBase64?: string;
  rawTextBytes: Buffer;
  submatches: Submatch[];
  matchIndex: number;
}

interface DisplayItem {
  kind: "match" | "context" | "continuation";
  line: number;
  text: string;
  textEncoding: TextEncoding;
  rawTextBase64?: string;
  submatches: Submatch[];
  rawBytes: Buffer;
  column: number;
  extraCount?: number;
}

interface BuildOptions {
  offset: number;
  limit: number;
  cwd: string;
  beforeContext: number;
  afterContext: number;
  naturalEnd: boolean;
  lineExcerptLimit: number;
  contentBudget: number;
}

// Deferred nextOffset placeholder — replaced after the budget loop resolves
// the actual returned count. Uses NUL bytes that cannot survive escapeControls
// in normal text, so it never collides with user content.
const NEXT_OFFSET_SENTINEL = "\x00__RG_NEXT_OFFSET__\x00";

// ---------- field decoding ----------

interface DecodedField {
  text: string;
  encoding: TextEncoding;
  rawBase64?: string;
  rawBytes: Buffer;
}

function stripTerminalLineEnding(buf: Buffer): Buffer {
  const len = buf.length;
  if (len >= 2 && buf[len - 2] === 0x0d && buf[len - 1] === 0x0a) {
    return buf.subarray(0, len - 2);
  }
  if (len >= 1 && buf[len - 1] === 0x0a) {
    return buf.subarray(0, len - 1);
  }
  return buf;
}

// Decodes a rg JSON field. Real ripgrep 15.1.0 emits:
//   { "text": "..." }          for valid UTF-8
//   { "bytes": "BASE64" }      for content with invalid UTF-8
// When stripEol is true, one trailing LF or CRLF is removed from the raw
// bytes before text derivation, so source lines do not carry literal \n.
function decodeField(field: unknown, stripEol: boolean): DecodedField {
  if (field === null || typeof field !== "object") {
    return { text: "", encoding: "text", rawBytes: Buffer.alloc(0) };
  }
  const f = field as Record<string, unknown>;
  if (typeof f.text === "string") {
    let rawBytes: Buffer = Buffer.from(f.text, "utf-8");
    if (stripEol) rawBytes = stripTerminalLineEnding(rawBytes);
    return { text: rawBytes.toString("utf-8"), encoding: "text", rawBytes };
  }
  if (typeof f.bytes === "string") {
    const originalBuf = Buffer.from(f.bytes, "base64");
    if (stripEol) {
      const stripped = stripTerminalLineEnding(originalBuf);
      return {
        text: stripped.toString("utf-8"),
        encoding: "bytes",
        rawBase64: stripped.toString("base64"),
        rawBytes: stripped,
      };
    }
    return {
      text: originalBuf.toString("utf-8"),
      encoding: "bytes",
      rawBase64: f.bytes,
      rawBytes: originalBuf,
    };
  }
  return { text: "", encoding: "text", rawBytes: Buffer.alloc(0) };
}

// ---------- path identity / normalization ----------

// Identity key: text paths use their normalized form; byte paths use
// encoding+rawBase64 so that two different base64 sequences decoding to the
// same replacement string never collapse into one file group.
function computePathIdentity(
  text: string,
  encoding: TextEncoding,
  rawBase64: string | undefined,
  rawBytes: Buffer,
  cwd: string,
  platform: string,
): { pathKey: string; displayPath: string } {
  if (encoding === "bytes") {
    return {
      pathKey: `bytes:${rawBase64 ?? rawBytes.toString("base64")}`,
      displayPath: escapeBytesForDisplay(rawBytes),
    };
  }
  const normalized = normalizeCwdPath(text, cwd, platform);
  return { pathKey: `text:${normalized}`, displayPath: normalized };
}

// Valid paths inside cwd become cwd-relative. Outside paths stay absolute,
// relative paths lose their leading `./`, and display separators are `/`.
function normalizeCwdPath(input: string, cwd: string, platform: string): string {
  const paths = platform === "win32" ? win32 : posix;
  const normalized = paths.normalize(input);
  const slash = (value: string): string => value.replace(/\\/g, "/");

  if (!paths.isAbsolute(normalized)) return slash(normalized);

  const absoluteCwd = paths.resolve(cwd);
  const relative = paths.relative(absoluteCwd, normalized);
  if (relative === "") return ".";

  const outside =
    relative === ".." ||
    relative.startsWith(`..${paths.sep}`) ||
    paths.isAbsolute(relative);
  return slash(outside ? normalized : relative);
}

function escapeBytesForDisplay(buf: Buffer): string {
  let result = "";
  for (let i = 0; i < buf.length; i++) {
    const byte = buf[i];
    if (byte >= 0x20 && byte <= 0x7e) {
      result += String.fromCharCode(byte);
    } else {
      result += `\\x${byte.toString(16).padStart(2, "0")}`;
    }
  }
  return result;
}

// ---------- column / escaping helpers ----------

function byteOffsetToColumn(rawBytes: Buffer, startByte: number): number {
  const end = Math.min(startByte, rawBytes.length);
  const prefix = rawBytes.subarray(0, end).toString("utf-8");
  return [...prefix].length + 1;
}

function escapeControls(text: string): string {
  return text.replace(/[\x00-\x1F\x7F]/g, (ch) => {
    switch (ch.charCodeAt(0)) {
      case 0x08: return "\\b";
      case 0x09: return "\\t";
      case 0x0a: return "\\n";
      case 0x0c: return "\\f";
      case 0x0d: return "\\r";
      default: return `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;
    }
  });
}

// ---------- excerpt helpers ----------

function excerptMatch(
  text: string,
  submatches: Submatch[],
  rawBytes: Buffer,
  limit: number,
): { display: string; excerpted: boolean } {
  if (text.length <= limit) {
    return { display: escapeControls(text), excerpted: false };
  }

  let center = 0;
  if (submatches.length > 0 && submatches[0].startByte > 0) {
    center = rawBytes.subarray(0, Math.min(submatches[0].startByte, rawBytes.length))
      .toString("utf-8").length;
  }
  const half = Math.floor(limit / 2);
  let start = Math.max(0, center - half);
  let end = Math.min(text.length, start + limit);
  if (end - start < limit) start = Math.max(0, end - limit);

  const excerpt = text.substring(start, end);
  let display = "";
  if (start > 0) display += "\u2026";
  display += escapeControls(excerpt);
  if (end < text.length) display += "\u2026";
  display += ` (${text.length} units`;

  let hidden = 0;
  for (const s of submatches) {
    const pos = rawBytes.subarray(0, Math.min(s.startByte, rawBytes.length))
      .toString("utf-8").length;
    if (pos < start || pos >= end) hidden++;
  }
  if (hidden > 0) display += `, ${hidden} hidden`;
  display += ")";

  return { display, excerpted: true };
}

function excerptContext(text: string, limit: number): { display: string; excerpted: boolean } {
  if (text.length <= limit) {
    return { display: escapeControls(text), excerpted: false };
  }
  return {
    display: escapeControls(text.substring(0, limit)) + `\u2026 (${text.length} units)`,
    excerpted: true,
  };
}

function terminalEscape(codePoint: number, value: string): string {
  if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) {
    if (codePoint <= 0xff) return `\\x${codePoint.toString(16).padStart(2, "0")}`;
    return `\\u${codePoint.toString(16).padStart(4, "0")}`;
  }
  return value;
}

function escapeTerminalTextWithMap(value: string): { text: string; boundaries: number[] } {
  let text = "";
  const boundaries = new Array<number>(value.length + 1).fill(0);
  for (let i = 0; i < value.length;) {
    const codePoint = value.codePointAt(i)!;
    const units = codePoint > 0xffff ? 2 : 1;
    const escaped = terminalEscape(codePoint, value.slice(i, i + units));
    boundaries[i] = text.length;
    if (units === 2) boundaries[i + 1] = text.length;
    text += escaped;
    boundaries[i + units] = text.length;
    i += units;
  }
  return { text, boundaries };
}

function mergeDisplayRanges(ranges: DisplayRange[]): DisplayRange[] {
  const sorted = ranges
    .filter((range) => range.start >= 0 && range.end > range.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: DisplayRange[] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

const fatalUtf8 = new TextDecoder("utf-8", { fatal: true });

function byteOffsetToUtf16(rawBytes: Buffer, offset: number): number | null {
  if (!Number.isInteger(offset) || offset < 0 || offset > rawBytes.length) return null;
  try {
    return fatalUtf8.decode(rawBytes.subarray(0, offset)).length;
  } catch {
    return null;
  }
}

function buildTextLineDisplay(item: DisplayItem, limit: number): RgLineDisplay {
  const text = item.text;
  const excerpted = text.length > limit;
  let start = 0;
  let end = text.length;
  if (excerpted) {
    let center = 0;
    if (item.submatches.length > 0) {
      center = byteOffsetToUtf16(item.rawBytes, item.submatches[0].startByte) ?? 0;
    }
    const half = Math.floor(limit / 2);
    start = Math.max(0, center - half);
    end = Math.min(text.length, start + limit);
    if (end - start < limit) start = Math.max(0, end - limit);
  }

  const escaped = escapeTerminalTextWithMap(text.substring(start, end));
  const leading = start > 0 ? "\u2026" : "";
  const trailing = end < text.length ? "\u2026" : "";
  let suffix = "";
  if (excerpted) {
    let hidden = 0;
    for (const submatch of item.submatches) {
      const position = byteOffsetToUtf16(item.rawBytes, submatch.startByte);
      if (position === null || position < start || position >= end) hidden++;
    }
    suffix = ` (${text.length} units${hidden > 0 ? `, ${hidden} hidden` : ""})`;
  }

  const highlights: DisplayRange[] = [];
  if (item.kind === "match") {
    for (const submatch of item.submatches) {
      const matchStart = byteOffsetToUtf16(item.rawBytes, submatch.startByte);
      const matchEnd = byteOffsetToUtf16(item.rawBytes, submatch.endByte);
      if (matchStart === null || matchEnd === null || matchEnd < matchStart) continue;
      const visibleStart = Math.max(start, matchStart);
      const visibleEnd = Math.min(end, matchEnd);
      if (visibleEnd <= visibleStart) continue;
      highlights.push({
        start: leading.length + escaped.boundaries[visibleStart - start],
        end: leading.length + escaped.boundaries[visibleEnd - start],
      });
    }
  }

  return {
    text: leading + escaped.text + trailing + suffix,
    highlights: mergeDisplayRanges(highlights),
    excerpted,
  };
}

function buildByteLineDisplay(item: DisplayItem, limit: number): RgLineDisplay {
  const raw = item.rawBytes;
  const excerpted = raw.length > limit;
  let start = 0;
  let end = raw.length;
  if (excerpted) {
    const center = item.submatches[0]?.startByte ?? 0;
    const half = Math.floor(limit / 2);
    start = Math.max(0, Math.min(raw.length, center) - half);
    end = Math.min(raw.length, start + limit);
    if (end - start < limit) start = Math.max(0, end - limit);
  }

  let escaped = "";
  const boundaries = new Array<number>(end - start + 1).fill(0);
  for (let i = start; i < end; i++) {
    boundaries[i - start] = escaped.length;
    const byte = raw[i];
    escaped += byte >= 0x20 && byte <= 0x7e
      ? String.fromCharCode(byte)
      : `\\x${byte.toString(16).padStart(2, "0")}`;
    boundaries[i - start + 1] = escaped.length;
  }

  const leading = start > 0 ? "\u2026" : "";
  const trailing = end < raw.length ? "\u2026" : "";
  let hidden = 0;
  const highlights: DisplayRange[] = [];
  if (item.kind === "match") {
    for (const submatch of item.submatches) {
      if (
        !Number.isInteger(submatch.startByte)
        || !Number.isInteger(submatch.endByte)
        || submatch.startByte < 0
        || submatch.endByte < submatch.startByte
        || submatch.endByte > raw.length
      ) {
        continue;
      }
      if (submatch.startByte < start || submatch.startByte >= end) hidden++;
      const visibleStart = Math.max(start, submatch.startByte);
      const visibleEnd = Math.min(end, submatch.endByte);
      if (visibleEnd <= visibleStart) continue;
      highlights.push({
        start: leading.length + boundaries[visibleStart - start],
        end: leading.length + boundaries[visibleEnd - start],
      });
    }
  }
  const suffix = excerpted
    ? ` (${raw.length} bytes${hidden > 0 ? `, ${hidden} hidden` : ""})`
    : "";
  return {
    text: leading + escaped + trailing + suffix,
    highlights: mergeDisplayRanges(highlights),
    excerpted,
  };
}

function buildLineDisplay(item: DisplayItem, limit: number): RgLineDisplay {
  return item.textEncoding === "bytes"
    ? buildByteLineDisplay(item, limit)
    : buildTextLineDisplay(item, limit);
}

// ---------- event extraction ----------

function extractEvents(rawEvents: unknown[], cwd: string, platform: string): {
  lineEvents: LineEvent[];
  totalMatches: number;
} {
  const lineEvents: LineEvent[] = [];
  let matchIndex = 0;

  for (const raw of rawEvents) {
    const event = raw as Record<string, unknown>;
    if (event.type === "match") {
      const data = event.data as Record<string, unknown>;
      const pathField = decodeField(data.path, false);
      const textField = decodeField(data.lines, true);
      const { pathKey, displayPath } = computePathIdentity(
        pathField.text, pathField.encoding, pathField.rawBase64, pathField.rawBytes, cwd, platform,
      );
      const subsRaw = data.submatches as Record<string, unknown>[] | undefined;
      const submatches: Submatch[] = (subsRaw ?? []).map((s) => ({
        startByte: s.start as number,
        endByte: s.end as number,
      }));
      lineEvents.push({
        kind: "match",
        pathKey,
        displayPath,
        pathEncoding: pathField.encoding,
        rawPathBase64: pathField.rawBase64,
        line: data.line_number as number,
        text: textField.text,
        textEncoding: textField.encoding,
        rawTextBase64: textField.rawBase64,
        rawTextBytes: textField.rawBytes,
        submatches,
        matchIndex,
      });
      matchIndex++;
    } else if (event.type === "context") {
      const data = event.data as Record<string, unknown>;
      const pathField = decodeField(data.path, false);
      const textField = decodeField(data.lines, true);
      const { pathKey, displayPath } = computePathIdentity(
        pathField.text, pathField.encoding, pathField.rawBase64, pathField.rawBytes, cwd, platform,
      );
      lineEvents.push({
        kind: "context",
        pathKey,
        displayPath,
        pathEncoding: pathField.encoding,
        rawPathBase64: pathField.rawBase64,
        line: data.line_number as number,
        text: textField.text,
        textEncoding: textField.encoding,
        rawTextBase64: textField.rawBase64,
        rawTextBytes: textField.rawBytes,
        submatches: [],
        matchIndex: -1,
      });
    }
  }

  return { lineEvents, totalMatches: matchIndex };
}

// ---------- core result builder ----------

function buildResult(
  lineEvents: LineEvent[],
  totalMatches: number,
  opts: BuildOptions,
): RgResult {
  const matchEvents = lineEvents.filter((e) => e.kind === "match");
  const contextEvents = lineEvents.filter((e) => e.kind === "context");

  const pageEnd = Math.min(opts.offset + opts.limit, totalMatches);
  const includedMatches = matchEvents.filter((m) => m.matchIndex >= opts.offset && m.matchIndex < pageEnd);

  // Context window union per path — derived from included matches only.
  const contextWindows = new Map<string, Set<number>>();
  for (const m of includedMatches) {
    let windows = contextWindows.get(m.pathKey);
    if (!windows) {
      windows = new Set<number>();
      contextWindows.set(m.pathKey, windows);
    }
    for (let i = Math.max(1, m.line - opts.beforeContext); i <= m.line - 1; i++) {
      windows.add(i);
    }
    for (let i = m.line + 1; i <= m.line + opts.afterContext; i++) {
      windows.add(i);
    }
  }

  // Extra matches whose line falls inside a context window become continuation markers.
  const extraInWindow = new Map<string, Set<number>>();
  for (const m of matchEvents) {
    if (m.matchIndex < pageEnd) continue;
    const windows = contextWindows.get(m.pathKey);
    if (windows && windows.has(m.line)) {
      let lines = extraInWindow.get(m.pathKey);
      if (!lines) {
        lines = new Set<number>();
        extraInWindow.set(m.pathKey, lines);
      }
      lines.add(m.line);
    }
  }

  // Build per-path display items in first-seen order of included matches.
  const fileOrder: string[] = [];
  const fileMeta = new Map<string, {
    displayPath: string;
    pathEncoding: TextEncoding;
    rawPathBase64?: string;
    items: DisplayItem[];
  }>();

  for (const m of includedMatches) {
    if (!fileMeta.has(m.pathKey)) {
      fileMeta.set(m.pathKey, {
        displayPath: m.displayPath,
        pathEncoding: m.pathEncoding,
        rawPathBase64: m.rawPathBase64,
        items: [],
      });
      fileOrder.push(m.pathKey);
    }
  }

  for (const pathKey of fileOrder) {
    const meta = fileMeta.get(pathKey)!;
    const windows = contextWindows.get(pathKey)!;
    const extra = extraInWindow.get(pathKey);
    const items: DisplayItem[] = [];

    for (const m of includedMatches) {
      if (m.pathKey !== pathKey) continue;
      items.push({
        kind: "match",
        line: m.line,
        text: m.text,
        textEncoding: m.textEncoding,
        rawTextBase64: m.rawTextBase64,
        submatches: m.submatches,
        rawBytes: m.rawTextBytes,
        column: m.submatches.length > 0
          ? byteOffsetToColumn(m.rawTextBytes, m.submatches[0].startByte)
          : 1,
      });
    }

    for (const c of contextEvents) {
      if (c.pathKey !== pathKey) continue;
      if (!windows.has(c.line)) continue;
      if (extra && extra.has(c.line)) continue;
      const isMatch = includedMatches.some((m) => m.pathKey === pathKey && m.line === c.line);
      if (isMatch) continue;
      items.push({
        kind: "context",
        line: c.line,
        text: c.text,
        textEncoding: c.textEncoding,
        rawTextBase64: c.rawTextBase64,
        submatches: [],
        rawBytes: c.rawTextBytes,
        column: 0,
      });
    }

    if (extra && extra.size > 0) {
      items.push({
        kind: "continuation",
        line: Number.MAX_SAFE_INTEGER,
        text: "",
        textEncoding: "text",
        submatches: [],
        rawBytes: Buffer.alloc(0),
        column: 0,
        extraCount: extra.size,
      });
    }

    items.sort((a, b) => a.line - b.line);

    // Deduplicate by line number, retaining the first (higher-priority) item.
    const seen = new Set<number>();
    meta.items = items.filter((item) => {
      if (seen.has(item.line)) return false;
      seen.add(item.line);
      return true;
    });
  }

  // ----- budget enforcement -----

  const expectedReturned = includedMatches.length;
  const total = opts.naturalEnd ? totalMatches : undefined;

  // Reserve budget using the maximum-possible header so the real header
  // (always equal or shorter) never causes overflow.
  const estHasMore = totalMatches > opts.offset + expectedReturned;
  const estNext = estHasMore ? opts.offset + expectedReturned : null;
  let estHeader = `rg returned=${expectedReturned} offset=${opts.offset} hasMore=${estHasMore} nextOffset=${estNext === null ? "null" : estNext}`;
  if (total !== undefined) estHeader += ` total=${total}`;

  let remaining = opts.contentBudget - estHeader.length - 1;

  const textParts: string[] = [];
  const displayedPerFile = new Map<string, DisplayItem[]>();
  let lineExcerpts = 0;
  let contextLinesOmitted = 0;
  let actualReturned = 0;
  let contentBudgetReached = false;

  for (const pathKey of fileOrder) {
    const meta = fileMeta.get(pathKey)!;
    if (meta.items.length === 0 || remaining <= 0) {
      if (remaining <= 0) contentBudgetReached = true;
      if (remaining <= 0) break;
      continue;
    }

    const fileHeader = `file: ${escapeControls(meta.displayPath)}`;
    const fhCost = fileHeader.length + 1;

    if (remaining < fhCost) {
      contentBudgetReached = true;
      break;
    }

    const pendingItems: DisplayItem[] = [];
    const pendingLines: string[] = [];
    let pendingCost = fhCost;
    let matchCount = 0;
    let stopped = false;

    for (const item of meta.items) {
      let lineText: string;
      let isMatch = false;
      let isContext = false;

      if (item.kind === "match") {
        const ex = excerptMatch(item.text, item.submatches, item.rawBytes, opts.lineExcerptLimit);
        if (ex.excerpted) lineExcerpts++;
        lineText = `> ${item.line}:${item.column} | ${ex.display}`;
        isMatch = true;
      } else if (item.kind === "context") {
        const ex = excerptContext(item.text, opts.lineExcerptLimit);
        if (ex.excerpted) lineExcerpts++;
        lineText = `  ${item.line}- | ${ex.display}`;
        isContext = true;
      } else {
        lineText = `  ... | +${item.extraCount} omitted (nextOffset=${NEXT_OFFSET_SENTINEL})`;
      }

      const cost = lineText.length + 1;

      if (pendingCost + cost > remaining) {
        if (isMatch) {
          stopped = true;
          break;
        }
        if (isContext) contextLinesOmitted++;
        continue;
      }

      pendingItems.push(item);
      pendingLines.push(lineText);
      pendingCost += cost;
      if (isMatch) matchCount++;
    }

    if (matchCount === 0) {
      if (stopped) {
        contentBudgetReached = true;
        break;
      }
      continue;
    }

    textParts.push(fileHeader);
    remaining -= fhCost;
    for (let i = 0; i < pendingLines.length; i++) {
      textParts.push(pendingLines[i]);
      remaining -= pendingLines[i].length + 1;
    }
    displayedPerFile.set(pathKey, pendingItems);
    actualReturned += matchCount;

    if (stopped) {
      contentBudgetReached = true;
      break;
    }
  }

  // If no matches could be returned despite having matches to show, the
  // content budget is too small for even one file header plus match.
  if (actualReturned === 0 && expectedReturned > 0) {
    throw new Error(
      `rg result exceeds ${opts.contentBudget}-byte content budget: ` +
      `a single file header plus match cannot fit`,
    );
  }

  // ----- final header -----

  const actualHasMore = totalMatches > opts.offset + actualReturned;
  const actualNext = actualHasMore ? opts.offset + actualReturned : null;
  let header = `rg returned=${actualReturned} offset=${opts.offset} hasMore=${actualHasMore} nextOffset=${actualNext === null ? "null" : actualNext}`;
  if (total !== undefined) header += ` total=${total}`;

  let text: string;
  if (textParts.length === 0) {
    text = `${header}\nNo matches found`;
  } else {
    text = `${header}\n${textParts.join("\n")}`;
  }

  // Resolve deferred nextOffset in continuation markers.
  const nextOffsetStr = actualNext === null ? "null" : String(actualNext);
  text = text.split(NEXT_OFFSET_SENTINEL).join(nextOffsetStr);

  // ----- details -----

  const page: PageDetails = {
    offset: opts.offset,
    limit: opts.limit,
    returned: actualReturned,
    hasMore: actualHasMore,
    nextOffset: actualNext,
  };
  if (total !== undefined) {
    page.total = total;
  }

  const truncation: TruncationDetails = {
    lineExcerpts,
    contextLinesOmitted,
    contentBudgetReached,
  };

  const files: RgFileDetail[] = [];
  for (const pathKey of fileOrder) {
    const items = displayedPerFile.get(pathKey);
    if (!items) continue;
    const meta = fileMeta.get(pathKey)!;
    const lines: RgLineDetail[] = [];
    let continuation: RgFileDetail["continuation"];
    for (const item of items) {
      if (item.kind === "continuation") {
        continuation = {
          omitted: item.extraCount ?? 0,
          nextOffset: actualNext,
        };
        continue;
      }
      const detail: RgLineDetail = {
        kind: item.kind as LineKind,
        line: item.line,
        text: item.text,
        textEncoding: item.textEncoding,
        display: buildLineDisplay(item, opts.lineExcerptLimit),
      };
      if (item.rawTextBase64) detail.rawTextBase64 = item.rawTextBase64;
      if (item.kind === "match") {
        detail.column = item.column;
        detail.submatches = item.submatches;
      }
      lines.push(detail);
    }
    if (lines.length === 0) continue;
    const file: RgFileDetail = {
      path: meta.displayPath,
      pathEncoding: meta.pathEncoding,
      lines,
    };
    if (meta.rawPathBase64) file.rawPathBase64 = meta.rawPathBase64;
    if (continuation) file.continuation = continuation;
    files.push(file);
  }

  return {
    content: [{ type: "text" as const, text }],
    details: { page, truncation, files },
  };
}

// ---------- files-only result builder ----------

function buildFilesOnlyResult(
  lineEvents: LineEvent[],
  opts: BuildOptions,
): FilesOnlyResult {
  const matchEvents = lineEvents.filter((e) => e.kind === "match");

  // Aggregate per file in first-seen order.
  const fileOrder: string[] = [];
  const fileMeta = new Map<string, {
    displayPath: string;
    pathEncoding: TextEncoding;
    rawPathBase64?: string;
    matchCount: number;
  }>();

  for (const m of matchEvents) {
    let meta = fileMeta.get(m.pathKey);
    if (!meta) {
      meta = {
        displayPath: m.displayPath,
        pathEncoding: m.pathEncoding,
        rawPathBase64: m.rawPathBase64,
        matchCount: 0,
      };
      fileMeta.set(m.pathKey, meta);
      fileOrder.push(m.pathKey);
    }
    meta.matchCount++;
  }

  const totalFiles = fileOrder.length;
  const pageEnd = Math.min(opts.offset + opts.limit, totalFiles);
  const pageKeys = fileOrder.slice(opts.offset, pageEnd);

  // Reserve budget using the maximum-possible header.
  const estHasMore = totalFiles > opts.offset + pageKeys.length;
  const estNext = estHasMore ? opts.offset + pageKeys.length : null;
  let estHeader = `rg files returned=${pageKeys.length} offset=${opts.offset} hasMore=${estHasMore} nextOffset=${estNext === null ? "null" : estNext}`;
  if (opts.naturalEnd) estHeader += ` total=${totalFiles}`;

  let remaining = opts.contentBudget - estHeader.length - 1;

  const textParts: string[] = [];
  let actualReturned = 0;
  let contentBudgetReached = false;

  for (const pathKey of pageKeys) {
    const meta = fileMeta.get(pathKey)!;
    const lineText = `file: ${escapeControls(meta.displayPath)} (${meta.matchCount} match${meta.matchCount === 1 ? "" : "es"})`;
    const cost = lineText.length + 1;

    if (remaining < cost) {
      contentBudgetReached = true;
      break;
    }

    textParts.push(lineText);
    remaining -= cost;
    actualReturned++;
  }

  const actualHasMore = totalFiles > opts.offset + actualReturned;
  const actualNext = actualHasMore ? opts.offset + actualReturned : null;
  let header = `rg files returned=${actualReturned} offset=${opts.offset} hasMore=${actualHasMore} nextOffset=${actualNext === null ? "null" : actualNext}`;
  if (opts.naturalEnd) header += ` total=${totalFiles}`;

  let text: string;
  if (textParts.length === 0) {
    text = `${header}\nNo files found`;
  } else {
    text = `${header}\n${textParts.join("\n")}`;
  }

  const page: PageDetails = {
    offset: opts.offset,
    limit: opts.limit,
    returned: actualReturned,
    hasMore: actualHasMore,
    nextOffset: actualNext,
  };
  if (opts.naturalEnd) {
    page.total = totalFiles;
  }

  const truncation: TruncationDetails = {
    lineExcerpts: 0,
    contextLinesOmitted: 0,
    contentBudgetReached,
  };

  const files: RgFileOnlyDetail[] = [];
  for (let i = opts.offset; i < opts.offset + actualReturned && i < fileOrder.length; i++) {
    const meta = fileMeta.get(fileOrder[i]!)!;
    const file: RgFileOnlyDetail = {
      path: meta.displayPath,
      pathEncoding: meta.pathEncoding,
      matchCount: meta.matchCount,
    };
    if (meta.rawPathBase64) file.rawPathBase64 = meta.rawPathBase64;
    files.push(file);
  }

  return {
    content: [{ type: "text" as const, text }],
    details: { page, truncation, files },
  };
}

// ---------- RgAccumulator ----------

export class RgAccumulator {
  private readonly offset: number;
  private readonly limit: number;
  private readonly cwd: string;
  private readonly platform: string;
  private readonly beforeContext: number;
  private readonly afterContext: number;
  private readonly stdoutCap: number;
  private readonly lineExcerptLimit: number;
  private readonly contentBudget: number;

  private totalRawBytes = 0;
  private pendingBuffer: Buffer = Buffer.alloc(0);
  private readonly events: unknown[] = [];
  private malformedError: Error | null = null;
  private capExceeded = false;

  // shouldStop tracking
  private matchCount = 0;
  private lastIncludedLine: number | null = null;
  private lastIncludedPath: string | null = null;
  private maxLineAfterLast = 0;
  private lastFileEnded = false;
  private extraSeen = false;

  constructor(options: AccumulatorOptions = {}) {
    this.offset = options.offset ?? DEFAULT_OFFSET;
    this.limit = options.limit ?? DEFAULT_LIMIT;
    this.cwd = options.cwd ?? ".";
    this.platform = options.platform ?? process.platform;
    this.beforeContext = options.beforeContext ?? MIN_CONTEXT;
    this.afterContext = options.afterContext ?? MIN_CONTEXT;
    this.stdoutCap = options.stdoutCap ?? STDOUT_CAP;
    this.lineExcerptLimit = options.lineExcerptLimit ?? RG_LINE_EXCERPT_LIMIT;
    this.contentBudget = options.contentBudget ?? CONTENT_BUDGET;
  }

  push(chunk: Buffer | string): void {
    if (this.capExceeded) {
      throw new Error(`rg stdout exceeded ${this.stdoutCap}-byte cap`);
    }
    const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf-8") : chunk;
    this.totalRawBytes += buf.length;
    if (this.totalRawBytes > this.stdoutCap) {
      this.capExceeded = true;
      this.pendingBuffer = Buffer.alloc(0);
      this.events.length = 0;
      throw new Error(`rg stdout exceeded ${this.stdoutCap}-byte cap`);
    }

    this.pendingBuffer = Buffer.concat([this.pendingBuffer, buf]);

    let newlineIdx: number;
    while ((newlineIdx = this.pendingBuffer.indexOf(0x0a)) >= 0) {
      const lineBuf = this.pendingBuffer.subarray(0, newlineIdx);
      this.pendingBuffer = this.pendingBuffer.subarray(newlineIdx + 1);

      if (lineBuf.length === 0) continue;

      const lineStr = lineBuf.toString("utf-8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(lineStr);
      } catch (e) {
        this.malformedError = new Error(
          `malformed rg JSON line: ${e instanceof Error ? e.message : String(e)}`,
        );
        continue;
      }
      this.events.push(parsed);
      this.trackForStop(parsed);
    }
  }

  private trackForStop(event: unknown): void {
    const ev = event as Record<string, unknown>;
    if (ev.type !== "match" && ev.type !== "context") {
      if (ev.type === "end" || ev.type === "begin") {
        if (this.lastIncludedPath !== null) this.lastFileEnded = true;
      }
      return;
    }

    const data = ev.data as Record<string, unknown>;
    const pathField = decodeField(data.path, false);
    const { pathKey } = computePathIdentity(
      pathField.text, pathField.encoding, pathField.rawBase64, pathField.rawBytes, this.cwd, this.platform,
    );
    const path = pathKey;
    const line = data.line_number as number;

    if (ev.type === "match") {
      this.matchCount++;

      if (this.matchCount === this.offset + this.limit) {
        this.lastIncludedLine = line;
        this.lastIncludedPath = path;
        this.maxLineAfterLast = line;
      }

      if (this.matchCount > this.offset + this.limit) {
        this.extraSeen = true;
      }

      if (this.lastIncludedPath !== null && path !== this.lastIncludedPath) {
        this.lastFileEnded = true;
      }
      if (this.lastIncludedPath !== null && path === this.lastIncludedPath && line > this.maxLineAfterLast) {
        this.maxLineAfterLast = line;
      }
    } else {
      // context
      if (this.lastIncludedPath !== null && path !== this.lastIncludedPath) {
        this.lastFileEnded = true;
      }
      if (this.lastIncludedPath !== null && path === this.lastIncludedPath && line > this.maxLineAfterLast) {
        this.maxLineAfterLast = line;
      }
    }
  }

  shouldStop(): boolean {
    if (!this.extraSeen) return false;
    if (this.afterContext === 0) return true;
    if (this.lastFileEnded) return true;
    if (this.lastIncludedLine !== null && this.maxLineAfterLast >= this.lastIncludedLine + this.afterContext) {
      return true;
    }
    return false;
  }

  finish(opts: FinishOptions): RgResult {
    if (this.capExceeded) {
      throw new Error(`rg stdout exceeded ${this.stdoutCap}-byte cap`);
    }
    if (this.malformedError) throw this.malformedError;

    // A killed process may end mid-record. Complete trailing records are valid only
    // after natural EOF; intentional pagination stops discard the unterminated tail.
    if (this.pendingBuffer.length > 0) {
      const lineStr = this.pendingBuffer.toString("utf-8");
      this.pendingBuffer = Buffer.alloc(0);
      if (opts.naturalEnd && lineStr.length > 0) {
        try {
          this.events.push(JSON.parse(lineStr));
        } catch (e) {
          throw new Error(
            `malformed rg JSON line: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
    }

    const { lineEvents, totalMatches } = extractEvents(this.events, this.cwd, this.platform);

    return buildResult(lineEvents, totalMatches, {
      offset: this.offset,
      limit: this.limit,
      cwd: this.cwd,
      beforeContext: this.beforeContext,
      afterContext: this.afterContext,
      naturalEnd: opts.naturalEnd,
      lineExcerptLimit: this.lineExcerptLimit,
      contentBudget: this.contentBudget,
    });
  }

  finishFilesOnly(opts: FinishOptions): FilesOnlyResult {
    if (this.capExceeded) {
      throw new Error(`rg stdout exceeded ${this.stdoutCap}-byte cap`);
    }
    if (this.malformedError) throw this.malformedError;

    if (this.pendingBuffer.length > 0) {
      const lineStr = this.pendingBuffer.toString("utf-8");
      this.pendingBuffer = Buffer.alloc(0);
      if (opts.naturalEnd && lineStr.length > 0) {
        try {
          this.events.push(JSON.parse(lineStr));
        } catch (e) {
          throw new Error(
            `malformed rg JSON line: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
    }

    const { lineEvents } = extractEvents(this.events, this.cwd, this.platform);

    return buildFilesOnlyResult(lineEvents, {
      offset: this.offset,
      limit: this.limit,
      cwd: this.cwd,
      beforeContext: this.beforeContext,
      afterContext: this.afterContext,
      naturalEnd: opts.naturalEnd,
      lineExcerptLimit: this.lineExcerptLimit,
      contentBudget: this.contentBudget,
    });
  }
}

// ---------- formatRgResult ----------

export function formatRgResult(events: unknown[], opts: FormatOptions): RgResult {
  const cwd = opts.cwd ?? ".";
  const platform = opts.platform ?? process.platform;
  const { lineEvents, totalMatches } = extractEvents(events, cwd, platform);
  return buildResult(lineEvents, totalMatches, {
    offset: opts.offset,
    limit: opts.limit,
    cwd,
    beforeContext: opts.beforeContext,
    afterContext: opts.afterContext,
    naturalEnd: opts.naturalEnd,
    lineExcerptLimit: opts.lineExcerptLimit ?? RG_LINE_EXCERPT_LIMIT,
    contentBudget: opts.contentBudget ?? CONTENT_BUDGET,
  });
}

export function formatRgFilesOnly(events: unknown[], opts: FormatOptions): FilesOnlyResult {
  const cwd = opts.cwd ?? ".";
  const platform = opts.platform ?? process.platform;
  const { lineEvents } = extractEvents(events, cwd, platform);
  return buildFilesOnlyResult(lineEvents, {
    offset: opts.offset,
    limit: opts.limit,
    cwd,
    beforeContext: opts.beforeContext,
    afterContext: opts.afterContext,
    naturalEnd: opts.naturalEnd,
    lineExcerptLimit: opts.lineExcerptLimit ?? RG_LINE_EXCERPT_LIMIT,
    contentBudget: opts.contentBudget ?? CONTENT_BUDGET,
  });
}
