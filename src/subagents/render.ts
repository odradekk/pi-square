import { stripVTControlCharacters } from "node:util";
import {
  getMarkdownTheme,
  keyHint,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Box,
  Container,
  Markdown,
  Text,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
} from "@earendil-works/pi-tui";
import type {
  SubagentErrorInfo,
  SubagentNotificationDetails,
  SubagentRunDetails,
  SubagentTimelineItem,
  SubagentUsage,
} from "./types";

const CALL_TASK_LINES = 3;
const LIVE_MARKDOWN_LINES = 5;
const RECENT_TIMELINE_ITEMS = 8;
const ROW_GAP = 3;
const STACK_INDENT = 2;
const AUTH_HEADER_PATTERN = /(authorization\s*:\s*)[^,;\r\n]+/gi;
const SECRET_ASSIGNMENT_PATTERN = /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[=:]\s*)([^\s,;]+)/gi;
const BEARER_PATTERN = /(bearer\s+)[A-Za-z0-9._~+/=-]+/gi;

export interface SubagentRenderState {
  startedAt?: number;
  endedAt?: number;
  interval?: NodeJS.Timeout;
}

class SubagentResultComponent extends Container {}

class ResponsiveRow implements Component {
  constructor(
    private readonly left: string,
    private readonly right: string,
    private readonly gap = ROW_GAP,
    private readonly stackIndent = STACK_INDENT,
  ) {}

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const leftLines = wrapTextWithAnsi(this.left || " ", safeWidth);
    if (!this.right) return leftLines;

    const right = truncateToWidth(this.right, safeWidth, "...");
    const leftWidth = visibleWidth(leftLines[0] ?? "");
    const rightWidth = visibleWidth(right);
    if (leftLines.length === 1 && leftWidth + this.gap + rightWidth <= safeWidth) {
      return [`${leftLines[0]}${" ".repeat(safeWidth - leftWidth - rightWidth)}${right}`];
    }

    const availableIndent = Math.max(0, Math.min(this.stackIndent, safeWidth - rightWidth));
    const padding = Math.max(availableIndent, safeWidth - rightWidth);
    return [...leftLines, `${" ".repeat(padding)}${right}`];
  }

  invalidate(): void {}
}

class SectionHeading implements Component {
  constructor(
    private readonly label: string,
    private readonly theme: Theme,
  ) {}

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const label = this.theme.fg("muted", this.label.toUpperCase());
    const prefix = `${label} `;
    const remaining = Math.max(0, safeWidth - visibleWidth(prefix));
    return ["", `${prefix}${this.theme.fg("dim", "─".repeat(remaining))}`];
  }

  invalidate(): void {}
}

class FullRule implements Component {
  constructor(private readonly theme: Theme) {}

  render(width: number): string[] {
    return [this.theme.fg("dim", "─".repeat(Math.max(1, width)))];
  }

  invalidate(): void {}
}

class VisualHead implements Component {
  constructor(
    private readonly text: string,
    private readonly maxLines: number,
    private readonly theme: Theme,
  ) {}

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const lines = this.text.split("\n").flatMap((line) => wrapTextWithAnsi(line || " ", safeWidth));
    if (lines.length <= this.maxLines) return lines;
    const visible = lines.slice(0, this.maxLines);
    visible[visible.length - 1] = truncateToWidth(
      `${visible[visible.length - 1]} ${this.theme.fg("muted", "...")}`,
      safeWidth,
      "...",
    );
    return visible;
  }

  invalidate(): void {}
}

class OneVisualLine implements Component {
  constructor(private readonly text: string) {}

  render(width: number): string[] {
    return [truncateToWidth(this.text, Math.max(1, width), "...")];
  }

  invalidate(): void {}
}

class MarkdownVisualTail implements Component {
  private readonly markdown: Markdown;

  constructor(
    source: string,
    private readonly theme: Theme,
  ) {
    this.markdown = new Markdown(source, 0, 0, getMarkdownTheme());
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const lines = this.markdown.render(safeWidth);
    const tail = lines.slice(-LIVE_MARKDOWN_LINES);
    const skipped = Math.max(0, lines.length - tail.length);
    if (skipped === 0) return tail;
    return [
      truncateToWidth(this.theme.fg("dim", `${skipped} earlier visual lines`), safeWidth, "..."),
      ...tail,
    ];
  }

