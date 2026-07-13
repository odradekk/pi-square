import { getMarkdownTheme, keyHint } from "@earendil-works/pi-coding-agent";
import {
  Container,
  Markdown,
  Spacer,
  Text,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
} from "@earendil-works/pi-tui";
import {
  escapeMarkdownText,
  formatMarkdownLink,
  sanitizeMarkdownForTerminal,
  sanitizeTerminalText,
  shortenUrl,
} from "../shared/render";
import type {
  DocsCodeItemDetail,
  DocsCodeSnippetDetail,
  DocsDetails,
  DocsInfoSnippetDetail,
  DocsKindCounts,
  LibsCandidateDetail,
  LibsCounts,
  LibsDetails,
} from "../types";

interface RenderOptions {
  expanded: boolean;
  isPartial: boolean;
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
    const continuation = " ".repeat(prefixWidth);
    return wrapped.map((line, index) => padLine((index === 0 ? this.prefix : continuation) + line, safeWidth));
  }

  invalidate(): void {}
}

function firstText(result: any): string | undefined {
  if (!Array.isArray(result?.content)) return undefined;
  return result.content.find((item: any) => item?.type === "text" && typeof item.text === "string")?.text;
}

function inlineText(value: unknown): string {
  return sanitizeTerminalText(String(value ?? "")).replace(/[\n\t]+/g, " ").trim();
}

function compactText(value: unknown, limit = 120): string {
  const text = inlineText(value);
  return text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
}

function compactError(value: unknown, fallback: string): string {
  const text = inlineText(value) || fallback;
  return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}

function nonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function compactNumber(value: number): string {
  if (value < 1_000) return String(value);
  const units = ["k", "m", "b"];
  let scaled = value;
  let unit = "";
  for (const candidate of units) {
    scaled /= 1_000;
    unit = candidate;
    if (scaled < 1_000) break;
  }
  const digits = scaled >= 100 ? 0 : 1;
  return `${scaled.toFixed(digits).replace(/\.0$/, "")}${unit}`;
}

function hasOwn(value: unknown, key: string): boolean {
  return Boolean(value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, key));
}

function renderCall(
  name: string,
  primary: unknown,
  query: unknown,
  metadata: string[],
  theme: any,
  context: any,
): Text {
  const component = context?.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
  const accent = compactText(primary, 96) || "(building...)";
  let text = theme.fg("toolTitle", theme.bold(`${name} `)) + theme.fg("accent", accent);
  const cleanQuery = compactText(query);
  if (cleanQuery) text += `\n  ${theme.fg("dim", `query \"${cleanQuery}\"`)}`;
  if (metadata.length) text += `\n  ${theme.fg("muted", metadata.join(" · "))}`;
  component.setText(text);
  return component;
}

export function renderLibsCall(args: any, theme: any, context: any): Text {
  const metadata: string[] = [];
  if (hasOwn(args, "mode")) metadata.push(inlineText(args.mode));
  if (hasOwn(args, "limit")) metadata.push(`limit ${inlineText(args.limit)}`);
  return renderCall("libs", args?.libraryName, args?.query, metadata, theme, context);
}

export function renderDocsCall(args: any, theme: any, context: any): Text {
  const metadata: string[] = [];
  if (hasOwn(args, "mode")) metadata.push(inlineText(args.mode));
  if (hasOwn(args, "kind")) metadata.push(inlineText(args.kind));
  if (hasOwn(args, "max_tokens")) metadata.push(`${inlineText(args.max_tokens)} tokens`);
  return renderCall("docs", args?.libraryId, args?.query, metadata, theme, context);
}

function libsCounts(details: LibsDetails | undefined): LibsCounts {
  const counts = details?.counts;
  return {
    received: nonNegative(counts?.received),
    invalid: nonNegative(counts?.invalid),
    eligible: nonNegative(counts?.eligible),
    returned: nonNegative(counts?.returned),
    oversized: nonNegative(counts?.oversized),
    omitted: nonNegative(counts?.omitted),
  };
}

