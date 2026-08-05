import type { Theme } from "@earendil-works/pi-coding-agent";
import { Markdown, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { getMarkdownTheme, highlightCode } from "@earendil-works/pi-coding-agent";
import { padVisible, rightPriorityRows, wrapHanging } from "./layout";
import { sanitizeDisplayLine, sanitizeDisplayText, sanitizeMarkdownForDisplay, truncateCodePoints } from "./sanitize";
import { styleRule, styleTone } from "./theme";
import type {
  DisplayMatchItem,
  DisplayPathItem,
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

function titleLine(title: string, context: RenderContext): string {
  const label = context.theme.fg("muted", truncateCodePoints(
    sanitizeDisplayLine(title).toUpperCase(),
    MAX_SECTION_TITLE_CODE_POINTS,
  ));
  const prefix = `${label} `;
  const remainder = Math.max(0, context.width - visibleWidth(prefix));
  return padVisible(`${prefix}${styleRule(context.theme, "─".repeat(remainder))}`, context.width);
}

function wrap(prefix: string, text: string, tone: DisplayTone | undefined, context: RenderContext): string[] {
  const content = truncateCodePoints(sanitizeDisplayText(text), MAX_SECTION_TEXT_CODE_POINTS);
  if (context.policy.wordWrap) {
    return wrapHanging(prefix, styleTone(context.theme, tone, content), context.width);
  }
  return content.split("\n").map((line, index) => padVisible(
    truncateToWidth(
      `${index === 0 ? prefix : " ".repeat(Math.min(context.width, visibleWidth(prefix)))}${styleTone(context.theme, tone, line)}`,
      context.width,
      "...",
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
  const lines = markdown.render(context.width).map((line) => padVisible(truncateToWidth(line, context.width, "..."), context.width));
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
  const highlighted = (() => {
    try {
      return highlightCode(source, language);
    } catch {
      return sourceLines;
    }
  })();
  const gutter = block.lineNumbers === false ? 0 : String(sourceLines.length).length + 2;
  const bodyWidth = Math.max(1, context.width - gutter);
  const rendered: string[] = [];
  const count = Math.max(sourceLines.length, highlighted.length);
  for (let index = 0; index < count; index += 1) {
    const number = block.lineNumbers === false
      ? ""
      : `${context.theme.fg("muted", String(index + 1).padStart(String(sourceLines.length).length))}  `;
    const body = highlighted[index] ?? sourceLines[index] ?? "";
    const wrapped = context.policy.wordWrap
      ? wrapTextWithAnsi(body || " ", bodyWidth)
      : [truncateToWidth(body, bodyWidth, "...")];
    wrapped.forEach((line, wrappedIndex) => {
      const continuation = wrappedIndex === 0 ? number : " ".repeat(gutter);
      rendered.push(padVisible(`${continuation}${line}`, context.width));
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
      wrap("    ", record.body, "default", context),
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
  const lines = items.flatMap((item, index) => [
    ...renderRecord(item, context),
    ...(index < items.length - 1 ? [padVisible("", context.width)] : []),
  ]);
  if (block.items.length > items.length) lines.push(padVisible(context.theme.fg("muted", `${block.items.length - items.length} records omitted`), context.width));
  return lines;
}

function pathMarker(kind: DisplayPathItem["kind"]): string {
  if (kind === "directory") return "d";
  if (kind === "symlink") return "l";
  if (kind === "special") return "s";
  return "f";
}

function renderPaths(block: Extract<DisplaySectionBlock, { kind: "paths" }>, context: RenderContext): string[] {
  const items = block.items.slice(0, MAX_SECTION_ITEMS);
  const lines = items.flatMap((item) => rightPriorityRows(
    `${context.theme.fg("muted", pathMarker(item.kind))} ${styleTone(context.theme, item.tone, truncateCodePoints(sanitizeDisplayLine(item.path), 2_048))}`,
    item.meta ? context.theme.fg("muted", truncateCodePoints(sanitizeDisplayLine(item.meta), 256)) : "",
    context.width,
  ));
  if (block.items.length > items.length) lines.push(padVisible(context.theme.fg("muted", `${block.items.length - items.length} paths omitted`), context.width));
  return lines;
}

function matchLocation(item: DisplayMatchItem): string {
  const location = item.line !== undefined
    ? `:${item.line}${item.column !== undefined ? `:${item.column}` : ""}`
    : "";
  return `${item.path}${location}`;
}

function renderMatches(block: Extract<DisplaySectionBlock, { kind: "matches" }>, context: RenderContext): string[] {
  const items = block.items.slice(0, MAX_SECTION_ITEMS);
  const lines: string[] = [];
  for (const item of items) {
    lines.push(...rightPriorityRows(
      styleTone(context.theme, item.tone ?? "accent", truncateCodePoints(sanitizeDisplayLine(matchLocation(item)), 2_048)),
      item.meta ? context.theme.fg("muted", truncateCodePoints(sanitizeDisplayLine(item.meta), 256)) : "",
      context.width,
    ));
    if (item.excerpt) lines.push(...wrap("  ", item.excerpt, "default", context));
  }
  if (block.items.length > items.length) lines.push(padVisible(context.theme.fg("muted", `${block.items.length - items.length} matches omitted`), context.width));
  return lines;
}

function renderActivity(block: Extract<DisplaySectionBlock, { kind: "activity" }>, context: RenderContext): string[] {
  const items = block.items.slice(0, MAX_SECTION_ITEMS);
  const statusText = (status?: "running" | "done" | "error") => status === "error"
    ? context.theme.fg("error", "× error")
    : status === "done"
      ? context.theme.fg("success", "✓ done")
      : context.theme.fg("accent", "→ running");
  const lines = items.flatMap((item) => rightPriorityRows(
    `${context.theme.fg("toolTitle", truncateCodePoints(sanitizeDisplayLine(item.tool), 80))}  ${truncateCodePoints(sanitizeDisplayLine(item.summary), 1_024)}`,
    statusText(item.status),
    context.width,
  ));
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

function renderSection(section: DisplaySection, context: RenderContext, expanded: boolean): string[] {
  const blocks = section.blocks.filter((block) => expanded || block.kind !== "markdown");
  if (blocks.length === 0) return [];
  const lines = [titleLine(section.title, context)];
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
  const selected = sections.filter((section) => expanded || section.compact === true);
  const lines: string[] = [];
  for (const [index, section] of selected.entries()) {
    if (index > 0) lines.push(padVisible("", context.width));
    lines.push(...renderSection(section, context, expanded));
  }
  return lines;
}