  invalidate(): void {
    this.markdown.invalidate();
  }
}

export function sanitizeSubagentDisplay(value: unknown): string {
  return stripVTControlCharacters(typeof value === "string" ? value : String(value ?? ""))
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "   ")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
    .replace(AUTH_HEADER_PATTERN, "$1[REDACTED]")
    .replace(SECRET_ASSIGNMENT_PATTERN, "$1[REDACTED]")
    .replace(BEARER_PATTERN, "$1[REDACTED]");
}

function hasOwn(value: unknown, key: string): boolean {
  return Boolean(value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, key));
}

function firstText(result: any): string {
  if (!Array.isArray(result?.content)) return "";
  return result.content
    .filter((item: any) => item?.type === "text" && typeof item.text === "string")
    .map((item: any) => item.text)
    .join("\n");
}

function isRunDetails(value: unknown): value is SubagentRunDetails {
  const details = value as Partial<SubagentRunDetails> | undefined;
  return details?.version === 3
    && typeof details.id === "string"
    && (details.mode === "fg" || details.mode === "bg" || details.mode === "resume")
    && (details.phase === "running" || details.phase === "cancelling" || details.phase === "done" || details.phase === "error" || details.phase === "aborted");
}

function formatCount(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return "0";
  if (count < 1000) return String(Math.floor(count));
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0ms";
  if (ms < 1000) return `${Math.floor(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

export function formatUsage(usage: Partial<SubagentUsage> | undefined, model?: string, durationMs?: number): string {
  const parts: string[] = [];
  const turns = Number(usage?.turns ?? 0);
  const input = Number(usage?.input ?? 0);
  const output = Number(usage?.output ?? 0);
  const cacheRead = Number(usage?.cacheRead ?? 0);
  const cacheWrite = Number(usage?.cacheWrite ?? 0);
  const cost = Number(usage?.cost ?? 0);
  if (turns > 0) parts.push(`${Math.floor(turns)} turn${turns === 1 ? "" : "s"}`);
  if (input > 0) parts.push(`↑${formatCount(input)}`);
  if (output > 0) parts.push(`↓${formatCount(output)}`);
  if (cacheRead > 0) parts.push(`R${formatCount(cacheRead)}`);
  if (cacheWrite > 0) parts.push(`W${formatCount(cacheWrite)}`);
  if (cost > 0) parts.push(`$${cost.toFixed(4)}`);
  if (typeof durationMs === "number" && durationMs > 0) parts.push(formatDuration(durationMs));
  if (model) parts.push(sanitizeSubagentDisplay(model));
  return parts.join(" · ");
}

function shortId(id: unknown): string {
  const value = sanitizeSubagentDisplay(id);
  const withoutPrefix = value.startsWith("subagent_") ? value.slice("subagent_".length) : value;
  return withoutPrefix.length > 8 ? withoutPrefix.slice(0, 8) : withoutPrefix || "unknown";
}

function modeLabel(mode: unknown): string {
  if (mode === "bg") return "background";
  if (mode === "resume") return "resumed";
  return "foreground";
}

function agentLabel(details: SubagentRunDetails): string {
  return sanitizeSubagentDisplay(details.agent?.name || "generic");
}

function statusPresentation(phase: string, theme: Theme): string {
  switch (phase) {
    case "done":
      return theme.fg("success", "✓ done");
    case "error":
      return theme.fg("error", "✗ error");
    case "aborted":
      return theme.fg("warning", "× aborted");
    case "queued":
      return theme.fg("muted", "— queued");
    case "cancelling":
      return theme.fg("warning", "× cancelling");
    case "active":
      return theme.fg("warning", "→ active");
    default:
      return theme.fg("warning", "→ running");
  }
}

function clipInline(value: unknown, max: number): string {
  const codePoints = Array.from(String(value ?? "").trim());
  return codePoints.length <= max ? codePoints.join("") : `${codePoints.slice(0, Math.max(0, max - 3)).join("")}...`;
}

interface ToolEventDisplay {
  tool: string;
  summary: string;
}

function toolDisplayFromJson(toolName: string, args: any): ToolEventDisplay {
  let summary: string;
  switch (toolName) {
    case "pwsh":
      summary = clipInline(args?.command, 80);
      break;
    case "rg":
      summary = `/${clipInline(args?.pattern || "...", 40)}/ in ${clipInline(args?.path || ".", 48)}`;
      break;
    case "fd":
      summary = `${clipInline(args?.pattern || ".", 40)} in ${clipInline(args?.path || ".", 48)}`;
      break;
    case "search": {
      const queries = Array.isArray(args?.queries) ? args.queries : [];
      summary = `${queries.length} quer${queries.length === 1 ? "y" : "ies"}: ${clipInline(queries[0] || "...", 50)}`;
      break;
    }
    case "fetch": {
      const urls = Array.isArray(args?.urls) ? args.urls : [];
      summary = `${urls.length} URL${urls.length === 1 ? "" : "s"}`;
      break;
    }
    case "libs":
      summary = clipInline(args?.libraryName || "...", 60);
      break;
    case "docs":
      summary = clipInline(args?.libraryId || "...", 60);
      break;
    default:
      summary = "called";
      break;
  }
  return {
    tool: sanitizeSubagentDisplay(toolName),
    summary: sanitizeSubagentDisplay(summary),
  };
}

function semanticToolEvent(item: SubagentTimelineItem): ToolEventDisplay {
  const original = sanitizeSubagentDisplay(item.text).trim();
  if (item.phase === "start") {
    const jsonCall = /^([A-Za-z0-9_.-]+)\s+(\{.*\})$/s.exec(original);
    if (jsonCall) {
      const toolName = jsonCall[1] ?? "tool";
      try {
        return toolDisplayFromJson(toolName, JSON.parse(jsonCall[2] ?? "{}"));
      } catch {
        return { tool: toolName, summary: "called" };
      }
    }
  }

  const colon = /^([A-Za-z0-9_.-]+):\s*(.*)$/s.exec(original);
  if (colon) return { tool: colon[1] ?? "tool", summary: colon[2] ?? "" };
  const spaced = /^([A-Za-z0-9_.-]+)\s+(.*)$/s.exec(original);
  if (spaced) return { tool: spaced[1] ?? "tool", summary: spaced[2] ?? "" };
  return { tool: original || "tool", summary: "" };
}

type ToolCallStatus = "running" | "done" | "failed";

interface ToolActivity {
  kind: "tool";
  display: ToolEventDisplay;
  status: ToolCallStatus;
}

interface ProseActivity {
  kind: "prose";
  item: SubagentTimelineItem;
}

type ActivityItem = ToolActivity | ProseActivity;

function buildActivityItems(timeline: SubagentTimelineItem[]): ActivityItem[] {
  const items: ActivityItem[] = [];
  const openCalls: ToolActivity[] = [];

  for (const item of timeline) {
    if (!item || item.kind === "assistant") continue;
    if (item.kind !== "tool") {
      items.push({ kind: "prose", item });
      continue;
    }

    const display = semanticToolEvent(item);
    if (item.phase === "start") {
      const activity: ToolActivity = { kind: "tool", display, status: "running" };
      items.push(activity);
      openCalls.push(activity);
      continue;
    }

    const matching = [...openCalls].reverse().find((activity) => (
      activity.status === "running" && activity.display.tool === display.tool
    ));
    if (matching) {
      matching.status = item.isError ? "failed" : "done";
    } else {
      items.push({
        kind: "tool",
        display: { tool: display.tool, summary: "" },
        status: item.isError ? "failed" : "done",
      });
    }
  }

  return items.slice(-RECENT_TIMELINE_ITEMS);
}

function toolActivityStatus(status: ToolCallStatus, theme: Theme): string {
  if (status === "running") return statusPresentation("running", theme);
  if (status === "failed") return theme.fg("error", "✗ failed");
  return theme.fg("success", "✓ done");
}

function toolLedgerRow(activity: ToolActivity, theme: Theme): Component {
  const left = theme.fg("accent", activity.display.tool)
    + (activity.display.summary ? theme.fg("text", `  ${activity.display.summary}`) : "");
  return new ResponsiveRow(left, toolActivityStatus(activity.status, theme));
}

function substantivePreview(value: unknown): string {
  const lines = sanitizeSubagentDisplay(value)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const selected = lines.find((line) => !/^(```|~~~)$/.test(line)) ?? "(no output)";
  return selected
    .replace(/^#{1,6}\s+/, "")
    .replace(/^[-*+]\s+/, "")
    .replace(/^\d+[.)]\s+/, "");
}

