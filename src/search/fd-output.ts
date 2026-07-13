// Pure fd NUL-delimited path accumulator, deterministic raw-byte ordering,
// and budget-aware formatter.
//
// fd 10.3/10.4 has no sort option, so the complete scan is consumed here:
// raw NUL-delimited path buffers are accumulated up to a 32 MiB cap, each path
// is normalized for the injected platform semantics, records are sorted by raw
// normalized bytes (locale-independent, never process locale), invalid-byte
// paths stay distinct via preserved base64, and the page is rendered under the
// 12,000-unit content budget at path boundaries.

import type { FdDetails, FdPathDetail, TextContent, TextEncoding } from "./contracts";
import { CONTENT_BUDGET, STDOUT_CAP } from "./contracts";

// ---------- Public option / result shapes ----------

export interface FdAccumulatorOptions {
  offset: number;
  limit: number;
  cwd?: string;
  platform?: string;
  contentBudget?: number;
  stdoutCap?: number;
}

export interface FdFormatOptions {
  offset: number;
  limit: number;
  cwd?: string;
  platform?: string;
  contentBudget?: number;
}

export interface FdFinishOptions {
  naturalEnd: boolean;
  exitCode: number | null;
  stderr: string;
  stderrTruncated?: boolean;
}

export type FdOutputResult = {
  content: TextContent[];
  // `binary` is attached by the tool layer, not by this pure module.
  details: Omit<FdDetails, "binary">;
};

// ---------- Internal record ----------

interface FdRecord {
  normalizedRaw: Buffer;
  displayPath: string;
  encoding: TextEncoding;
  path?: string;
  rawBase64?: string;
}

// ---------- Low-level helpers ----------

const fatalUtf8 = new TextDecoder("utf-8", { fatal: true });
const DOT = 0x2e;
const SLASH = 0x2f;
const COLON = 0x3a;

/** Unsigned byte-wise comparison: locale-independent and deterministic. */
function compareBytes(a: Buffer, b: Buffer): number {
  const len = a.length < b.length ? a.length : b.length;
  for (let i = 0; i < len; i++) {
    const diff = a[i] - b[i];
    if (diff !== 0) return diff;
  }
  return a.length - b.length;
}

/** Normalize separators for injected platform semantics. POSIX is identity. */
function normalizeSeparators(raw: Buffer, isWindows: boolean): Buffer {
  if (!isWindows) return raw;
  let hasBackslash = false;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === 0x5c) {
      hasBackslash = true;
      break;
    }
  }
  if (!hasBackslash) return raw;
  const out = Buffer.allocUnsafe(raw.length);
  for (let i = 0; i < raw.length; i++) {
    out[i] = raw[i] === 0x5c ? 0x2f : raw[i];
  }
  return out;
}

// ---------- Cwd contract (byte-level) ----------

function isAsciiAlpha(b: number): boolean {
  return (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a);
}

/** Case-insensitive ASCII byte equality (A-Z maps to a-z; other bytes exact). */
function ciByteEqual(a: number, b: number): boolean {
  if (a === b) return true;
  if (a >= 0x41 && a <= 0x5a) a += 0x20;
  if (b >= 0x41 && b <= 0x5a) b += 0x20;
  return a === b;
}

/** Whether buf equals prefix at every byte (case-insensitive). */
function bufferCiEquals(buf: Buffer, prefix: Buffer): boolean {
  if (buf.length !== prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (!ciByteEqual(buf[i], prefix[i])) return false;
  }
  return true;
}

/** Whether buf starts with prefix (case-insensitive) immediately followed by sep. */
function bufferCiStartsWithSep(buf: Buffer, prefix: Buffer, sep: number): boolean {
  if (buf.length < prefix.length + 1) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (!ciByteEqual(buf[i], prefix[i])) return false;
  }
  return buf[prefix.length] === sep;
}

/** Normalize cwd string: win32 backslashes to /, strip trailing separator (preserving root and drive-root forms). */
function normalizeCwdString(cwd: string, isWindows: boolean): string {
  let s = isWindows ? cwd.replace(/\\/g, "/") : cwd;
  if (s.length > 1 && s.charCodeAt(s.length - 1) === SLASH) {
    const isDriveRoot =
      s.length === 3 && isAsciiAlpha(s.charCodeAt(0)) && s.charCodeAt(1) === COLON;
    if (!isDriveRoot) s = s.slice(0, -1);
  }
  return s;
}

/** POSIX cwd contract: strip leading ./, relativize inside absolute cwd, keep outside absolute. */
function applyCwdPosix(raw: Buffer, cwd: Buffer): Buffer {
  if (raw.length >= 2 && raw[0] === DOT && raw[1] === SLASH) {
    return raw.subarray(2);
  }
  if (raw.length === 0 || raw[0] !== SLASH) return raw;
  if (cwd.length === 0 || cwd[0] !== SLASH) return raw;
  if (raw.equals(cwd)) return Buffer.from([DOT]);
  if (cwd.length === 1) return raw.subarray(1); // root cwd: every other absolute path is inside
  if (
    raw.length > cwd.length + 1 &&
    raw[cwd.length] === SLASH &&
    raw.subarray(0, cwd.length).equals(cwd)
  ) {
    return raw.subarray(cwd.length + 1);
  }
  return raw;
}

