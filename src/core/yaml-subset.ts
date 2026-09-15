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
 * format accepts. The reader therefore separates structure from policy:
 *
 * - `parseYamlSubset` turns text into an ordered entry tree plus findings —
 *   structural observations (an unexpected indent, a tab, a blank line inside
 *   a block list, an unterminated quote in a flow list) that each caller
 *   either escalates into one of its named errors or deliberately ignores.
 *   Values keep their raw spelling: a scalar token carries the text exactly
 *   as written and its quote style, so callers apply their own scalar policy
 *   (typing, escape handling, comment and null-spelling rules) without the
 *   reader erasing the distinction between quoted and plain text.
 * - `readYamlFields` is the field-reading profile subagent definitions use:
 *   it applies the caller-supplied field kinds (string, string list,
 *   boolean), reports unknown and duplicate fields and kind mismatches in
 *   the subagent subset's wording, and converts values with the subagent
 *   scalar policy (inline-comment and null-spelling rejection, quote
 *   stripping, `\n` escapes). Shadow Minds applies its own scalar policy in
 *   its parser and does not use this profile.
 *
 * Neither function layers, merges, or validates definition semantics; the
 * owning modules keep those rules.
 */

// ── Scalar tokens ─────────────────────────────────────────────────────

/** How one scalar was quoted in the source text. */
export type YamlScalarQuote = "none" | "single" | "double";

/**
 * One scalar exactly as written. `raw` keeps the source spelling (quotes
 * included for quoted scalars) so callers can apply quote-sensitive policy;
 * `quote` records the detected style, `line` the 1-based source line.
 */
export interface YamlScalar {
  raw: string;
  quote: YamlScalarQuote;
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
   * (subagent subset) or reject it (Shadow subset). `unbalanced` reports a
   * quote left open across the list text.
   */
  | { kind: "flow-list"; raw: string; closed: boolean; items: YamlScalar[]; unbalanced: boolean }
  /** A `- item` block list; items keep their raw spelling. */
  | { kind: "block-list"; items: YamlScalar[] }
  /**
   * A `|` or `>` block scalar. `indicator` is the full spelling (`|`, `>`,
   * or an unsupported chomping/indentation form such as `|-`), `content` the
   * extracted body: only lines indented past the field line are content, the
   * first such line sets the body indent, blank interior lines survive, and
   * `>` folds to one squashed line. Both forms clip to the body's edge trim.
   */
  | { kind: "block"; indicator: string; folded: boolean; content: string }
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
  return line.text === "";
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

function tokenizeScalar(raw: string, line: number): YamlScalar {
  const quoted =
    raw.length >= 2 &&
    (raw[0] === '"' || raw[0] === "'") &&
    raw[0] === raw[raw.length - 1];
  return { raw, quote: quoted ? (raw[0] === '"' ? "double" : "single") : "none", line };
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
  // The subagent subset accepts any `-`-led line as an item (`-item` too);
  // the Shadow subset names items that are not exactly `- ` through the
  // "list-item-shape" finding instead.
  return text.startsWith("-");
}

function parseBlockList(ctx: ReaderContext, start: number, listIndent: number, parentIndent: number, key: string): { items: YamlScalar[]; next: number } {
  const items: YamlScalar[] = [];
  let index = start;
  while (index < ctx.lines.length) {
    const line = ctx.lines[index]!;
    if (isBlank(line)) {
      // A blank run followed by more items is named by the subagent subset;
      // otherwise the list simply ends at the blank.
      let afterBlanks = index;
      while (afterBlanks < ctx.lines.length && isBlank(ctx.lines[afterBlanks]!)) afterBlanks += 1;
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
      if (line.indent !== listIndent || (line.text !== "-" && !line.text.startsWith("- "))) {
        ctx.findings.push({ line: line.number, code: "list-item-shape", detail: line.text });
      }
      items.push(tokenizeScalar(line.text.replace(/^-\s*/, ""), line.number));
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
          value = { kind: "map", entries: nested.entries };
          index = nested.next;
        }
      }
    } else if (rest.startsWith("[")) {
      if (rest.endsWith("]")) {
        const inner = rest.slice(1, -1).trim();
        if (inner === "") {
          value = { kind: "flow-list", raw: rest, closed: true, items: [], unbalanced: false };
        } else {
          const split = splitFlowItems(inner);
          if (split.unbalanced) {
            ctx.findings.push({ line: line.number, code: "unbalanced-quote", detail: rest });
          }
          value = {
            kind: "flow-list",
            raw: rest,
            closed: true,
            items: split.items.map((item) => tokenizeScalar(item, line.number)),
            unbalanced: split.unbalanced,
          };
        }
      } else {
        value = { kind: "flow-list", raw: rest, closed: false, items: [], unbalanced: false };
      }
      index += 1;
    } else if (/^[|>][-+0-9]*$/.test(rest)) {
      const block = parseBlockScalar(ctx.lines, index, indent);
      const content = rest.startsWith(">")
        ? block.contentLines.join(" ").replace(/\s+/g, " ").trim()
        : block.contentLines.join("\n").trim();
      value = { kind: "block", indicator: rest, folded: rest.startsWith(">"), content };
      index = block.next;
    } else {
      value = { kind: "scalar", scalar: tokenizeScalar(rest, line.number) };
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

// ── Subagent definition field profile ────────────────────────────────

/** The value shape a definition field accepts in the subagent subset. */
export type YamlFieldKind = "string" | "list" | "boolean";

/** A field read through `readYamlFields`; `value` is null for a clear marker. */
export interface YamlField {
  key: string;
  line: number;
  value: string | string[] | null;
}

export interface YamlFieldOptions {
  /** Label prepended to every error message. */
  source: string;
  /** Every accepted field and the shape its value must have. */
  fields: Readonly<Record<string, YamlFieldKind>>;
  /** The accepted key shape; see `parseYamlSubset`. */
  keyPattern: RegExp;
  /** 1-based number of `text`'s first line; defaults to 1. */
  lineBase?: number;
}

export interface YamlFieldsResult {
  fields: YamlField[];
  errors: string[];
  /** The structural findings; the caller maps the ones it names to errors. */
  findings: YamlSubsetFinding[];
}

/** One shared message for every inline-comment rejection in the subagent subset. */
const INLINE_COMMENT_MESSAGE = "inline comments are not supported — quote the value to keep a literal '#' or move the comment to its own line";

/**
 * Index where an inline comment starts inside one YAML-subset value, or -1.
 * A `#` starts a comment when it begins the value or follows a space or tab,
 * matching standard YAML; quoted strings never contain a comment.
 */
function findInlineComment(value: string): number {
  let quote: string | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const ch = value[index] ?? "";
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === `"` || ch === `'`) {
      quote = ch;
      continue;
    }
    if (ch === "#" && (index === 0 || value[index - 1] === " " || value[index - 1] === "\t")) return index;
  }
  return -1;
}