function outcomeText(details: SubagentRunDetails, fallback: string): string {
  if (details.phase === "done") return details.finalText || fallback || "(no output)";
  if (details.salvagedFinalText) return details.salvagedFinalText;
  return details.errorInfo?.message || details.error || fallback || "Subagent failed.";
}

function latestToolActivity(details: SubagentRunDetails): ToolActivity | undefined {
  if (!Array.isArray(details.timeline)) return undefined;
  return [...buildActivityItems(details.timeline)].reverse().find(
    (item): item is ToolActivity => item.kind === "tool",
  );
}

function elapsed(details: SubagentRunDetails, state: SubagentRenderState, isPartial: boolean): number | undefined {
  if (typeof details.durationMs === "number" && !isPartial) return details.durationMs;
  const startedAt = Number(details.startedAt || state.startedAt);
  if (!Number.isFinite(startedAt) || startedAt <= 0) return undefined;
  const endedAt = !isPartial && state.endedAt ? state.endedAt : Date.now();
  return Math.max(0, endedAt - startedAt);
}

function runByline(details: SubagentRunDetails, theme: Theme): string {
  const parts = [
    details.model ? sanitizeSubagentDisplay(details.model) : "",
    details.agent?.effort ? sanitizeSubagentDisplay(details.agent.effort) : "",
  ].filter(Boolean);
  return parts.length > 0 ? theme.fg("dim", parts.join(" · ")) : "";
}