/** Windows cwd contract: same-drive containment (case-insensitive); different drives and UNC stay absolute. */
function applyCwdWindows(raw: Buffer, cwd: Buffer): Buffer {
  if (raw.length >= 2 && raw[0] === DOT && raw[1] === SLASH) {
    return raw.subarray(2);
  }
  // Drive path X:/...
  if (raw.length >= 3 && isAsciiAlpha(raw[0]) && raw[1] === COLON && raw[2] === SLASH) {
    if (cwd.length >= 3 && isAsciiAlpha(cwd[0]) && cwd[1] === COLON && cwd[2] === SLASH) {
      if (!ciByteEqual(raw[0], cwd[0])) return raw; // different drive
      if (bufferCiEquals(raw, cwd)) return Buffer.from([DOT]);
      if (cwd.length === 3) return raw.subarray(3); // drive-root cwd
      if (bufferCiStartsWithSep(raw, cwd, SLASH)) return raw.subarray(cwd.length + 1);
    }
    return raw;
  }
  // UNC path //...
  if (raw.length >= 2 && raw[0] === SLASH && raw[1] === SLASH) {
    if (cwd.length >= 2 && cwd[0] === SLASH && cwd[1] === SLASH) {
      if (bufferCiEquals(raw, cwd)) return Buffer.from([DOT]);
      if (bufferCiStartsWithSep(raw, cwd, SLASH)) return raw.subarray(cwd.length + 1);
    }
    return raw;
  }
  return raw;
}

function applyCwd(raw: Buffer, cwd: Buffer, isWindows: boolean): Buffer {
  return isWindows ? applyCwdWindows(raw, cwd) : applyCwdPosix(raw, cwd);
}

/** JSON-style escape for control characters only; other code points intact. */
function escapeControls(text: string): string {
  let out = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x20) {
      if (cp === 0x09) out += "\\t";
      else if (cp === 0x0a) out += "\\n";
      else if (cp === 0x0d) out += "\\r";
      else if (cp === 0x08) out += "\\b";
      else if (cp === 0x0c) out += "\\f";
      else out += "\\u" + cp.toString(16).padStart(4, "0");
    } else {
      out += ch;
    }
  }
  return out;
}

/** Display form for byte paths: printable ASCII in line, all others as \xNN. */
function byteDisplay(buf: Buffer): string {
  let out = "";
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b === 0x09) out += "\\t";
    else if (b === 0x0a) out += "\\n";
    else if (b === 0x0d) out += "\\r";
    else if (b >= 0x20 && b < 0x7f) out += String.fromCharCode(b);
    else out += "\\x" + b.toString(16).padStart(2, "0");
  }
  return out;
}

/** Split a NUL-delimited buffer into raw path buffers across any chunk split. */
function splitNul(buf: Buffer): Buffer[] {
  const records: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0) {
      records.push(buf.subarray(start, i));
      start = i + 1;
    }
  }
  if (start < buf.length) {
    records.push(buf.subarray(start));
  }
  return records;
}

function buildRecord(normalizedRaw: Buffer): FdRecord {
  let decoded: string | null = null;
  try {
    decoded = fatalUtf8.decode(normalizedRaw);
  } catch {
    decoded = null;
  }
  if (decoded !== null) {
    return {
      normalizedRaw,
      displayPath: escapeControls(decoded),
      encoding: "text",
      path: decoded,
    };
  }
  return {
    normalizedRaw,
    displayPath: byteDisplay(normalizedRaw),
    encoding: "bytes",
    rawBase64: normalizedRaw.toString("base64"),
  };
}

function fdHeader(
  returned: number,
  offset: number,
  total: number,
  hasMore: boolean,
  nextOffset: number | null,
): string {
  return `fd returned=${returned} offset=${offset} total=${total} hasMore=${hasMore} nextOffset=${
    nextOffset === null ? "null" : nextOffset
  }`;
}

// ---------- Core processing ----------

interface CoreOptions {
  offset: number;
  limit: number;
  cwd: string;
  platform: string;
  contentBudget: number;
}

