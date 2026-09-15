/**
 * Shared strict YAML-subset reader for definition files (odradekk/pi-square#370).
 *
 * Two feature areas read definition text through this one module: Shadow
 * Minds definitions (`../shadow-minds/parser.ts`) and subagent definitions
 * (`../subagents/definitions.ts`). Both deliberately support only a tiny
 * YAML subset — plain, single- and double-quoted scalars, nested maps, one
 * line flow lists, block lists, and (for subagent definitions) plain `|` and
 * `>` block scalars — and reject everything else. The structural rules of
 * that subset are implemented exactly once here: line scanning, indentation,
 * map nesting, list shapes, flow-list splitting, and block-scalar body
 * extraction (including the "only lines indented past the field carry block
 * content" rule). No runtime dependency is added and no general YAML is
 * supported.
 *
 * The two definition formats differ on policy, not structure: which scalar
 * spellings are rejected, how scalars are typed, and which constructs each
 * format accepts. The reader therefore owns structure only and leaves
 * policy to the callers: `parseYamlSubset` turns text into an ordered entry
 * tree plus findings — structural observations (an unexpected indent, a tab,
 * a blank line inside a block list, an unterminated quote in a flow list)
 * that each caller either escalates into one of its named errors or
 * deliberately ignores. Values keep their raw spelling: a scalar token
 * carries the text exactly as written, so callers apply their own scalar
 * policy (typing, escape handling, comment and null-spelling rules) without
 * the reader erasing the distinction between quoted and plain text.
 *
 * Neither caller layers, merges, or validates definition semantics here;
 * the owning modules keep those rules.
 */

// ── Scalar tokens ─────────────────────────────────────────────────────

/**
 * One scalar exactly as written. `raw` keeps the source spelling (quotes
 * included for quoted scalars) so callers can apply quote-sensitive policy;
 * `line` is the 1-based source line.
 */
export interface YamlScalar {
  raw: string;
  line: number;
}

// ── Values ────────────────────────────────────────────────────────────

/** A parsed value of the shared subset. */
export type YamlSubsetValue =
  /** A plain or quoted scalar; the raw spelling is kept for caller policy. */
  | { kind: "scalar"; scalar: YamlScalar }
  /** A bare `key:` line whose block never started (callers read this as null). */
  | { kind: "empty" }
  /**
   * A one-line `[a, b]` flow list. `closed` is false when the line opens `[`
   * without closing it; callers treat an unclosed opener as a plain scalar
   * (subagent subset) or reject it (Shadow subset). A quote left open across
   * the list text is reported as an "unbalanced-quote" finding.
   */
  | { kind: "flow-list"; raw: string; closed: boolean; items: YamlScalar[] }
  /** A `- item` block list; items keep their raw spelling. */
  | { kind: "block-list"; items: YamlScalar[] }
  /**
   * A `|` or `>` block scalar. `indicator` is the full spelling (`|`, `>`,
   * or an unsupported chomping/indentation form such as `|-`), `content` the
   * extracted body: only lines indented past the field line are content, the
   * first such line sets the body indent, blank interior lines survive, `>`
   * folds to one squashed line, and both forms clip to the body's edge trim.
   */
  | { kind: "block"; indicator: string; content: string }
  /** A nested map block; entries keep document order. */
  | { kind: "map"; entries: YamlSubsetEntry[] };

/** One `key: value` entry of a map block. */
export interface YamlSubsetEntry {
  key: string;
  /** 1-based line of the key, offset by the caller's `lineBase`. */
  line: number;
  value: YamlSubsetValue;
}

// ── Findings ──────────────────────────────────────────────────────────

/**
 * Codes for structural observations the reader does not rule on. Each
 * definition format maps the codes it cares about to its own named errors
 * and ignores the rest; the mapping lives with the caller so the messages
 * stay owned by the feature.
 */
