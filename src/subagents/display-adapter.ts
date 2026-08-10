import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { decorateToolDefinition, type DisplayRuntimeProvider, type InternalToolDisplayAdapter } from "../display/tool-renderer";
import type { DisplayActivityItem, DisplayDescriptionV1, DisplayRow, DisplaySection, DisplayTone, OperationalLifecycle, OperationalQualifier } from "../display/types";
import { toolEventDisplay } from "./tool-display";
import type { SubagentRunDetails, SubagentTimelineItem } from "./types";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function textResult(result: AgentToolResult<unknown>): string {
  return result.content
    .filter((item): item is { type: "text"; text: string } => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
}

function shortId(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const suffix = value.startsWith("subagent_") ? value.slice("subagent_".length) : value;
  return suffix.slice(0, 8);
}

/** Derive an explicit lifecycle + qualifiers from phase, partial, and isError. */
function subagentLifecycle(
  details: Record<string, unknown>,
  partial: boolean,
  isError: boolean,
  phase: "call" | "result",
): { lifecycle: OperationalLifecycle; qualifiers: OperationalQualifier[] } {
  if (phase === "call") {
    return { lifecycle: "pending", qualifiers: [] };
  }
  const detailPhase = String(details.phase ?? "").toLowerCase();
  const qualifiers: OperationalQualifier[] = [];

  if (partial) {
    const partialQualifiers: OperationalQualifier[] = ["partial"];
    if (typeof details.retries === "number" && details.retries > 0) {
      partialQualifiers.push("retrying");
    }
    return { lifecycle: "running", qualifiers: partialQualifiers };
  }

  // Background running without partial → queued
  if (detailPhase === "running" && details.mode === "bg") {
    return { lifecycle: "queued", qualifiers };
  }

  if (detailPhase === "cancelling") return { lifecycle: "running", qualifiers: ["cancelling"] };

  if (detailPhase === "aborted" || detailPhase === "cancelled" || detailPhase === "canceled") {
    return { lifecycle: "aborted", qualifiers };
  }

  if (detailPhase === "error" || detailPhase === "failed" || isError) {
    return { lifecycle: "failed", qualifiers };
  }

  if (typeof details.retries === "number" && details.retries > 0) {
    qualifiers.push("warning");
  }

  return { lifecycle: "completed", qualifiers };
}

function tailLines(value: string, maximum: number): { text: string; omitted: number } {
  const lines = value.replace(/\r\n?/g, "\n").split("\n");
  const selected = lines.slice(-maximum);
  return { text: selected.join("\n"), omitted: Math.max(0, lines.length - selected.length) };
}

// ─── Activity pairing ──────────────────────────────────────────────

interface ToolCall {
  startItem?: SubagentTimelineItem;
  endItem?: SubagentTimelineItem;
  toolName: string;
}

/**
 * Pair start/end timeline entries into one call per tool invocation.
 * Uses toolEventDisplay for consistent tool-name extraction so end entries
 * like "read: ok" do not produce a malformed "read:" key.
 */
function pairToolCalls(timeline: SubagentTimelineItem[]): ToolCall[] {
  const calls: ToolCall[] = [];
  const pendingByTool = new Map<string, number>();

  for (const item of timeline) {
    if (!item || item.kind !== "tool" || typeof item.text !== "string") continue;
    const display = toolEventDisplay(item);
    const toolName = display.tool;

    if (item.phase === "start") {
      const idx = calls.length;
      calls.push({ startItem: item, toolName });
      pendingByTool.set(toolName, idx);
    } else if (item.phase === "end") {
      const idx = pendingByTool.get(toolName);
      if (idx !== undefined && calls[idx]?.endItem === undefined) {
        calls[idx]!.endItem = item;
      } else {
        calls.push({ endItem: item, toolName });
      }
    }
  }
  return calls;
}

function activityItems(timeline: SubagentTimelineItem[]): DisplayActivityItem[] {
  if (!Array.isArray(timeline)) return [];
  return pairToolCalls(timeline).slice(-8).map((call) => {
    const startDisplay = call.startItem ? toolEventDisplay(call.startItem) : undefined;
    const tool = startDisplay?.tool ?? call.toolName;
    const summary = startDisplay?.summary ?? "called";
    const status = call.endItem
      ? (call.endItem.isError ? "error" : "done")
      : call.startItem ? "running" : "done";
    return { tool, summary, status };
  });
}

function issueRows(details: Record<string, unknown>): DisplayRow[] {
  if (!Array.isArray(details.toolErrors)) return [];
  return details.toolErrors.slice(-4).flatMap((value) => {
    const issue = record(value);
    const message = typeof issue.message === "string" ? issue.message : typeof issue.error === "string" ? issue.error : undefined;
    return message ? [{ text: message, tone: "error" as DisplayTone }] : [];
  });
}

// ─── Sections ──────────────────────────────────────────────────────

function taskSection(details: Record<string, unknown>): DisplaySection | undefined {
  const task = typeof details.task === "string" ? details.task.trim() : "";
  return task ? { title: "Task", blocks: [{ kind: "text", text: task }], compact: false } : undefined;
}

function resultSection(title: string, text: string): DisplaySection | undefined {
  if (!text) return undefined;
  return { title, blocks: [{ kind: "markdown", text }], compact: false };
}

function activitySection(timeline: SubagentTimelineItem[]): DisplaySection | undefined {
  const items = activityItems(timeline);
  return items.length > 0 ? { title: "Activity", blocks: [{ kind: "activity", items }], compact: false } : undefined;
}

function issueSection(details: Record<string, unknown>): DisplaySection | undefined {
  const rows = issueRows(details);
  return rows.length > 0
    ? { title: "Issues", blocks: rows.map((r) => ({ kind: "text" as const, text: r.text, tone: r.tone })) }
    : undefined;
}

function usageSection(details: Record<string, unknown>): DisplaySection | undefined {
  const usage = record(details.usage);
  const turns = typeof usage.turns === "number" ? usage.turns : undefined;
  const input = typeof usage.input === "number" ? usage.input : undefined;
  const output = typeof usage.output === "number" ? usage.output : undefined;
  const cacheRead = typeof usage.cacheRead === "number" ? usage.cacheRead : undefined;
  const cost = typeof usage.cost === "number" ? usage.cost : undefined;
  const parts: string[] = [];
  if (turns !== undefined) parts.push(`${turns} turns`);
  if (input !== undefined) parts.push(`${formatTokens(input)} in`);
  if (output !== undefined) parts.push(`${formatTokens(output)} out`);
  if (cacheRead !== undefined) parts.push(`${formatTokens(cacheRead)} cached`);
  if (cost !== undefined) parts.push(`$${cost.toFixed(3)}`);
  return parts.length > 0
    ? { title: "Usage", blocks: [{ kind: "text", text: parts.join(" · "), tone: "muted" as DisplayTone }] }
    : undefined;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** Strip Markdown markers so the collapsed preview matches the expanded body. */
function normalizeForResult(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/`(.+?)`/g, "$1")
    .trim();
}

// ─── Summary ───────────────────────────────────────────────────────

function subagentSummary(
  details: Record<string, unknown>,
  lifecycle: OperationalLifecycle,
): string | undefined {
  const id = shortId(details.id);
  const usage = record(details.usage);
  const turns = typeof usage.turns === "number" ? usage.turns : undefined;
  const input = typeof usage.input === "number" ? usage.input : 0;
  const output = typeof usage.output === "number" ? usage.output : 0;
  const cacheRead = typeof usage.cacheRead === "number" ? usage.cacheRead : 0;
  const cost = typeof usage.cost === "number" ? usage.cost : undefined;
  const totalTokens = input + output + cacheRead;
  const toolErrors = Array.isArray(details.toolErrors) ? details.toolErrors.length : 0;
  const isResume = typeof details.resumed === "boolean" && details.resumed;

  const parts: string[] = [];

  switch (lifecycle) {
    case "completed":
      parts.push("done");
      if (turns !== undefined) parts.push(isResume ? `${turns} turns total` : `${turns} turns`);
      if (totalTokens > 0) parts.push(`${formatTokens(totalTokens)} tokens`);
      if (cost !== undefined) parts.push(`$${cost.toFixed(3)}`);
      if (id) parts.push(`run ${id}`);
      break;
    case "running":
      parts.push("running");
      if (turns !== undefined) parts.push(`${turns} turns so far`);
      if (id) parts.push(`run ${id}`);
      break;
    case "failed":
    case "aborted":
      parts.push(lifecycle === "failed" ? "error" : "aborted");
      if (turns !== undefined) parts.push(`${turns} turns`);
      if (id) parts.push(`run ${id}`);
      break;
    default:
      if (id) parts.push(`run ${id}`);
      break;
  }

  if (toolErrors > 0) parts.push(`${toolErrors} ${toolErrors === 1 ? "tool error" : "tool errors"}`);

  return parts.length > 0 ? parts.join(" · ") : undefined;
}

// ─── Target ────────────────────────────────────────────────────────

/**
 * Target for subagent_delegate: the agent name.
 * For subagent_resume: agent name + short run ID, identical in call and result.
 */
function subagentTarget(
  details: Record<string, unknown>,
  args: Record<string, unknown>,
  isResume: boolean,
): string | undefined {
  const agent = record(details.agent);
  const agentName = typeof agent.name === "string" && agent.name ? agent.name : undefined;
  const argsAgent = typeof args.agent === "string" && args.agent ? args.agent : undefined;
  const name = agentName ?? argsAgent;
  const id = shortId(details.id ?? args.id);

  if (isResume) {
    // At call time only the ID is known; keep it consistent in the result.
    return id;
  }
  return name ?? id;
}

/**
 * Build the canonical operational description for one persisted subagent run.
 */
export function describeSubagentRun(
  name: string,
  run: SubagentRunDetails,
  options: { expanded: boolean; isPartial: boolean; isError: boolean },
  fallbackText: string,
  args: Record<string, unknown> = {},
): DisplayDescriptionV1 {
  const details = run as unknown as Record<string, unknown>;
  const live = String(run.liveText || run.finalText || fallbackText || "").trim();
  const lc = subagentLifecycle(details, options.isPartial, options.isError, "result");
  const isResume = name === "subagent_resume";
  const summary = subagentSummary(details, lc.lifecycle);
  const qualifiers: OperationalQualifier[] = [...lc.qualifiers];
  if (Array.isArray(details.toolErrors) && details.toolErrors.length > 0 && !qualifiers.includes("warning")) {
    qualifiers.push("warning");
  }

  const isTerminal = lc.lifecycle === "completed" || lc.lifecycle === "failed" || lc.lifecycle === "aborted";

  // Rows for non-terminal states (running, queued)
  const rows: DisplayRow[] = [];
  if (!isTerminal) {
    if (lc.lifecycle === "queued" && run.mode === "bg") {
      rows.push({ text: "Queued in the parent session", tone: "muted" as DisplayTone });
    } else if (live) {
      for (const line of tailLines(live, 5).text.split("\n")) {
        rows.push({ text: line, tone: options.isError ? ("error" as DisplayTone) : undefined });
      }
    }
  }

  // Collapsed result preview (compact sections render in collapsed mode).
  // Use text blocks because markdown blocks are filtered in collapsed mode.
  const collapsedSections: DisplaySection[] = [];
  if (isTerminal && !options.expanded && live) {
    const previewText = normalizeForResult(tailLines(live, 5).text);
    collapsedSections.push({ title: "Result", blocks: [{ kind: "text", text: previewText }], compact: true });
  }

  // Expanded sections
  const expandedSections: DisplaySection[] = [];
  if (options.expanded) {
    // Identity row: mode · model · effort
    const agent = record(details.agent);
    const identityParts: string[] = [];
    if (typeof details.mode === "string") identityParts.push(details.mode);
    if (typeof details.model === "string" && details.model) identityParts.push(details.model);
    if (typeof agent.effort === "string" && agent.effort) identityParts.push(agent.effort);
    if (identityParts.length > 0) {
      expandedSections.push({ title: "Identity", blocks: [{ kind: "text", text: identityParts.join(" · "), tone: "muted" as DisplayTone }], compact: true });
    }
    expandedSections.push(...[
      taskSection(details),
      resultSection(options.isPartial ? "Live" : "Result", live),
      activitySection(run.timeline),
      issueSection(details),
      usageSection(details),
    ].filter((s): s is DisplaySection => Boolean(s)));
  }

  return {
    version: 1,
    tool: name,
    family: "agent",
    lifecycle: lc.lifecycle,
    ...(qualifiers.length > 0 ? { qualifiers } : {}),
    title: isResume ? "Resume" : "Subagent",
    target: subagentTarget(details, args, isResume),
    metadata: [],
    rows,
    sections: options.expanded ? expandedSections : collapsedSections,
    durationMs: typeof run.durationMs === "number" ? run.durationMs : undefined,
    summary,
    ...(options.isError || run.phase === "error"
      ? { error: String(run.error || fallbackText || "Subagent failed") }
      : {}),
  } satisfies DisplayDescriptionV1;
}

function createSubagentAdapter(name: string): InternalToolDisplayAdapter<any, unknown, unknown> {
  return {
    describeCall(argsValue, context) {
      const args = record(argsValue);
      const task = typeof args.task === "string" ? args.task : undefined;
      const isResume = name === "subagent_resume";
      const id = shortId(args.id);
      const agentName = typeof args.agent === "string" && args.agent ? args.agent : undefined;

      // Target: agent name for delegate, agent + id for resume
      let target: string | undefined;
      if (isResume) {
        target = id; // Will be updated when run details are available
      } else {
        target = agentName ?? id;
      }

      // Call rows: task preview + mode/context info
      const rows: DisplayRow[] = [];
      if (task) {
        rows.push({ text: task });
      }
      if (isResume) {
        rows.push({ text: "frozen model and effort", tone: "muted" as DisplayTone });
      } else {
        const mode = typeof args.mode === "string" ? args.mode : "fg";
        const contextCount = typeof args.context === "number" ? args.context : undefined;
        const contextStr = contextCount !== undefined
          ? `${contextCount} ${contextCount === 1 ? "context message" : "context messages"}`
          : undefined;
        rows.push({ text: [mode, contextStr].filter(Boolean).join(" · "), tone: "muted" as DisplayTone });
      }

      return {
        version: 1,
        tool: name,
        family: "agent",
        lifecycle: context.executionStarted ? "running" : "queued",
        title: isResume ? "Resume" : "Subagent",
        target,
        metadata: [],
        rows,
      };
    },
    describeResult(result, options, context) {
      const details = record(result.details);
      const args = record(context.args);
      const text = textResult(result);
      const isRun = details.version === 3 && Array.isArray(details.timeline);
      if (!isRun) {
        const isResume = name === "subagent_resume";
        const lc = subagentLifecycle(details, options.isPartial, context.isError, "result");
        const summary = subagentSummary(details, lc.lifecycle);
        return {
          version: 1,
          tool: name,
          family: "agent",
          lifecycle: lc.lifecycle,
          ...(lc.qualifiers.length > 0 ? { qualifiers: lc.qualifiers } : {}),
          title: isResume ? "Resume" : "Subagent",
          target: subagentTarget(details, args, isResume),
          metadata: [],
          rows: [],
          sections: [],
          summary,
          ...(context.isError && text ? { error: text } : {}),
        };
      }

      return describeSubagentRun(
        name,
        details as unknown as SubagentRunDetails,
        { expanded: options.expanded, isPartial: options.isPartial, isError: context.isError },
        text,
        args,
      );
    },
  };
}

export function decorateSubagentTool<T extends ToolDefinition<any, any, any>>(
  definition: T,
  runtime: DisplayRuntimeProvider,
): T {
  return decorateToolDefinition(definition, runtime, createSubagentAdapter(definition.name)) as T;
}
