import { posix, win32 } from "node:path";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";

import { keyHint } from "@earendil-works/pi-coding-agent";
import {
  Container,
  Spacer,
  Text,
  getCapabilities,
  hyperlink,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
} from "@earendil-works/pi-tui";

import type {
  DisplayRange,
  FdDetails,
  FdPathDetail,
  RgDetails,
  RgFileDetail,
  RgLineDetail,
  SearchRenderMetadata,
} from "./contracts";

interface RenderOptions {
  expanded: boolean;
  isPartial: boolean;
}

function controlEscape(codePoint: number): string {
  if (codePoint <= 0xff) return `\\x${codePoint.toString(16).padStart(2, "0")}`;
  return `\\u${codePoint.toString(16).padStart(4, "0")}`;
}

/** Escapes untrusted values before any trusted theme or OSC sequences are applied. */
export function sanitizeSearchLine(value: unknown): string {
  const stripped = stripVTControlCharacters(String(value ?? ""));
  let output = "";
  for (const char of stripped) {
    const codePoint = char.codePointAt(0)!;
    if (codePoint === 0x0a || codePoint === 0x0d) output += "\\n";
    else if (codePoint === 0x09) output += "\\t";
    else if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      output += controlEscape(codePoint);
    } else output += char;
  }
  return output;
}

export function sanitizeSearchMultiline(value: unknown): string {
  const stripped = stripVTControlCharacters(String(value ?? "")).replace(/\r\n?/g, "\n");
  let output = "";
  for (const char of stripped) {
    const codePoint = char.codePointAt(0)!;
    if (codePoint === 0x0a) output += "\n";
    else if (codePoint === 0x09) output += "\\t";
    else if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      output += controlEscape(codePoint);
    } else output += char;
  }
  return output;
}

function padLine(line: string, width: number): string {
  return line + " ".repeat(Math.max(0, width - visibleWidth(line)));
}

class HangingText implements Component {
  constructor(
    private readonly prefix: string,
    private readonly content: string,
  ) {}

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const prefixWidth = visibleWidth(this.prefix);
    if (prefixWidth >= safeWidth) {
      return wrapTextWithAnsi(this.prefix + this.content, safeWidth).map((line) => padLine(line, safeWidth));
    }
    const wrapped = wrapTextWithAnsi(this.content || " ", Math.max(1, safeWidth - prefixWidth));
    const continuationPrefix = " ".repeat(prefixWidth);
    return wrapped.map((line, index) => padLine((index === 0 ? this.prefix : continuationPrefix) + line, safeWidth));
  }

  invalidate(): void {}
}

function firstText(result: any): string | undefined {
  if (!Array.isArray(result?.content)) return undefined;
  return result.content.find((item: any) => item?.type === "text" && typeof item.text === "string")?.text;
}

function hasOwn(value: unknown, key: string): boolean {
  return value !== null && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, key);
}

function formatCallValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => sanitizeSearchLine(item)).join(", ")}]`;
  return sanitizeSearchLine(value);
}

function buildCallText(
  name: "rg" | "fd",
  args: any,
  theme: any,
): string {
  const hasArgs = args !== null && typeof args === "object";
  const pattern = hasArgs && hasOwn(args, "pattern")
    ? sanitizeSearchLine(args.pattern)
    : name === "fd" && hasArgs
      ? "(all files)"
      : "(building...)";
  let text = theme.fg("toolTitle", theme.bold(`${name} `)) + theme.fg("accent", pattern);
  if (hasArgs && hasOwn(args, "path")) {
    text += theme.fg("muted", " in ") + theme.fg("accent", sanitizeSearchLine(args.path));
  }

  const order = name === "rg"
    ? ["case", "literal", "word", "hidden", "noIgnore", "offset", "limit", "includeGlobs", "excludeGlobs", "types", "beforeContext", "afterContext", "maxDepth"]
    : ["case", "hidden", "noIgnore", "offset", "limit", "matchMode", "types", "extensions", "excludeGlobs", "minDepth", "maxDepth"];
  const metadata = order
    .filter((key) => hasOwn(args, key))
    .map((key) => `${key}=${formatCallValue(args[key])}`);
  if (metadata.length > 0) text += `\n  ${theme.fg("dim", metadata.join(" · "))}`;
  return text;
}

export function renderRgCall(args: any, theme: any, context: any): Component {
  const text = context?.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
  text.setText(buildCallText("rg", args, theme));
  return text;
}

export function renderFdCall(args: any, theme: any, context: any): Component {
  const text = context?.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
  text.setText(buildCallText("fd", args, theme));
  return text;
}

function truncationLabels(details: RgDetails | FdDetails): string[] {
  const labels: string[] = [];
  if (details.truncation.lineExcerpts > 0) labels.push(`${details.truncation.lineExcerpts} line excerpts`);
  if (details.truncation.contextLinesOmitted > 0) labels.push(`${details.truncation.contextLinesOmitted} context lines omitted`);
  if (details.truncation.contentBudgetReached) labels.push("content budget reached");
  if (details.stderrTruncated) labels.push("stderr truncated");
  return labels;
}

function compactFallback(value: string, fallback: string): string {
  const text = sanitizeSearchLine(value || fallback);
  return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}

function rgSummary(details: RgDetails | undefined, theme: any, fallback?: string): string {
  if (!details?.page) {
    const text = compactFallback(fallback || "", "rg failed");
    return theme.fg("error", `✗ ${text}`);
  }
  const returned = details.page.returned;
  if (returned === 0) return theme.fg("dim", "No matches");
  let text = theme.fg("success", "✓") + " " + theme.fg("text", `${returned} ${returned === 1 ? "match" : "matches"}`);
  const fileCount = details.files.length;
  text += theme.fg("muted", ` in ${fileCount} ${fileCount === 1 ? "file" : "files"}`);
  const extras: string[] = [];
  if (details.page.total !== undefined) extras.push(`${details.page.total} total`);
  if (details.page.offset > 0) extras.push(`offset ${details.page.offset}`);
  if (details.page.hasMore && details.page.nextOffset !== null) extras.push(`next ${details.page.nextOffset}`);
  extras.push(...truncationLabels(details));
  if (extras.length > 0) text += "  " + theme.fg("muted", extras.join(" · "));
  return text;
}

function fdSummary(details: FdDetails | undefined, theme: any, fallback?: string): string {
  if (!details?.page) {
    const text = compactFallback(fallback || "", "fd failed");
    return theme.fg("error", `✗ ${text}`);
  }
  const returned = details.page.returned;
  if (returned === 0) return theme.fg("dim", "No paths found");
  let text = theme.fg("success", "✓") + " " + theme.fg("text", `${returned} ${returned === 1 ? "path" : "paths"}`);
  const extras: string[] = [];
  extras.push(`${details.page.total ?? returned} total`);
  if (details.page.offset > 0) extras.push(`offset ${details.page.offset}`);
  if (details.page.hasMore && details.page.nextOffset !== null) extras.push(`next ${details.page.nextOffset}`);
  extras.push(...truncationLabels(details));
  if (extras.length > 0) text += "  " + theme.fg("muted", extras.join(" · "));
  return text;
}

function validPresentation(value: SearchRenderMetadata | undefined): value is SearchRenderMetadata {
  return value?.version === 1
    && typeof value.executionCwd === "string"
    && (value.platform === "linux" || value.platform === "darwin" || value.platform === "win32");
}

function localPathUrl(rawPath: string, presentation: SearchRenderMetadata | undefined): string | undefined {
  if (!validPresentation(presentation) || /[\u0000-\u001f\u007f-\u009f]/u.test(rawPath)) return undefined;
  const windows = presentation.platform === "win32";
  if (/^(?:\\\\|\/\/)/.test(rawPath)) return undefined;
  try {
    const paths = windows ? win32 : posix;
    if (!paths.isAbsolute(presentation.executionCwd)) return undefined;
    const absolute = paths.isAbsolute(rawPath)
      ? paths.normalize(rawPath)
      : paths.resolve(presentation.executionCwd, rawPath);
    if (windows && /^(?:\\\\|\/\/)/.test(absolute)) return undefined;
    return pathToFileURL(absolute, { windows }).href;
  } catch {
    return undefined;
  }
}

function linkPath(
  styled: string,
  rawPath: string | undefined,
  encoding: string,
  presentation: SearchRenderMetadata | undefined,
): string {
  if (encoding !== "text" || !rawPath || !getCapabilities().hyperlinks) return styled;
  const url = localPathUrl(rawPath, presentation);
  return url ? hyperlink(styled, url) : styled;
}

function stylePathLabel(path: FdPathDetail, presentation: SearchRenderMetadata | undefined, theme: any): string {
  const visible = sanitizeSearchLine(path.displayPath);
  const slash = visible.lastIndexOf("/");
  const directory = slash >= 0 ? visible.slice(0, slash + 1) : "";
  const basename = slash >= 0 ? visible.slice(slash + 1) : visible;
  const styled = basename
    ? theme.fg("dim", directory) + theme.fg("accent", theme.bold(basename))
    : theme.fg("accent", theme.bold(visible));
  return linkPath(styled, path.path, path.encoding, presentation);
}

function styleFileTitle(file: RgFileDetail, presentation: SearchRenderMetadata | undefined, theme: any): string {
  const visible = sanitizeSearchLine(file.path);
  const styled = theme.fg("accent", theme.bold(visible));
  return linkPath(styled, file.pathEncoding === "text" ? file.path : undefined, file.pathEncoding, presentation);
}

function safeRanges(text: string, ranges: DisplayRange[]): DisplayRange[] {
  const sanitized = ranges
    .filter((range) => Number.isInteger(range.start) && Number.isInteger(range.end) && range.start >= 0 && range.end > range.start && range.end <= text.length)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const output: DisplayRange[] = [];
  for (const range of sanitized) {
    const previous = output.at(-1);
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else output.push({ ...range });
  }
  return output;
}

function styleMatchText(line: RgLineDetail, theme: any): string {
  const rawDisplay = line.display?.text ?? "";
  const display = sanitizeSearchLine(rawDisplay);
  if (display !== rawDisplay) return theme.fg("toolOutput", display);
  const ranges = safeRanges(display, line.display?.highlights ?? []);
  if (ranges.length === 0) return theme.fg("toolOutput", display);
  let output = "";
  let position = 0;
  for (const range of ranges) {
    output += theme.fg("toolOutput", display.slice(position, range.start));
    output += theme.fg("accent", theme.bold(display.slice(range.start, range.end)));
    position = range.end;
  }
  output += theme.fg("toolOutput", display.slice(position));
  return output;
}

function rgGutter(line: RgLineDetail, lineDigits: number, columnDigits: number, theme: any): string {
  const lineNumber = String(line.line).padStart(lineDigits);
  if (line.kind === "match") {
    const column = String(line.column ?? 1).padStart(columnDigits);
    return theme.fg("accent", `${lineNumber}:${column}`) + theme.fg("dim", " │ ");
  }
  return theme.fg("dim", `${lineNumber}${" ".repeat(columnDigits + 1)} │ `);
}

function addRgFiles(container: Container, details: RgDetails, theme: any): void {
  const allLines = details.files.flatMap((file) => file.lines);
  const lineDigits = Math.max(1, ...allLines.map((line) => String(line.line).length));
  const columnDigits = Math.max(1, ...allLines.filter((line) => line.kind === "match").map((line) => String(line.column ?? 1).length));

  details.files.forEach((file, fileIndex) => {
    if (fileIndex > 0) container.addChild(new Spacer(1));
    container.addChild(new Text(styleFileTitle(file, details.presentation, theme), 0, 0));
    for (const line of file.lines) {
      const prefix = rgGutter(line, lineDigits, columnDigits, theme);
      const content = line.kind === "context"
        ? theme.fg("dim", sanitizeSearchLine(line.display?.text ?? ""))
        : styleMatchText(line, theme);
      container.addChild(new HangingText(prefix, content));
    }
    if (file.continuation) {
      const next = file.continuation.nextOffset === null ? "end" : `offset ${file.continuation.nextOffset}`;
      const prefix = theme.fg("dim", `${" ".repeat(lineDigits + columnDigits + 1)} │ `);
      container.addChild(new HangingText(prefix, theme.fg("warning", `… ${file.continuation.omitted} omitted · continue at ${next}`)));
    }
  });
}

function addFooter(container: Container, details: RgDetails | FdDetails, theme: any): void {
  const notices = truncationLabels(details);
  if (details.page.hasMore && details.page.nextOffset !== null) {
    notices.unshift(`More results available at offset ${details.page.nextOffset}`);
  }
  if (notices.length > 0) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("warning", notices.join(" · ")), 0, 0));
  }
  container.addChild(new Spacer(1));
  container.addChild(new Text(keyHint("app.tools.expand", "to collapse"), 0, 0));
}

function legacyExpanded(summary: string, content: string, theme: any): Component {
  const container = new Container();
  container.addChild(new Text(summary, 0, 0));
  container.addChild(new Spacer(1));
  container.addChild(new Text(theme.fg("toolOutput", sanitizeSearchMultiline(content)), 0, 0));
  container.addChild(new Spacer(1));
  container.addChild(new Text(keyHint("app.tools.expand", "to collapse"), 0, 0));
  return container;
}

export function renderRgResult(result: any, options: RenderOptions, theme: any): Component {
  const details = result?.details as RgDetails | undefined;
  const content = firstText(result) ?? "";
  if (options.isPartial) return new Text(theme.fg("muted", "Searching…"), 0, 0);
  const summary = rgSummary(details, theme, content);
  const hasResults = (details?.page?.returned ?? 0) > 0;
  const expandable = hasResults || (!details?.page && content.length > 0);
  if (!options.expanded || !expandable) {
    const hint = expandable ? `  ${keyHint("app.tools.expand", "to expand")}` : "";
    return new Text(summary + hint, 0, 0);
  }
  const rich = validPresentation(details?.presentation)
    && details!.files.every((file) => file.lines.every((line) => line.display !== undefined));
  if (!rich) return legacyExpanded(summary, content, theme);

  const container = new Container();
  container.addChild(new Text(summary, 0, 0));
  container.addChild(new Spacer(1));
  addRgFiles(container, details!, theme);
  addFooter(container, details!, theme);
  return container;
}

export function renderFdResult(result: any, options: RenderOptions, theme: any): Component {
  const details = result?.details as FdDetails | undefined;
  const content = firstText(result) ?? "";
  if (options.isPartial) return new Text(theme.fg("muted", "Finding paths…"), 0, 0);
  const summary = fdSummary(details, theme, content);
  const hasResults = (details?.page?.returned ?? 0) > 0;
  const expandable = hasResults || (!details?.page && content.length > 0);
  if (!options.expanded || !expandable) {
    const hint = expandable ? `  ${keyHint("app.tools.expand", "to expand")}` : "";
    return new Text(summary + hint, 0, 0);
  }
  if (!validPresentation(details?.presentation)) return legacyExpanded(summary, content, theme);

  const container = new Container();
  container.addChild(new Text(summary, 0, 0));
  container.addChild(new Spacer(1));
  for (const path of details!.paths) {
    container.addChild(new HangingText("  ", stylePathLabel(path, details!.presentation, theme)));
  }
  addFooter(container, details!, theme);
  return container;
}