function metadata(details: SubagentRunDetails, state: SubagentRenderState, isPartial: boolean): string {
  const duration = elapsed(details, state, isPartial);
  const parts = [formatUsage(details.usage, undefined, duration)];
  if (details.retries > 0) parts.push(`${details.retries} retr${details.retries === 1 ? "y" : "ies"}`);
  if (Array.isArray(details.toolErrors) && details.toolErrors.length > 0) {
    parts.push(`${details.toolErrors.length} tool error${details.toolErrors.length === 1 ? "" : "s"}`);
  }
  return parts.filter(Boolean).join(" · ");
}

function expandHint(expanded: boolean): string {
  return keyHint("app.tools.expand", expanded ? " collapse" : " expand");
}

function addHeader(
  component: Container,
  details: SubagentRunDetails,
  phase: string,
  theme: Theme,
  notification: boolean,
  expanded: boolean,
): void {
  const identityParts = notification
    ? [
        theme.fg("toolTitle", theme.bold("subagent")),
        theme.fg("accent", theme.bold(agentLabel(details))),
        theme.fg("muted", modeLabel(details.mode)),
      ]
    : [
        theme.fg("accent", theme.bold(agentLabel(details))),
        theme.fg("muted", modeLabel(details.mode)),
      ];
  if (notification && !expanded) identityParts.push(theme.fg("dim", shortId(details.id)));
  component.addChild(new ResponsiveRow(
    identityParts.join(theme.fg("dim", " / ")),
    statusPresentation(phase, theme),
  ));
  const byline = runByline(details, theme);
  if (byline) component.addChild(new Text(byline, 0, 0));
}

function addFooter(
  component: Container,
  details: SubagentRunDetails,
  theme: Theme,
  state: SubagentRenderState,
  isPartial: boolean,
  expanded: boolean,
): void {
  if (expanded) {
    component.addChild(new Text(
      `\n${theme.fg("dim", "ID  ")}${theme.fg("muted", sanitizeSubagentDisplay(details.id))}`,
      0,
      0,
    ));
    component.addChild(new FullRule(theme));
  }
  component.addChild(new ResponsiveRow(
    theme.fg("dim", metadata(details, state, isPartial)),
    expandHint(expanded),
  ));
}

