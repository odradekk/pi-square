import { StringDecoder } from "node:string_decoder";
import { stripVTControlCharacters } from "node:util";

import {
  CONTENT_BUDGET,
  type SgMatchDetail,
  type SgMetaVariableDetail,
  type SgRange,
} from "./contracts";

const MATCH_TEXT_LIMIT = 800;
const META_TEXT_LIMIT = 300;
const MAX_META_VARIABLES = 20;
const LANGUAGE_LIMIT = 80;

interface CapturedMatch {
  detail: SgMatchDetail;
  excerpts: number;
}

export interface SgAccumulatorOptions {
  offset: number;
  limit: number;
  contentBudget?: number;
}

export interface SgFinishOptions {
  naturalEnd: boolean;
  exitCode: number | null;
  stderr: string;
}

export interface SgOutputResult {
  content: Array<{ type: "text"; text: string }>;
  details: {
    page: {
      offset: number;
      limit: number;
      returned: number;
      hasMore: boolean;
      nextOffset: number | null;
      total?: number;
    };
    truncation: {
      lineExcerpts: number;
      contextLinesOmitted: number;
      contentBudgetReached: boolean;
    };
    matches: SgMatchDetail[];
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new Error(`malformed sg JSON: ${key} must be a string`);
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(`malformed sg JSON: ${label} must be a non-negative integer`);
  }
  return value as number;
}

function parseRange(value: unknown, label: string): SgRange {
  if (!isRecord(value) || !isRecord(value.byteOffset) || !isRecord(value.start) || !isRecord(value.end)) {
    throw new Error(`malformed sg JSON: ${label} must be a range`);
  }
  const byteStart = nonNegativeInteger(value.byteOffset.start, `${label}.byteOffset.start`);
  const byteEnd = nonNegativeInteger(value.byteOffset.end, `${label}.byteOffset.end`);
  const startLine = nonNegativeInteger(value.start.line, `${label}.start.line`);
  const startColumn = nonNegativeInteger(value.start.column, `${label}.start.column`);
  const endLine = nonNegativeInteger(value.end.line, `${label}.end.line`);
  const endColumn = nonNegativeInteger(value.end.column, `${label}.end.column`);
  if (byteEnd < byteStart || endLine < startLine || (endLine === startLine && endColumn < startColumn)) {
    throw new Error(`malformed sg JSON: ${label} has an inverted range`);
  }
  return {
    byteOffset: { start: byteStart, end: byteEnd },
    start: { line: startLine + 1, column: startColumn + 1 },
    end: { line: endLine + 1, column: endColumn + 1 },
  };
}

function truncate(value: string, limit: number): { text: string; excerpted: boolean } {
  const codePoints = Array.from(value);
  if (codePoints.length <= limit) return { text: value, excerpted: false };
  return { text: `${codePoints.slice(0, Math.max(0, limit - 3)).join("")}...`, excerpted: true };
}

function parseMetaVariable(name: string, value: unknown): SgMetaVariableDetail {
  if (!isRecord(value) || typeof value.text !== "string") {
    throw new Error(`malformed sg JSON: metaVariables.${name} must contain text`);
  }
  const text = truncate(value.text, META_TEXT_LIMIT).text;
  return {
    name,
    text,
    range: value.range === undefined ? undefined : parseRange(value.range, `metaVariables.${name}.range`),
  };
}

function parseMatch(value: unknown): CapturedMatch {
  if (!isRecord(value)) throw new Error("malformed sg JSON: match must be an object");
  const rawPath = requiredString(value, "file");
  const rawLanguage = requiredString(value, "language");
  const rawText = requiredString(value, "text");
  const rawLines = typeof value.lines === "string" ? value.lines : rawText;
  const language = truncate(rawLanguage, LANGUAGE_LIMIT);
  const text = truncate(rawText, MATCH_TEXT_LIMIT);
  const displayText = truncate(rawLines, MATCH_TEXT_LIMIT);
  let excerpts = Number(language.excerpted) + Number(text.excerpted) + Number(displayText.excerpted);

  const metaVariables: SgMetaVariableDetail[] = [];
  const rawMeta = value.metaVariables;
  if (rawMeta !== undefined) {
    if (!isRecord(rawMeta)) throw new Error("malformed sg JSON: metaVariables must be an object");
    const single = rawMeta.single;
    if (single !== undefined) {
      if (!isRecord(single)) throw new Error("malformed sg JSON: metaVariables.single must be an object");
      for (const [name, meta] of Object.entries(single)) {
        if (metaVariables.length >= MAX_META_VARIABLES) {
          excerpts += 1;
          break;
        }
        const parsed = parseMetaVariable(name, meta);
        if (parsed.text !== (meta as Record<string, unknown>).text) excerpts += 1;
        metaVariables.push(parsed);
      }
    }
    const multi = rawMeta.multi;
    if (multi !== undefined) {
      if (!isRecord(multi)) throw new Error("malformed sg JSON: metaVariables.multi must be an object");
      outer: for (const [name, metas] of Object.entries(multi)) {
        if (!Array.isArray(metas)) throw new Error(`malformed sg JSON: metaVariables.multi.${name} must be an array`);
        for (let index = 0; index < metas.length; index += 1) {
          if (metaVariables.length >= MAX_META_VARIABLES) {
            excerpts += 1;
            break outer;
          }
          const parsed = parseMetaVariable(`${name}[${index}]`, metas[index]);
          if (parsed.text !== (metas[index] as Record<string, unknown>).text) excerpts += 1;
          metaVariables.push(parsed);
        }
      }
    }
  }

  return {
    detail: {
      path: rawPath,
      language: language.text,
      text: text.text,
      displayText: displayText.text,
      range: parseRange(value.range, "range"),
      metaVariables,
    },
    excerpts,
  };
}