function processPaths(rawPaths: Buffer[], options: CoreOptions): FdOutputResult {
  const { offset, limit, contentBudget, cwd } = options;
  const total = rawPaths.length;
  const isWindows = options.platform === "win32";
  const cwdBytes = Buffer.from(normalizeCwdString(cwd, isWindows), "utf-8");

  const records: FdRecord[] = rawPaths.map((raw) =>
    buildRecord(applyCwd(normalizeSeparators(raw, isWindows), cwdBytes, isWindows)),
  );
  records.sort((a, b) => compareBytes(a.normalizedRaw, b.normalizedRaw));

  const available = total > offset ? total - offset : 0;
  const maxPossible = limit < available ? limit : available;

  // Greedily fit as many paths as the budget allows. Content length grows with
  // each path line, so the largest k whose rendered text fits is the page size.
  let bestK = 0;
  for (let k = 1; k <= maxPossible; k++) {
    const hasMore = offset + k < total;
    const nextOff = hasMore ? offset + k : null;
    let len = fdHeader(k, offset, total, hasMore, nextOff).length;
    for (let j = 0; j < k; j++) {
      len += 1 + records[offset + j].displayPath.length;
    }
    if (len <= contentBudget) bestK = k;
  }

  if (bestK === 0 && maxPossible >= 1) {
    throw new Error(
      `fd path at offset ${offset}: encoded length ${records[offset].displayPath.length} exceeds content budget ${contentBudget}`,
    );
  }

  const returned = bestK;
  const hasMore = offset + returned < total;
  const nextOff = hasMore ? offset + returned : null;

  let text = fdHeader(returned, offset, total, hasMore, nextOff);
  const pageRecords = records.slice(offset, offset + returned);
  for (const rec of pageRecords) {
    text += "\n" + rec.displayPath;
  }
  if (total === 0) {
    text += "\nNo paths found";
  }

  const contentBudgetReached = bestK < maxPossible;

  const paths: FdPathDetail[] = pageRecords.map((rec) => {
    const detail: FdPathDetail = {
      displayPath: rec.displayPath,
      encoding: rec.encoding,
    };
    if (rec.path !== undefined) detail.path = rec.path;
    if (rec.rawBase64 !== undefined) detail.rawBase64 = rec.rawBase64;
    return detail;
  });

  return {
    content: [{ type: "text", text }],
    details: {
      page: { offset, limit, returned, hasMore, nextOffset: nextOff, total },
      truncation: { lineExcerpts: 0, contextLinesOmitted: 0, contentBudgetReached },
      stderr: "",
      stderrTruncated: false,
      paths,
    },
  };
}

// ---------- Public API ----------

/**
 * Accumulates NUL-delimited raw fd output. `push` preserves NUL framing and raw
 * bytes; exceeding the byte cap fails the accumulator and discards results so
 * `finish` can never return partial output.
 */
export class FdAccumulator {
  private readonly chunks: Buffer[] = [];
  private totalBytes = 0;
  private failed = false;
  private readonly offset: number;
  private readonly limit: number;
  private readonly cwd: string;
  private readonly platform: string;
  private readonly contentBudget: number;
  private readonly stdoutCap: number;

  constructor(options: FdAccumulatorOptions) {
    this.offset = options.offset;
    this.limit = options.limit;
    this.cwd = options.cwd ?? ".";
    this.platform = options.platform ?? "posix";
    this.contentBudget = options.contentBudget ?? CONTENT_BUDGET;
    this.stdoutCap = options.stdoutCap ?? STDOUT_CAP;
  }

  push(chunk: Buffer): void {
    if (this.failed) {
      throw new Error("fd accumulator already failed: stdout cap exceeded");
    }
    this.chunks.push(chunk);
    this.totalBytes += chunk.length;
    if (this.totalBytes > this.stdoutCap) {
      this.failed = true;
      this.chunks.length = 0;
      throw new Error(
        `fd raw output exceeded stdout cap of ${this.stdoutCap} bytes`,
      );
    }
  }

  finish(opts: FdFinishOptions): FdOutputResult {
    if (this.failed) {
      throw new Error("fd accumulator failed: stdout cap exceeded");
    }
    if (!opts.naturalEnd) {
      throw new Error("fd output incomplete: process did not end naturally");
    }
    if (opts.exitCode !== 0) {
      throw new Error(`fd output incomplete: non-zero exit code ${opts.exitCode}`);
    }
    const buf = Buffer.concat(this.chunks);
    if (buf.length > 0 && buf[buf.length - 1] !== 0) {
      throw new Error("fd output incomplete: final record lacks NUL terminator");
    }
    const rawPaths = splitNul(buf);
    const result = processPaths(rawPaths, {
      offset: this.offset,
      limit: this.limit,
      cwd: this.cwd,
      platform: this.platform,
      contentBudget: this.contentBudget,
    });
    result.details.stderr = opts.stderr;
    result.details.stderrTruncated = opts.stderrTruncated ?? false;
    return result;
  }
}

/**
 * Formats already-split raw path buffers into text and typed details. Shares the
 * same normalization, sorting, and paging as the accumulator.
 */
export function formatFdResult(rawPaths: Buffer[], options: FdFormatOptions): FdOutputResult {
  return processPaths(rawPaths, {
    offset: options.offset,
    limit: options.limit,
    cwd: options.cwd ?? ".",
    platform: options.platform ?? "posix",
    contentBudget: options.contentBudget ?? CONTENT_BUDGET,
  });
}