function addActivityAndIssues(
  component: Container,
  details: SubagentRunDetails,
  theme: Theme,
): void {
  const activities = Array.isArray(details.timeline) ? buildActivityItems(details.timeline) : [];
  if (activities.length > 0) {
    component.addChild(new SectionHeading("activity", theme));
    for (const activity of activities) {
      if (activity.kind === "tool") component.addChild(toolLedgerRow(activity, theme));
      else {
        const event = activity.item;
        const color = event.kind === "error" || event.isError ? "error" : "dim";
        component.addChild(new Text(theme.fg(color, sanitizeSubagentDisplay(event.text)), 0, 0));
      }
    }
  }

  const toolErrors = Array.isArray(details.toolErrors) ? details.toolErrors : [];
  if (toolErrors.length > 0) {
    component.addChild(new SectionHeading("issues", theme));
    for (const error of toolErrors) {
      const left = theme.fg("accent", sanitizeSubagentDisplay(error?.tool || "tool"))
        + theme.fg("text", `  ${sanitizeSubagentDisplay(error?.message || "failed")}`);
      component.addChild(new ResponsiveRow(left, theme.fg("error", "✗ failed")));
    }
  }
}

function addExpandedDetails(
  component: Container,
  details: SubagentRunDetails,
  fallback: string,
  theme: Theme,
  state: SubagentRenderState,
): void {
  const task = sanitizeSubagentDisplay(details.task).trim();
  if (task) {
    component.addChild(new SectionHeading("task", theme));
    component.addChild(new Text(task, 0, 0));
  }

  const finalText = sanitizeSubagentDisplay(
    details.phase === "done"
      ? details.finalText || fallback
      : details.salvagedFinalText || details.finalText,
  ).trim();
  if (finalText) {
    component.addChild(new SectionHeading(details.phase === "done" ? "result" : "recovered", theme));
    component.addChild(new Markdown(finalText, 0, 0, getMarkdownTheme()));
  }

  if (details.phase === "error" || details.phase === "aborted") {
    component.addChild(new SectionHeading("error", theme));
    const error = sanitizeSubagentDisplay(details.errorInfo?.message || details.error || fallback || "Subagent failed.").trim();
    if (error) component.addChild(new Text(theme.fg("error", error), 0, 0));
    const cause = sanitizeSubagentDisplay(details.errorInfo?.cause).trim();
    if (cause && cause !== error) component.addChild(new Text(theme.fg("dim", `Cause  ${cause}`), 0, 0));
    const action = sanitizeSubagentDisplay(details.errorInfo?.suggestedAction).trim();
    if (action) component.addChild(new Text(theme.fg("warning", `Next   ${action}`), 0, 0));
    if (!finalText && details.rawSessionOutput) {
      component.addChild(new SectionHeading("session excerpt", theme));
      component.addChild(new Text(sanitizeSubagentDisplay(details.rawSessionOutput), 0, 0));
    }
  }

  addActivityAndIssues(component, details, theme);
  addFooter(component, details, theme, state, false, true);
}

function addExpandedRunning(
  component: Container,
  details: SubagentRunDetails,
  theme: Theme,
  state: SubagentRenderState,
): void {
  const task = sanitizeSubagentDisplay(details.task).trim();
  if (task) {
    component.addChild(new SectionHeading("task", theme));
    component.addChild(new Text(task, 0, 0));
  }

  const liveText = sanitizeSubagentDisplay(details.liveText || details.finalText).trim();
  if (liveText) {
    component.addChild(new SectionHeading("live", theme));
    component.addChild(new Markdown(liveText, 0, 0, getMarkdownTheme()));
  }

  addActivityAndIssues(component, details, theme);
  addFooter(component, details, theme, state, true, true);
}