export type YamlSubsetFindingCode =
  /** A content line contains a tab. */
  | "tab"
  /** A `<<:` merge key line. */
  | "merge-key"
  /** The document's first content line is indented. */
  | "first-line-indent"
  /** A line is indented where the current map's indent was already set. */
  | "unexpected-indent"
  /** A nested block does not indent exactly two spaces past its parent. */
  | "indent-step"
  /** Map nesting exceeds the supported depth (16). */
  | "nesting-depth"
  /** A line that is not a `key: value` pair and not a list item. */
  | "unsupported-line"
  /** A line whose key fails the caller's key pattern. */
  | "key-shape"
  /** A `- ` line at column zero, where no list is open. */
  | "list-item-indent"
  /** A block-list irregularity: an item not at the list's own indent. */
  | "list-item-shape"
  /** A blank line inside a block list, before the first item or between items. */
  | "blank-line-in-list"
  /** A flow list leaves a quote open across its text. */
  | "unbalanced-quote";

/** A structural observation at one line; `detail` carries line text or a key. */
export interface YamlSubsetFinding {
  line: number;
  code: YamlSubsetFindingCode;
  detail?: string;
}

/** The parsed document: ordered top-level entries plus findings. */
export interface YamlSubsetDocument {
  entries: YamlSubsetEntry[];
  findings: YamlSubsetFinding[];
}

// ── Structural reader ─────────────────────────────────────────────────

interface RawLine {
  indent: number;
  text: string;
  number: number;
}

export interface YamlSubsetOptions {
  /** The accepted key shape; keys failing it produce a "key-shape" finding. */
  keyPattern: RegExp;
  /** 1-based number of `text`'s first line; defaults to 1. */
  lineBase?: number;
}

const MAX_MAP_DEPTH = 16;

function toRawLines(text: string, lineBase: number): RawLine[] {
  return text.replace(/\r\n/g, "\n").split("\n").map((raw, index) => {
    const indent = /^ */.exec(raw)![0]!.length;
    return { indent, text: raw.slice(indent), number: index + lineBase };
  });
}

function isBlank(line: RawLine): boolean {
  // Whitespace-only lines carry no content; a tab-only line is still named
  // by the scan-phase tab finding above, so no observation is lost.
  return line.text.trim() === "";
}

function isComment(line: RawLine): boolean {
  return line.text.startsWith("#");
}

/** Index of the next content line after `from`, skipping blanks and whole-line comments. */
function nextContentIndex(lines: RawLine[], from: number): number {
  let index = from;
  while (index < lines.length && (isBlank(lines[index]!) || isComment(lines[index]!))) index += 1;
  return index;
}

/** Index of the first blank line in `[from, to)`, or -1. */
function firstBlankBetween(lines: RawLine[], from: number, to: number): number {
  for (let index = from; index < to; index += 1) {
    if (isBlank(lines[index]!)) return index;
  }
  return -1;
}

/** Index after the block of lines at indent deeper than `indent` starting at `from`. */
function skipBlock(lines: RawLine[], from: number, indent: number): number {
  let index = from;
  while (index < lines.length && (isBlank(lines[index]!) || isComment(lines[index]!) || lines[index]!.indent > indent)) index += 1;
  return index;
}

function scalarAt(raw: string, line: number): YamlScalar {
  return { raw, line };
}

/**
 * Quote-aware comma split of one flow-list body. Items keep their raw
 * spelling and are trimmed; empty items stay in the result (callers decide
 * whether they are an error or dropped), and a quote still open at the end
 * is reported instead of being silently closed.
 */