function libsSummary(details: LibsDetails | undefined, theme: any, fallback?: string): string {
  if (details?.error || details?.status === "error") {
    return theme.fg("error", `✗ ${compactError(details?.error ?? fallback, "Context7 library search failed")}`);
  }
  if (details?.status === "pending") {
    const retry = nonNegative(details.retryAfter);
    return theme.fg("muted", retry ? `Searching libraries… retry in ${retry}s` : "Searching libraries…");
  }
  if (!details) return theme.fg("success", "✓") + " " + theme.fg("text", "Library results");

  const counts = libsCounts(details);
  let text = theme.fg("success", "✓") + " "
    + theme.fg("text", `${counts.returned} ${counts.returned === 1 ? "library" : "libraries"}`);
  const extras: string[] = [];
  if (counts.omitted) extras.push(`${counts.omitted} omitted`);
  if (counts.oversized) extras.push(`${counts.oversized} oversized`);
  if (counts.invalid) extras.push(`${counts.invalid} invalid`);
  if (details.searchFilterApplied) extras.push("filter applied");
  if (extras.length) text += "  " + theme.fg("muted", extras.join(" · "));
  return text;
}

function validHttpSource(value: unknown): string | undefined {
  const source = inlineText(value);
  try {
    const url = new URL(source);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

function sourceMarkdown(value: unknown): string {
  const source = inlineText(value);
  const url = validHttpSource(source);
  if (!url) return `Source: ${escapeMarkdownText(source)}`;
  return `Source: ${formatMarkdownLink(shortenUrl(url), url)}`;
}

function candidateMetadata(candidate: LibsCandidateDetail): string[] {
  const meta: string[] = [];
  if (candidate.branch) meta.push(`branch ${inlineText(candidate.branch)}`);
  if (candidate.state) meta.push(inlineText(candidate.state));
  if (candidate.lastUpdateDate) meta.push(`updated ${inlineText(candidate.lastUpdateDate)}`);
  if (candidate.totalTokens !== undefined) meta.push(`${compactNumber(nonNegative(candidate.totalTokens))} tokens`);
  if (candidate.totalSnippets !== undefined) meta.push(`${compactNumber(nonNegative(candidate.totalSnippets))} snippets`);
  if (candidate.stars !== undefined) meta.push(`${compactNumber(nonNegative(candidate.stars))} stars`);
  if (candidate.trustScore !== undefined) meta.push(`trust ${compactNumber(nonNegative(candidate.trustScore))}`);
  if (candidate.benchmarkScore !== undefined) meta.push(`benchmark ${compactNumber(nonNegative(candidate.benchmarkScore))}`);
  if (Array.isArray(candidate.versions) && candidate.versions.length) {
    meta.push(`versions ${candidate.versions.map(inlineText).filter(Boolean).join(", ")}`);
  }
  return meta;
}

function addCandidate(container: Container, candidate: LibsCandidateDetail, theme: any): void {
  const rank = Number.isFinite(candidate.rank) ? candidate.rank : "?";
  const title = inlineText(candidate.title) || "Untitled library";
  const id = inlineText(candidate.id);
  container.addChild(new Text(
    theme.fg("muted", `${rank}. `) + theme.fg("accent", theme.bold(title)),
    0,
    0,
  ));
  if (id) container.addChild(new HangingText("   ", theme.fg("text", theme.bold(id))));
  if (candidate.description) {
    container.addChild(new Markdown(sanitizeMarkdownForTerminal(candidate.description), 3, 0, getMarkdownTheme()));
  }
  const metadata = candidateMetadata(candidate);
  if (metadata.length) container.addChild(new HangingText("   ", theme.fg("muted", metadata.join(" · "))));
  if (candidate.source) {
    container.addChild(new Markdown(`   ${sourceMarkdown(candidate.source)}`, 0, 0, getMarkdownTheme()));
  }
}

function validCandidate(value: unknown): value is LibsCandidateDetail {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<LibsCandidateDetail>;
  return typeof candidate.rank === "number"
    && typeof candidate.id === "string"
    && typeof candidate.title === "string";
}

function hasLibsStructure(details: LibsDetails | undefined): boolean {
  return Boolean(
    details
    && Array.isArray(details.candidates)
    && details.candidates.every(validCandidate)
    && details.counts
    && typeof details.counts === "object",
  );
}

export function renderLibsResult(result: any, options: RenderOptions, theme: any): Component {
  const details = result?.details as LibsDetails | undefined;
  if (options.isPartial) return new Text(theme.fg("muted", "Searching libraries…"), 0, 0);

  const structured = hasLibsStructure(details);
  const candidates = structured ? details!.candidates : [];
  const legacyText = !structured && !details?.error ? firstText(result) : undefined;
  const expandable = candidates.length > 0 || Boolean(legacyText);
  const summary = libsSummary(details, theme, firstText(result));

  if (!options.expanded || !expandable) {
    const hint = !options.expanded && expandable ? `  ${keyHint("app.tools.expand", "to expand")}` : "";
    return new Text(summary + hint, 0, 0);
  }

  const container = new Container();
  container.addChild(new Text(summary, 0, 0));
  container.addChild(new Spacer(1));
  if (candidates.length) {
    candidates.forEach((candidate, index) => {
      if (index) container.addChild(new Spacer(1));
      addCandidate(container, candidate, theme);
    });
  } else if (legacyText) {
    container.addChild(new Markdown(sanitizeMarkdownForTerminal(legacyText), 0, 0, getMarkdownTheme()));
  }
  container.addChild(new Spacer(1));
  container.addChild(new Text(keyHint("app.tools.expand", "to collapse"), 0, 0));
  return container;
}

function docsCounts(counts: DocsKindCounts | undefined): DocsKindCounts {
  return {
    received: nonNegative(counts?.received),
    invalid: nonNegative(counts?.invalid),
    eligible: nonNegative(counts?.eligible),
    returned: nonNegative(counts?.returned),
    oversized: nonNegative(counts?.oversized),
    omitted: nonNegative(counts?.omitted),
  };
}

function docsSummary(details: DocsDetails | undefined, theme: any, fallback?: string): string {
  if (details?.error || details?.status === "error") {
    return theme.fg("error", `✗ ${compactError(details?.error ?? fallback, "Context7 documentation request failed")}`);
  }
  if (details?.status === "pending") {
    const retry = nonNegative(details.retryAfter);
    return theme.fg("muted", retry ? `Fetching documentation… retry in ${retry}s` : "Fetching documentation…");
  }
  if (!details) return theme.fg("success", "✓") + " " + theme.fg("text", "Documentation");

  const code = docsCounts(details.codeCounts);
  const info = docsCounts(details.infoCounts);
  const returned: string[] = [];
  if (details.kind !== "info" && (code.returned > 0 || details.kind === "code")) returned.push(`${code.returned} code`);
  if (details.kind !== "code" && (info.returned > 0 || details.kind === "info")) returned.push(`${info.returned} docs`);
  if (!returned.length) returned.push("0 snippets");
  let text = theme.fg("success", "✓") + " " + theme.fg("text", returned.join(" · "));

  const extras: string[] = [];
  if (details.estimatedTokens > 0) extras.push(`${compactNumber(details.estimatedTokens)} tokens`);
  if (details.rules) extras.push("rules included");
  if (details.redirected) extras.push(`redirected ${inlineText(details.finalLibraryId)}`);
  const omitted = code.omitted + info.omitted;
  const oversized = code.oversized + info.oversized;
  const invalid = code.invalid + info.invalid;
  if (omitted) extras.push(`${omitted} omitted`);
  if (oversized) extras.push(`${oversized} oversized`);
  if (invalid) extras.push(`${invalid} invalid`);
  if (details.rulesOmitted) extras.push("rules omitted");
  if (extras.length) text += "  " + theme.fg("muted", extras.join(" · "));
  return text;
}

function codeFence(code: string): string {
  let longest = 0;
  for (const match of code.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  return "`".repeat(Math.max(3, longest + 1));
}

function codeMarkdown(item: DocsCodeItemDetail): string {
  const code = sanitizeTerminalText(item.code);
  const fence = codeFence(code);
  const language = /^[A-Za-z0-9_+.-]{1,40}$/.test(item.language ?? "") ? item.language : "";
  return `${fence}${language}\n${code}\n${fence}`;
}

function sectionHeading(label: string, theme: any): Text {
  return new Text(theme.fg("toolTitle", theme.bold(label)), 0, 0);
}

function snippetHeading(title: string, tokens: number, theme: any): Text {
  let text = theme.fg("accent", theme.bold(inlineText(title)));
  text += "  " + theme.fg("muted", `${compactNumber(nonNegative(tokens))} tokens`);
  return new Text(text, 0, 0);
}

function addSource(container: Container, source: string | undefined): void {
  if (source) container.addChild(new Markdown(sourceMarkdown(source), 0, 0, getMarkdownTheme()));
}

function addCodeSnippet(container: Container, snippet: DocsCodeSnippetDetail, theme: any): void {
  container.addChild(snippetHeading(snippet.title || "Code snippet", snippet.tokens, theme));
  if (snippet.pageTitle && inlineText(snippet.pageTitle) !== inlineText(snippet.title)) {
    container.addChild(new Text(theme.fg("dim", inlineText(snippet.pageTitle)), 0, 0));
  }
  if (snippet.description) {
    container.addChild(new Markdown(sanitizeMarkdownForTerminal(snippet.description), 0, 0, getMarkdownTheme()));
  }
  for (const item of snippet.codeList ?? []) {
    container.addChild(new Spacer(1));
    container.addChild(new Markdown(codeMarkdown(item), 0, 0, getMarkdownTheme()));
  }
  addSource(container, snippet.source);
}

function addInfoSnippet(container: Container, snippet: DocsInfoSnippetDetail, theme: any): void {
  container.addChild(snippetHeading(snippet.breadcrumb || "Documentation", snippet.tokens, theme));
  if (snippet.content) {
    container.addChild(new Markdown(sanitizeMarkdownForTerminal(snippet.content), 0, 0, getMarkdownTheme()));
  }
  addSource(container, snippet.source);
}

function validCodeSnippet(value: unknown): value is DocsCodeSnippetDetail {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const snippet = value as Partial<DocsCodeSnippetDetail>;
  return typeof snippet.title === "string"
    && Array.isArray(snippet.codeList)
    && snippet.codeList.every((item) => Boolean(
      item
      && typeof item === "object"
      && !Array.isArray(item)
      && typeof (item as Partial<DocsCodeItemDetail>).code === "string",
    ));
}

function validInfoSnippet(value: unknown): value is DocsInfoSnippetDetail {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && typeof (value as Partial<DocsInfoSnippetDetail>).content === "string");
}

function hasDocsStructure(details: DocsDetails | undefined): boolean {
  return Boolean(
    details
    && Array.isArray(details.codeSnippets)
    && details.codeSnippets.every(validCodeSnippet)
    && Array.isArray(details.infoSnippets)
    && details.infoSnippets.every(validInfoSnippet)
    && details.codeCounts
    && details.infoCounts,
  );
}

export function renderDocsResult(result: any, options: RenderOptions, theme: any): Component {
  const details = result?.details as DocsDetails | undefined;
  if (options.isPartial) return new Text(theme.fg("muted", "Fetching documentation…"), 0, 0);

  const structured = hasDocsStructure(details);
  const hasRules = structured && Boolean(details!.rules);
  const code = structured ? details!.codeSnippets : [];
  const info = structured ? details!.infoSnippets : [];
  const legacyText = !structured && !details?.error ? firstText(result) : undefined;
  const expandable = hasRules || code.length > 0 || info.length > 0 || Boolean(legacyText);
  const summary = docsSummary(details, theme, firstText(result));

  if (!options.expanded || !expandable) {
    const hint = !options.expanded && expandable ? `  ${keyHint("app.tools.expand", "to expand")}` : "";
    return new Text(summary + hint, 0, 0);
  }

  const container = new Container();
  container.addChild(new Text(summary, 0, 0));
  container.addChild(new Spacer(1));

  if (!structured && legacyText) {
    container.addChild(new Markdown(sanitizeMarkdownForTerminal(legacyText), 0, 0, getMarkdownTheme()));
  } else {
    if (hasRules) {
      container.addChild(sectionHeading("Rules", theme));
      container.addChild(new Markdown(codeMarkdown({ language: "json", code: JSON.stringify(details!.rules, null, 2) }), 0, 0, getMarkdownTheme()));
    }
    if (code.length) {
      if (hasRules) container.addChild(new Spacer(1));
      container.addChild(sectionHeading("Code", theme));
      code.forEach((snippet, index) => {
        container.addChild(new Spacer(1));
        addCodeSnippet(container, snippet, theme);
        if (index < code.length - 1) container.addChild(new Spacer(1));
      });
    }
    if (info.length) {
      if (hasRules || code.length) container.addChild(new Spacer(1));
      container.addChild(sectionHeading("Documentation", theme));
      info.forEach((snippet, index) => {
        container.addChild(new Spacer(1));
        addInfoSnippet(container, snippet, theme);
        if (index < info.length - 1) container.addChild(new Spacer(1));
      });
    }
  }

  container.addChild(new Spacer(1));
  container.addChild(new Text(keyHint("app.tools.expand", "to collapse"), 0, 0));
  return container;
}