function renderRunResult(
  component: SubagentResultComponent,
  result: any,
  details: SubagentRunDetails,
  options: { expanded: boolean; isPartial: boolean },
  theme: Theme,
  state: SubagentRenderState,
  notification = false,
): void {
  const fallback = sanitizeSubagentDisplay(firstText(result));
  const queued = !options.isPartial && details.mode === "bg" && details.phase === "running";
  const phase = queued
    ? "queued"
    : options.isPartial && details.phase !== "cancelling"
      ? "running"
      : details.phase;
  addHeader(component, details, phase, theme, notification, options.expanded);

  if (queued) {
    component.addChild(new Text(
      `${theme.fg("dim", "ID  ")}${theme.fg("muted", sanitizeSubagentDisplay(details.id))}`,
      0,
      0,
    ));
    return;
  }

  if (options.isPartial) {
    if (options.expanded) {
      addExpandedRunning(component, details, theme, state);
      return;
    }

    const toolActivity = latestToolActivity(details);
    if (toolActivity) component.addChild(toolLedgerRow(toolActivity, theme));
    const liveText = sanitizeSubagentDisplay(details.liveText || details.finalText).trim();
    if (liveText) component.addChild(new MarkdownVisualTail(liveText, theme));
    else if (!toolActivity) component.addChild(new Text(theme.fg("muted", "Waiting for child output"), 0, 0));
    addFooter(component, details, theme, state, true, false);
    return;
  }

  if (options.expanded) {
    addExpandedDetails(component, details, fallback, theme, state);
    return;
  }

  if (notification) {
    component.addChild(new OneVisualLine(
      theme.fg("dim", "Task  ") + theme.fg("text", substantivePreview(details.task)),
    ));
  }
  const preview = substantivePreview(outcomeText(details, fallback));
  const previewColor = details.phase === "error" ? "error" : details.phase === "aborted" ? "warning" : "toolOutput";
  component.addChild(new OneVisualLine(theme.fg(previewColor, preview)));
  if ((details.phase === "error" || details.phase === "aborted") && details.errorInfo?.suggestedAction) {
    component.addChild(new OneVisualLine(
      theme.fg("warning", `Next  ${sanitizeSubagentDisplay(details.errorInfo.suggestedAction)}`),
    ));
  }
  addFooter(component, details, theme, state, false, false);
}

function renderSpecialResult(result: any, options: { expanded: boolean }, theme: Theme): Component {
  const details = result?.details;
  const content = sanitizeSubagentDisplay(firstText(result)).trim() || "(no output)";
  const component = new Container();

  if (details?.status === "already_running") {
    const left = theme.fg("toolTitle", theme.bold("subagent"))
      + theme.fg("dim", " / ")
      + theme.fg("muted", "resumed");
    component.addChild(new ResponsiveRow(left, statusPresentation("active", theme)));
    component.addChild(new Text(
      `${theme.fg("dim", "ID  ")}${theme.fg("muted", sanitizeSubagentDisplay(details.id))}`,
      0,
      0,
    ));
    return component;
  }

  const error = details?.status === "error" ? details.error as SubagentErrorInfo | undefined : undefined;
  if (error) {
    component.addChild(new ResponsiveRow(
      theme.fg("toolTitle", theme.bold("subagent")),
      statusPresentation("error", theme),
    ));
    if (options.expanded) component.addChild(new SectionHeading("error", theme));
    component.addChild(new Text(theme.fg("error", sanitizeSubagentDisplay(error.message)), 0, 0));
    if (error.suggestedAction) {
      component.addChild(new Text(theme.fg("warning", `Next  ${sanitizeSubagentDisplay(error.suggestedAction)}`), 0, 0));
    }
    if (options.expanded && error.cause) {
      component.addChild(new Text(theme.fg("dim", `Cause  ${sanitizeSubagentDisplay(error.cause)}`), 0, 0));
    }
    if (options.expanded) {
      component.addChild(new FullRule(theme));
      component.addChild(new ResponsiveRow("", expandHint(true)));
    } else if (error.cause) {
      component.addChild(new ResponsiveRow("", expandHint(false)));
    }
    return component;
  }

  if (options.expanded) component.addChild(new Text(content, 0, 0));
  else component.addChild(new OneVisualLine(content));
  return component;
}