function splitFlowItems(inner: string): { items: string[]; unbalanced: boolean } {
  const items: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  for (const character of inner) {
    if (quote) {
      current += character;
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      current += character;
      continue;
    }
    if (character === ",") {
      items.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }
  return { items: [...items, current.trim()], unbalanced: quote !== undefined };
}

interface ReaderContext {
  lines: RawLine[];
  keyPattern: RegExp;
  findings: YamlSubsetFinding[];
}

function isListMarker(text: string): boolean {
  // The subset admits exactly `-` and `- `; a `-item` line without the space
  // is not an item and stays an ordinary (rejected) line.
  return text === "-" || text.startsWith("- ");
}

function parseBlockList(ctx: ReaderContext, start: number, listIndent: number, parentIndent: number, key: string): { items: YamlScalar[]; next: number } {
  const items: YamlScalar[] = [];
  let index = start;
  while (index < ctx.lines.length) {
    const line = ctx.lines[index]!;
    if (isBlank(line)) {
      // A blank run followed by more items is named by the subagent subset;
      // whole-line comments inside the run are author documentation, not
      // list content. Anything else ends the list at the blank.
      let afterBlanks = index;
      while (afterBlanks < ctx.lines.length && (isBlank(ctx.lines[afterBlanks]!) || isComment(ctx.lines[afterBlanks]!))) afterBlanks += 1;
      const next = ctx.lines[afterBlanks];
      if (next && isListMarker(next.text)) {
        ctx.findings.push({ line: line.number, code: "blank-line-in-list", detail: key });
        index = afterBlanks;
        continue;
      }
      break;
    }
    // Whole-line comments are author documentation and never list content.
    if (isComment(line)) {
      index += 1;
      continue;
    }
    if (isListMarker(line.text) && line.indent > parentIndent) {
      if (line.indent !== listIndent) {
        ctx.findings.push({ line: line.number, code: "list-item-shape", detail: line.text });
      }
      items.push({ raw: line.text === "-" ? "" : line.text.slice(2).trim(), line: line.number });
      index += 1;
      continue;
    }
    break;
  }
  return { items, next: index };
}

function parseBlockScalar(lines: RawLine[], fieldIndex: number, fieldIndent: number): { contentLines: string[]; next: number } {
  // Only lines indented past the field carry block content: the first
  // non-blank line sets the body indent, and without a deeper line nothing
  // is consumed, so a following field at the field's own indent still parses.
  let probe = fieldIndex + 1;
  while (probe < lines.length && isBlank(lines[probe]!)) probe += 1;
  let blockIndent = -1;
  if (probe < lines.length && lines[probe]!.indent > fieldIndent) blockIndent = lines[probe]!.indent;
  const contentLines: string[] = [];
  let index = fieldIndex + 1;
  if (blockIndent > 0) {
    while (index < lines.length) {
      const line = lines[index]!;
      if (isBlank(line)) {
        contentLines.push("");
        index += 1;
        continue;
      }
      if (line.indent < blockIndent) break;
      // RawLine.text already lost its leading spaces; lines deeper than the
      // body indent keep the indentation beyond it, as raw.slice would.
      contentLines.push(" ".repeat(line.indent - blockIndent) + line.text);
      index += 1;
    }
  }
  return { contentLines, next: index };
}

function parseEntries(ctx: ReaderContext, start: number, indent: number, depth: number): { entries: YamlSubsetEntry[]; next: number } {
  const entries: YamlSubsetEntry[] = [];
  let index = start;
  while (index < ctx.lines.length) {
    const line = ctx.lines[index]!;
    if (isBlank(line) || isComment(line)) {
      index += 1;
      continue;
    }
    if (line.indent < indent) break;
    if (line.indent > indent) {
      ctx.findings.push({ line: line.number, code: "unexpected-indent", detail: line.text });
      index += 1;
      continue;
    }
    if (isListMarker(line.text)) {
      ctx.findings.push({
        line: line.number,
        code: line.indent === 0 ? "list-item-indent" : "unexpected-indent",
        detail: line.text,
      });
      index += 1;
      continue;
    }
    if (line.text.startsWith("<<:")) {
      ctx.findings.push({ line: line.number, code: "merge-key", detail: line.text });
      index += 1;
      continue;
    }
    const match = /^([^:\s]+):(.*)$/.exec(line.text);
    if (!match) {
      ctx.findings.push({ line: line.number, code: "unsupported-line", detail: line.text });
      index += 1;
      continue;
    }
    const key = match[1]!;
    if (!ctx.keyPattern.test(key)) {
      ctx.findings.push({ line: line.number, code: "key-shape", detail: line.text });
      index += 1;
      continue;
    }
    const rest = match[2]!.trim();
    let value: YamlSubsetValue;
    if (rest === "") {
      const child = nextContentIndex(ctx.lines, index + 1);
      const childLine = child < ctx.lines.length ? ctx.lines[child]! : undefined;
      if (!childLine || childLine.indent <= indent) {
        value = { kind: "empty" };
        index += 1;
      } else {
        const firstBlank = firstBlankBetween(ctx.lines, index + 1, child);
        if (firstBlank >= 0 && isListMarker(childLine.text) && childLine.text.replace(/^-\s*/, "") !== "") {
          ctx.findings.push({ line: ctx.lines[firstBlank]!.number, code: "blank-line-in-list", detail: key });
        }
        if (childLine.indent !== indent + 2) {
          ctx.findings.push({ line: childLine.number, code: "indent-step" });
        }
        if (isListMarker(childLine.text)) {
          const list = parseBlockList(ctx, child, childLine.indent, indent, key);
          value = { kind: "block-list", items: list.items };
          index = list.next;
        } else if (depth + 1 > MAX_MAP_DEPTH) {
          ctx.findings.push({ line: childLine.number, code: "nesting-depth" });
          value = { kind: "map", entries: [] };
          index = skipBlock(ctx.lines, child, indent);
        } else {
          const nested = parseEntries(ctx, child, childLine.indent, depth + 1);
          // A block that produced no entries carried only rejected lines, so
          // the field reads as absent rather than as an empty map.
          value = nested.entries.length === 0 ? { kind: "empty" } : { kind: "map", entries: nested.entries };
          index = nested.next;
        }
      }
    } else if (rest.startsWith("[")) {
      if (rest.endsWith("]")) {
        const inner = rest.slice(1, -1).trim();
        if (inner === "") {
          value = { kind: "flow-list", raw: rest, closed: true, items: [] };
        } else {
          const split = splitFlowItems(inner);
          if (split.unbalanced) {
            ctx.findings.push({ line: line.number, code: "unbalanced-quote", detail: rest });
          }
          value = {
            kind: "flow-list",
            raw: rest,
            closed: true,
            items: split.items.map((item) => scalarAt(item, line.number)),
          };
        }
      } else {
        value = { kind: "flow-list", raw: rest, closed: false, items: [] };
      }
      index += 1;
    } else if (/^[|>][-+0-9]*$/.test(rest)) {
      const block = parseBlockScalar(ctx.lines, index, indent);
      const content = rest.startsWith(">")
        ? block.contentLines.join(" ").replace(/\s+/g, " ").trim()
        : block.contentLines.join("\n").trim();
      value = { kind: "block", indicator: rest, content };
      index = block.next;
    } else {
      value = { kind: "scalar", scalar: scalarAt(rest, line.number) };
      index += 1;
    }
    entries.push({ key, line: line.number, value });
  }
  return { entries, next: index };
}

/**
 * Reads `text` as the shared strict YAML subset. Never fails: structural
 * irregularities are reported as findings and raw content stays in the
 * entries, so each definition format decides what rejects.
 */
export function parseYamlSubset(text: string, options: YamlSubsetOptions): YamlSubsetDocument {
  const lines = toRawLines(text, options.lineBase ?? 1);
  const ctx: ReaderContext = { lines, keyPattern: options.keyPattern, findings: [] };
  // Tabs are named on every line that carries one, before any structural
  // observation, matching the strict subsets' scan-first rejection.
  for (const line of lines) {
    if (line.text.includes("\t")) ctx.findings.push({ line: line.number, code: "tab" });
  }
  const start = nextContentIndex(lines, 0);
  if (start >= lines.length) return { entries: [], findings: ctx.findings };
  let entries: YamlSubsetEntry[] = [];
  if (lines[start]!.indent > 0) {
    ctx.findings.push({ line: lines[start]!.number, code: "first-line-indent", detail: lines[start]!.text });
    entries = parseEntries(ctx, start + 1, 0, 0).entries;
  } else {
    entries = parseEntries(ctx, start, 0, 0).entries;
  }
  return { entries, findings: ctx.findings };
}