function escapeInline(value: string): string {
  const stripped = stripVTControlCharacters(value);
  let output = "";
  for (const char of stripped) {
    const codePoint = char.codePointAt(0)!;
    if (codePoint === 0x0a) output += "\\n";
    else if (codePoint === 0x0d) output += "\\r";
    else if (codePoint === 0x09) output += "\\t";
    else if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      output += `\\u${codePoint.toString(16).padStart(4, "0")}`;
    } else output += char;
  }
  return output;
}

function formatMatch(match: SgMatchDetail): string {
  const start = `${match.range.start.line}:${match.range.start.column}`;
  const end = `${match.range.end.line}:${match.range.end.column}`;
  const lines = [
    `${escapeInline(match.path)}:${start}-${end} [${escapeInline(match.language)}]`,
    `  ${escapeInline(match.displayText)}`,
  ];
  if (match.metaVariables.length > 0) {
    lines.push(`  metavariables: ${match.metaVariables.map((meta) => `$${escapeInline(meta.name)}=${escapeInline(meta.text)}`).join(" · ")}`);
  }
  return lines.join("\n");
}

function formatPage(
  offset: number,
  matches: CapturedMatch[],
  hasMore: boolean,
  total: number | undefined,
): string {
  const nextOffset = hasMore ? offset + matches.length : null;
  let header = `sg returned=${matches.length} offset=${offset} hasMore=${hasMore} nextOffset=${nextOffset === null ? "null" : nextOffset}`;
  if (total !== undefined) header += ` total=${total}`;
  if (matches.length === 0) return `${header}\nNo structural matches found`;
  return `${header}\n${matches.map((match) => formatMatch(match.detail)).join("\n")}`;
}

export class SgAccumulator {
  private readonly decoder = new StringDecoder("utf8");
  private readonly captured: CapturedMatch[] = [];
  private pending = "";
  private totalSeen = 0;
  private stopped = false;

  constructor(private readonly options: SgAccumulatorOptions) {}

  push(chunk: Buffer | string): void {
    if (this.stopped) return;
    this.pending += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    let newline = this.pending.indexOf("\n");
    while (newline >= 0) {
      const line = this.pending.slice(0, newline).replace(/\r$/, "");
      this.pending = this.pending.slice(newline + 1);
      if (line.trim().length > 0) this.consume(line);
      if (this.shouldStop()) {
        this.stopped = true;
        this.pending = "";
        return;
      }
      newline = this.pending.indexOf("\n");
    }
  }

  shouldStop(): boolean {
    return this.captured.length >= this.options.limit + 1;
  }

  private consume(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(`malformed sg JSON line: ${error instanceof Error ? error.message : String(error)}`);
    }
    const match = parseMatch(parsed);
    const index = this.totalSeen;
    this.totalSeen += 1;
    if (index >= this.options.offset && this.captured.length < this.options.limit + 1) {
      this.captured.push(match);
    }
  }

  finish(options: SgFinishOptions): SgOutputResult {
    if (!this.stopped) {
      this.pending += this.decoder.end();
      const finalLine = this.pending.replace(/\r$/, "");
      if (finalLine.trim().length > 0) this.consume(finalLine);
      this.pending = "";
    }
    if (!options.naturalEnd && !this.shouldStop()) {
      throw new Error("sg output incomplete: process did not end naturally");
    }
    if (options.naturalEnd && options.exitCode !== 0 && options.exitCode !== 1) {
      throw new Error(`sg output incomplete: non-zero exit code ${options.exitCode}`);
    }

    const contentBudget = this.options.contentBudget ?? CONTENT_BUDGET;
    const candidates = this.captured.slice(0, this.options.limit);
    const total = options.naturalEnd ? this.totalSeen : undefined;
    let returned = candidates.length;
    let content = "";
    while (returned >= 0) {
      const page = candidates.slice(0, returned);
      const hasMore = this.captured.length > returned || !options.naturalEnd;
      content = formatPage(this.options.offset, page, hasMore, total);
      if (Buffer.byteLength(content, "utf8") <= contentBudget) break;
      returned -= 1;
    }
    if (returned < 0 || (candidates.length > 0 && returned === 0)) {
      throw new Error(`sg result exceeds ${contentBudget}-byte content budget: a single match cannot fit`);
    }

    const matches = candidates.slice(0, returned);
    const hasMore = this.captured.length > returned || !options.naturalEnd;
    const nextOffset = hasMore ? this.options.offset + returned : null;
    const contentBudgetReached = returned < candidates.length;
    return {
      content: [{ type: "text", text: content }],
      details: {
        page: {
          offset: this.options.offset,
          limit: this.options.limit,
          returned,
          hasMore,
          nextOffset,
          ...(total === undefined ? {} : { total }),
        },
        truncation: {
          lineExcerpts: matches.reduce((sum, match) => sum + match.excerpts, 0),
          contextLinesOmitted: 0,
          contentBudgetReached,
        },
        matches: matches.map((match) => match.detail),
      },
    };
  }
}