export function renderSubagentCall(args: any, theme: Theme, context: any): Component {
  const state = (context?.state ?? {}) as SubagentRenderState;
  if (context?.executionStarted && state.startedAt === undefined) {
    state.startedAt = Date.now();
    state.endedAt = undefined;
  }

  const component = new Container();
  const mode = args?.mode === "bg" || args?.mode === "resume" ? args.mode : "fg";
  const identity = [theme.fg("toolTitle", theme.bold("subagent"))];
  if (mode !== "resume") identity.push(theme.fg("accent", sanitizeSubagentDisplay(args?.agent || "generic")));
  identity.push(theme.fg("muted", modeLabel(mode)));
  component.addChild(new Text(identity.join(theme.fg("dim", " / ")), 0, 0));

  const task = sanitizeSubagentDisplay(args?.task || "(building...)").trim() || "(empty task)";
  component.addChild(new VisualHead(task, CALL_TASK_LINES, theme));

  const meta: string[] = [];
  if (hasOwn(args, "context") && Number(args.context) > 0) meta.push(`context=${Math.floor(Number(args.context))}`);
  if (typeof args?.model === "string" && args.model) meta.push(`model=${sanitizeSubagentDisplay(args.model)}`);
  if (typeof args?.thinkingLevel === "string" && args.thinkingLevel) meta.push(`effort=${sanitizeSubagentDisplay(args.thinkingLevel)}`);
  if (typeof args?.cwd === "string" && args.cwd) meta.push(`cwd=${sanitizeSubagentDisplay(args.cwd)}`);
  if (typeof args?.systemPrompt === "string" && args.systemPrompt.trim()) meta.push("custom instructions");
  if (meta.length > 0) component.addChild(new Text(theme.fg("dim", meta.join(" · ")), 0, 0));
  if (mode === "resume" && args?.id) {
    component.addChild(new Text(
      `${theme.fg("dim", "ID  ")}${theme.fg("muted", sanitizeSubagentDisplay(args.id))}`,
      0,
      0,
    ));
  }
  return component;
}

export function renderSubagentResult(
  result: any,
  options: { expanded: boolean; isPartial: boolean },
  theme: Theme,
  context: any,
): Component {
  const state = (context?.state ?? {}) as SubagentRenderState;
  if (state.startedAt === undefined) state.startedAt = Date.now();
  if (options.isPartial && !state.interval) {
    state.interval = setInterval(() => context?.invalidate?.(), 1000);
    state.interval.unref?.();
  }
  if (!options.isPartial || context?.isError) {
    state.endedAt ??= Date.now();
    if (state.interval) {
      clearInterval(state.interval);
      state.interval = undefined;
    }
  }

  if (!isRunDetails(result?.details)) return renderSpecialResult(result, options, theme);
  const component = context?.lastComponent instanceof SubagentResultComponent
    ? context.lastComponent
    : new SubagentResultComponent();
  component.clear();
  renderRunResult(component, result, result.details, options, theme, state);
  component.invalidate();
  return component;
}

export function renderSubagentNotification(
  message: { content?: unknown; details?: SubagentNotificationDetails },
  options: { expanded: boolean },
  theme: Theme,
): Component {
  const details = message.details?.result;
  const error = message.details?.status === "error" || details?.phase === "error";
  const shell = new Box(1, 1, (text) => theme.bg(error ? "toolErrorBg" : "toolSuccessBg", text));
  if (!isRunDetails(details)) {
    const fallback = sanitizeSubagentDisplay(message.content || "Background subagent notification");
    shell.addChild(options.expanded ? new Text(fallback, 0, 0) : new OneVisualLine(fallback));
    return shell;
  }
  const component = new SubagentResultComponent();
  renderRunResult(
    component,
    { content: [{ type: "text", text: message.content }] },
    details,
    { expanded: options.expanded, isPartial: false },
    theme,
    {},
    true,
  );
  shell.addChild(component);
  return shell;
}

export const __testables = {
  CALL_TASK_LINES,
  LIVE_MARKDOWN_LINES,
  RECENT_TIMELINE_ITEMS,
  substantivePreview,
  shortId,
  modeLabel,
};