function isQuotedScalar(value: string): boolean {
  const trimmed = value.trim();
  return (trimmed.startsWith(`"`) && trimmed.endsWith(`"`)) || (trimmed.startsWith(`'`) && trimmed.endsWith(`'`));
}

/**
 * Rejects misspelled null spellings — every casing of `null` other than the
 * exact lowercase word and tilde lookalikes such as `～` — instead of
 * silently storing them as literal strings. `null` and `~` are
 * case-sensitive in this subset; quoted strings are literal by design and
 * stay untouched.
 */
function nullSpellingProblem(value: string): string | undefined {
  const trimmed = value.trim();
  if (isQuotedScalar(trimmed)) return undefined;
  if (trimmed !== "null" && trimmed.toLowerCase() === "null") {
    return "null spellings are case-sensitive; write lowercase null or ~";
  }
  if (trimmed === "〜" || trimmed === "～") {
    return "tilde null must be the ASCII ~ character";
  }
  return undefined;
}

/** Strips one pair of matching quotes when they wrap the whole value. */
function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (isQuotedScalar(trimmed)) return trimmed.slice(1, -1);
  return trimmed;
}

/**
 * The subagent subset's scalar conversion: exact lowercase `null` and ASCII
 * `~` clear, other spellings stay literal, quotes are stripped, and `\n`
 * escapes resolve.
 */
function convertScalarText(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "null" || trimmed === "~") return null;
  return stripQuotes(trimmed).replace(/\\n/g, "\n");
}

/**
 * Applies the subagent scalar policy to one scalar token: inline comments
 * and misspelled null spellings reject with the subset's named errors, then
 * the text converts. Returns null alongside a recorded error.
 */
