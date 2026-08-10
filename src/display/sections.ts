import type { Theme } from "@earendil-works/pi-coding-agent";
import { Markdown, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { getMarkdownTheme, highlightCode } from "@earendil-works/pi-coding-agent";
import { stripVTControlCharacters } from "node:util";
import { RESTATING_SECTION_TITLES } from "./adapter-utils";
import { padVisible, rightPriorityRows, wrapHanging } from "./layout";
import { sanitizeDisplayLine, sanitizeDisplayText, sanitizeMarkdownForDisplay, truncateCodePoints } from "./sanitize";
import { styleTone } from "./theme";
import type {
  DisplayMatchItem,
  DisplayPolicy,
  DisplayRecordItem,
  DisplaySection,
  DisplaySectionBlock,
  DisplayTone,
} from "./types";
import { renderDisplayDiffLines } from "./diff";

const MAX_SECTION_TITLE_CODE_POINTS = 80;
const MAX_SECTION_LABEL_CODE_POINTS = 64;
const MAX_SECTION_VALUE_CODE_POINTS = 1_024;
const MAX_SECTION_TEXT_CODE_POINTS = 32_768;
const MAX_SECTION_CODE_POINTS = 65_536;
const MAX_SECTION_ITEMS = 64;
const MAX_SECTION_FIELDS = 12;
const MAX_BODY_VISUAL_LINES = 12;
const MAX_MARKDOWN_VISUAL_LINES = 240;
const MAX_CODE_VISUAL_LINES = 240;

interface RenderContext {
  readonly theme: Theme;
  readonly width: number;
  readonly policy: DisplayPolicy;
}

/**
 * Tree-style section title: `├─ TitleName` in muted tone, original case.
 * The branch prefix replaces the tree rail that components.ts applies to
 * other body lines, so the caller must skip rail application for lines
 * whose stripped content starts with `├─`.
 */
function titleLine(title: string, context: RenderContext): string {
  const label = truncateCodePoints(sanitizeDisplayLine(title), MAX_SECTION_TITLE_CODE_POINTS);
  return context.theme.fg("muted", `\u251c\u2500 ${label}`);
}

function wrap(prefix: string, text: string, tone: DisplayTone | undefined, context: RenderContext): string[] {
  const content = truncateCodePoints(sanitizeDisplayText(text), MAX_SECTION_TEXT_CODE_POINTS);
  const effectivePrefix = prefix.startsWith(" ") ? `  ${prefix}` : `  ${prefix}`;
  if (context.policy.wordWrap) {
    return wrapHanging(effectivePrefix, styleTone(context.theme, tone, content), context.width);
  }
  return content.split("\n").map((line, index) => padVisible(
    truncateToWidth(
      `${index === 0 ? effectivePrefix : " ".repeat(Math.min(context.width, visibleWidth(effectivePrefix)))}${styleTone(context.theme, tone, line)}`,
      context.width,
      "\u2026",
    ),
    context.width,
  ));
}

function renderText(block: Extract<DisplaySectionBlock, { kind: "text" }>, context: RenderContext): string[] {
  return wrap("", block.text, block.tone, context);
}

function boundVisual(lines: string[], maximum: number, context: RenderContext, marker = "lines omitted"): string[] {
  const cap = Math.max(0, Math.floor(maximum));
  if (lines.length <= cap) return lines;
  return [
    ...lines.slice(0, cap).map((line) => padVisible(line, context.width)),
    padVisible(context.theme.fg("muted", `... ${lines.length - cap} ${marker}`), context.width),
  ];
}

function renderMarkdown(block: Extract<DisplaySectionBlock, { kind: "markdown" }>, context: RenderContext): string[] {
  const markdown = new Markdown(
    truncateCodePoints(sanitizeMarkdownForDisplay(block.text), MAX_SECTION_CODE_POINTS),
    0,
    0,
    getMarkdownTheme(),
  );
  const lines = markdown.render(Math.max(1, context.width - 2)).map((line) => padVisible(truncateToWidth(`  ${line}`, context.width, "\u2026"), context.width));
  markdown.invalidate();
  return boundVisual(lines, MAX_MARKDOWN_VISUAL_LINES, context);
}

function languageFor(block: Extract<DisplaySectionBlock, { kind: "code" }>): string {
  return block.language?.trim() || "text";
}

function renderCode(block: Extract<DisplaySectionBlock, { kind: "code" }>, context: RenderContext): string[] {
  const source = truncateCodePoints(sanitizeDisplayText(block.text), MAX_SECTION_CODE_POINTS);
  const language = languageFor(block);
  const sourceLines = source.split("\n");
  const startLine = block.startLine ?? 1;
  const highlighted = (() => {
    try {
      return highlightCode(source, language);
    } catch {
      return sourceLines;
    }
  })();
  const lastLine = startLine + sourceLines.length - 1;
  const gutter = block.lineNumbers === false ? 0 : String(lastLine).length + 2;
  const bodyIndent = "  ";
  const bodyWidth = Math.max(1, context.width - gutter - visibleWidth(bodyIndent));
  const rendered: string[] = [];
  const count = Math.max(sourceLines.length, highlighted.length);
  for (let index = 0; index < count; index += 1) {
    const number = block.lineNumbers === false
      ? ""
      : `${context.theme.fg("muted", String(startLine + index).padStart(String(lastLine).length))}  `;
    const body = highlighted[index] ?? sourceLines[index] ?? "";
    const wrapped = context.policy.wordWrap
      ? wrapTextWithAnsi(body || " ", bodyWidth)
      : [truncateToWidth(body, bodyWidth, "\u2026")];
    wrapped.forEach((line, wrappedIndex) => {
      const continuation = wrappedIndex === 0 ? number : " ".repeat(gutter);
      rendered.push(padVisible(`${bodyIndent}${continuation}${line}`, context.width));
    });
  }
  return boundVisual(rendered, MAX_CODE_VISUAL_LINES, context);
}

function renderList(block: Extract<DisplaySectionBlock, { kind: "list" }>, context: RenderContext): string[] {
  const items = block.items.slice(0, MAX_SECTION_ITEMS);
  const lines = items.flatMap((item) => {
    const label = item.label
      ? `${truncateCodePoints(sanitizeDisplayLine(item.label), MAX_SECTION_LABEL_CODE_POINTS)}=`
      : "";
    return wrap(label ? `  ${context.theme.fg("dim", label)}` : "  ", item.value, item.tone, context);
  });
  if (block.items.length > items.length) lines.push(padVisible(context.theme.fg("muted", `${block.items.length - items.length} entries omitted`), context.width));
  return lines;
}

function renderRecord(record: DisplayRecordItem, context: RenderContext): string[] {
  const lines = wrap("  ", record.title, record.tone ?? "accent", context);
  const fields = (record.fields ?? []).slice(0, MAX_SECTION_FIELDS);
  if (fields.length) {
    const joined = fields.map((field) => (
      `${context.theme.fg("dim", `${truncateCodePoints(sanitizeDisplayLine(field.label), MAX_SECTION_LABEL_CODE_POINTS)}=`)}${styleTone(
        context.theme,
        field.tone,
        truncateCodePoints(sanitizeDisplayText(field.value, { multiline: false }), MAX_SECTION_VALUE_CODE_POINTS),
      )}`
    )).join(context.theme.fg("muted", " · "));
    lines.push(...wrap("    ", joined, "muted", context));
  }
  if (record.body) {
    const bodyLines = boundVisual(
      wrap("    ", record.body, record.bodyTone ?? "default", context),
      MAX_BODY_VISUAL_LINES,
      context,
      "body lines omitted",
    );
    lines.push(...bodyLines);
  }
  if ((record.fields?.length ?? 0) > fields.length) {
    lines.push(padVisible(context.theme.fg("muted", `    ${record.fields!.length - fields.length} fields omitted`), context.width));
  }
  return lines;
}

function renderRecords(block: Extract<DisplaySectionBlock, { kind: "records" }>, context: RenderContext): string[] {
  const items = block.items.slice(0, MAX_SECTION_ITEMS);
  const lines = items.flatMap((item) => renderRecord(item, context));
  if (block.items.length > items.length) lines.push(padVisible(context.theme.fg("muted", `${block.items.length - items.length} records omitted`), context.width));
  return lines;
}

function renderPaths(block: Extract<DisplaySectionBlock, { kind: "paths" }>, context: RenderContext): string[] {
  const items = block.items.slice(0, MAX_SECTION_ITEMS);
  const lines = items.flatMap((item) => rightPriorityRows(
    `  ${styleTone(context.theme, item.tone, truncateCodePoints(sanitizeDisplayLine(item.path), 2_048))}`,
    item.meta ? context.theme.fg("muted", truncateCodePoints(sanitizeDisplayLine(item.meta), 256)) : "",
    context.width,
  ));
  if (block.items.length > items.length) lines.push(padVisible(context.theme.fg("muted", `${block.items.length - items.length} paths omitted`), context.width));
  return lines;
}

/**
 * Build an excerpt string with highlighted ranges emphasized in the accent
 * tone. Non-highlighted text uses the item tone (default or muted). The
 * sanitized text and highlight offsets are assumed to match (valid for
 * normal source text without embedded control characters).
 */
function excerptWithHighlights(
  item: DisplayMatchItem,
  context: RenderContext,
): string {
  if (!item.excerpt) return "";
  const sanitized = truncateCodePoints(sanitizeDisplayText(item.excerpt), MAX_SECTION_TEXT_CODE_POINTS);
  const baseTone = item.tone ?? "default";
  const highlights = item.highlights;
  if (!highlights || highlights.length === 0) {
    return styleTone(context.theme, baseTone, sanitized);
  }
  const sorted = [...highlights].sort((a, b) => a.start - b.start);
  let result = "";
  let pos = 0;
  for (const range of sorted) {
    const start = Math.max(pos, Math.min(range.start, sanitized.length));
    const end = Math.max(start, Math.min(range.end, sanitized.length));
    if (start > pos) {
      result += styleTone(context.theme, baseTone, sanitized.slice(pos, start));
    }
    result += styleTone(context.theme, "accent", sanitized.slice(start, end));
    pos = end;
  }
  if (pos < sanitized.length) {
    result += styleTone(context.theme, baseTone, sanitized.slice(pos));
  }
  return result;
}

/**
 * Grouped match rendering: a file row, then one row per match with a
 * right-aligned dim line number and the matched text emphasized. Long
 * lines are truncated with `…` and never wrapped. No column number and no
 * match/context label. A muted-tone item (context line) renders without
 * emphasis. The optional `meta` suffix (e.g. `+N lines`) is right-aligned
 * at the end of the row.
 */
function renderMatches(block: Extract<DisplaySectionBlock, { kind: "matches" }>, context: RenderContext): string[] {
  const items = block.items.slice(0, MAX_SECTION_ITEMS);
  if (items.length === 0) return [];

  // Flat mode: items without line numbers (pdf_search page matches) render
  // as one row per item: `page N  context…`, with optional right-aligned meta.
  const flatMode = items.every((item) => item.line === undefined);
  if (flatMode) {
    const lines: string[] = [];
    for (const item of items) {
      const pathText = context.theme.fg("dim", truncateCodePoints(sanitizeDisplayLine(item.path), 256));
      const excerpt = excerptWithHighlights(item, context);
      const meta = item.meta ? context.theme.fg("muted", truncateCodePoints(sanitizeDisplayLine(item.meta), 256)) : "";
      const left = `  ${pathText}  ${excerpt}`;
      const row = meta
        ? rightPriorityRows(left, meta, context.width, 2, 4)[0] ?? ""
        : truncateToWidth(left, context.width, "\u2026");
      lines.push(padVisible(row, context.width));
    }
    if (block.items.length > items.length) {
      lines.push(padVisible(context.theme.fg("muted", `${block.items.length - items.length} matches omitted`), context.width));
    }
    return lines;
  }

  const lines: string[] = [];
  let currentPath: string | null = null;

  // Compute the line-number field width across all visible items so every
  // match row aligns within the section.
  const maxLine = items.reduce((max, item) => Math.max(max, item.line ?? 0), 0);
  const lineFieldWidth = Math.max(1, String(maxLine).length);

  for (const item of items) {
    // Emit a file-header row when the path changes.
    if (item.path !== currentPath) {
      currentPath = item.path;
      lines.push(padVisible(
        `  ${context.theme.fg("dim", truncateCodePoints(sanitizeDisplayLine(item.path), 2_048))}`,
        context.width,
      ));
    }

    // Build the match row: indent + right-aligned line number + excerpt.
    const lineNumber = item.line !== undefined
      ? context.theme.fg("dim", String(item.line).padStart(lineFieldWidth))
      : " ".repeat(lineFieldWidth);
    const prefix = `    ${lineNumber}  `;
    const excerpt = excerptWithHighlights(item, context);
    const meta = item.meta ? context.theme.fg("muted", truncateCodePoints(sanitizeDisplayLine(item.meta), 256)) : "";
    const row = meta
      ? rightPriorityRows(`${prefix}${excerpt}`, meta, context.width, 2, 4)[0] ?? ""
      : truncateToWidth(`${prefix}${excerpt}`, context.width, "\u2026");
    lines.push(padVisible(row, context.width));
  }

  if (block.items.length > items.length) {
    lines.push(padVisible(context.theme.fg("muted", `${block.items.length - items.length} matches omitted`), context.width));
  }
  return lines;
}

function renderActivity(block: Extract<DisplaySectionBlock, { kind: "activity" }>, context: RenderContext): string[] {
  const items = block.items.slice(0, MAX_SECTION_ITEMS);
  const glyph = (status?: "running" | "done" | "error") => status === "error" ? "×" : status === "done" ? "✓" : "●";
  const lines = items.map((item) => {
    const prefix = styleTone(context.theme, item.status === "error" ? "error" : item.status === "done" ? "success" : "accent", glyph(item.status));
    const rest = `${truncateCodePoints(sanitizeDisplayLine(item.tool), 80)}  ${truncateCodePoints(sanitizeDisplayLine(item.summary), 1_024)}`.trimEnd();
    return padVisible(truncateToWidth(`  ${prefix}  ${rest}`, context.width, "…"), context.width);
  });
  if (block.items.length > items.length) lines.push(padVisible(context.theme.fg("muted", `${block.items.length - items.length} activities omitted`), context.width));
  return lines;
}

function renderBlock(block: DisplaySectionBlock, context: RenderContext, expanded: boolean): string[] {
  switch (block.kind) {
    case "text": return renderText(block, context);
    case "markdown": return renderMarkdown(block, context);
    case "code": return renderCode(block, context);
    case "list": return renderList(block, context);
    case "records": return renderRecords(block, context);
    case "paths": return renderPaths(block, context);
    case "matches": return renderMatches(block, context);
    case "activity": return renderActivity(block, context);
    case "diff": return renderDisplayDiffLines(block.diff, context.policy, context.theme, context.width, { expanded });
  }
}

function renderSection(section: DisplaySection, context: RenderContext, expanded: boolean, showTitle: boolean): string[] {
  const blocks = section.blocks.filter((block) => expanded || block.kind !== "markdown");
  if (blocks.length === 0) return [];
  // C9: the label-led rule separates two or more sections. A lone section
  // attaches its content directly under the header rail.
  const lines = showTitle ? [titleLine(section.title, context)] : [];
  for (const [index, block] of blocks.entries()) {
    if (index > 0) lines.push(padVisible("", context.width));
    lines.push(...renderBlock(block, context, expanded));
  }
  return lines;
}

export function renderDisplaySections(
  sections: readonly DisplaySection[],
  policy: DisplayPolicy,
  theme: Theme,
  width: number,
  expanded: boolean,
): string[] {
  const context: RenderContext = { theme, width: Math.max(1, Math.floor(width)), policy };
  const selected = sections
    .filter((section) => expanded || section.compact === true)
    // C8: an expanded section that only restates the header is not rendered.
    .filter((section) => !RESTATING_SECTION_TITLES.has(section.title.trim().toLowerCase()))
    // A conditional section counts only when it is present in this mode.
    .filter((section) => section.blocks.some((block) => expanded || block.kind !== "markdown"));
  const showTitles = selected.length >= 2;
  const lines: string[] = [];
  for (const [index, section] of selected.entries()) {
    if (index > 0) lines.push(padVisible("", context.width));
    lines.push(...renderSection(section, context, expanded, showTitles));
  }
  // The body never ends with an empty row.
  while (lines.length > 0 && stripVTControlCharacters(lines.at(-1)!).trim() === "") lines.pop();
  return lines;
}