function convertScalar(source: string, scalar: YamlScalar, errors: string[]): string | null {
  if (findInlineComment(scalar.raw) >= 0) {
    errors.push(`${source}: line ${scalar.line}: ${INLINE_COMMENT_MESSAGE}`);
    return null;
  }
  const spellingProblem = nullSpellingProblem(scalar.raw);
  if (spellingProblem !== undefined) {
    errors.push(`${source}: line ${scalar.line}: '${scalar.raw}' — ${spellingProblem}`);
    return null;
  }
  return convertScalarText(scalar.raw);
}

function fieldKindError(source: string, key: string, kind: YamlFieldKind): string {
  const expectation = kind === "string" ? "a string or null" : kind === "list" ? "an array or null" : "true, false, or null";
  return `${source}: field '${key}' must be ${expectation}`;
}


/**
 * Reads subagent definition text into typed fields. Unknown fields, duplicate
 * fields, and values whose shape does not match the declared field kind
 * reject with the subagent subset's named errors; scalar values, list items,
 * and block scalars convert with the subagent scalar policy. Structural
 * findings are returned for the caller to name or ignore.
 */
/**
 * Converts one entry's value with the subagent scalar policy and returns the
 * field value. `kind` is undefined for names the field table does not
 * declare: the value still converts so its policy errors surface, but no
 * shape check applies. Returns undefined once the conversion recorded an
 * error; the shape check runs only on clean conversions.
 */
function convertEntryValue(
  source: string,
  entry: YamlSubsetEntry,
  errors: string[],
  kind: YamlFieldKind | undefined,
): string | string[] | null | undefined {
  const value = entry.value;
  if (value.kind === "empty") return null;
  const before = errors.length;
  let converted: string | string[] | null = null;
  if (value.kind === "scalar") {
    converted = convertScalar(source, value.scalar, errors);
  } else if (value.kind === "flow-list" && !value.closed) {
    // An unclosed `[` is a plain scalar in this subset, never a list.
    converted = convertScalar(source, { raw: value.raw, quote: "none", line: entry.line }, errors);
  } else if (value.kind === "block") {
    if (value.indicator !== "|" && value.indicator !== ">") {
      errors.push(`${source}: line ${entry.line}: block scalar '${value.indicator}' carries an unsupported chomping or indentation indicator — use '|' or '>' alone`);
    } else {
      converted = value.content || null;
    }
  } else if (value.kind === "flow-list" || value.kind === "block-list") {
    const items: string[] = [];
    for (const item of value.items) {
      // A first item with no text never opened a list in this subset; it
      // reports as the bare line instead of silently clearing the field.
      if (value.kind === "block-list" && items.length === 0 && item.raw === "") {
        errors.push(`${source}: unsupported YAML line ${item.line}: -`);
      }
      const itemValue = convertScalar(source, item, errors);
      if (typeof itemValue === "string" && itemValue.trim()) items.push(itemValue.trim());
    }
    converted = items;
  }
  // Map values (and blocks rejected above) convert to nothing; the shape
  // check below names the field when one applies.
  if (errors.length !== before) return undefined;
  if (kind === undefined) return converted;
  if (value.kind === "map") {
    errors.push(fieldKindError(source, entry.key, kind));
    return undefined;
  }
  const shape = value.kind === "flow-list" || value.kind === "block-list" ? "list" : "scalar";
  if (shape === "list" ? kind !== "list" : kind === "list" && converted !== null) {
    errors.push(fieldKindError(source, entry.key, kind));
    return undefined;
  }
  return converted;
}

export function readYamlFields(text: string, options: YamlFieldOptions): YamlFieldsResult {
  const document = parseYamlSubset(text, { keyPattern: options.keyPattern, lineBase: options.lineBase });
  const fields: YamlField[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const entry of document.entries) {
    const known = Object.hasOwn(options.fields, entry.key);
    if (!known) errors.push(`${options.source}: unknown field '${entry.key}'`);
    if (seen.has(entry.key)) errors.push(`${options.source}: duplicate field '${entry.key}'`);
    seen.add(entry.key);
    // Values convert even for unknown or repeated keys so every policy error
    // (an inline comment, a misspelled null, a chomping indicator) names its
    // line; only clean conversions of known fields become fields, and a
    // repeated key keeps its last clean conversion.
    const before = errors.length;
    const converted = convertEntryValue(options.source, entry, errors, known ? options.fields[entry.key]! : undefined);
    if (!known || errors.length !== before) continue;
    const existing = fields.findIndex((field) => field.key === entry.key);
    if (existing >= 0) fields.splice(existing, 1);
    fields.push({ key: entry.key, line: entry.line, value: converted! });
  }
  return { fields, errors, findings: document.findings };
}
