import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { decorateToolDefinition, type DisplayRuntimeProvider, type InternalToolDisplayAdapter } from "../display/tool-renderer";
import type { DisplayActivityItem, DisplayDescriptionV1, DisplayMetadataEntry, DisplayRow, DisplaySection, OperationalLifecycle, OperationalQualifier } from "../display/types";
import { latestToolCallSummary } from "./tool-display";
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
    // Call lifecycle is handled by the component lifecycle bridge
    return { lifecycle: "pending", qualifiers: [] };
  }
  // Result phase
  const detailPhase = String(details.phase ?? "").toLowerCase();
  const qualifiers: OperationalQualifier[] = [];

  // Partial → running with partial qualifier
  if (partial) {
    const partialQualifiers: OperationalQualifier[] = ["partial"];
    // Active retry: retries > 0 during a partial update means the child
    // is currently in an auto-retry cycle.
    if (typeof details.retries === "number" && details.retries > 0) {
      partialQualifiers.push("retrying");
    }
    return { lifecycle: "running", qualifiers: partialQualifiers };
  }

  // Cancelling → running with cancelling qualifier
  if (detailPhase === "cancelling") return { lifecycle: "running", qualifiers: ["cancelling"] };

  // Aborted/cancelled → aborted (overrides isError for clean cancel/abort)
  if (detailPhase === "aborted" || detailPhase === "cancelled" || detailPhase === "canceled") {
    return { lifecycle: "aborted", qualifiers };
  }

  // Error/failed → failed
  if (detailPhase === "error" || detailPhase === "failed" || isError) {
    return { lifecycle: "failed", qualifiers };
  }

  // Retries on a completed result produce a warning qualifier
  if (typeof details.retries === "number" && details.retries > 0) {
    qualifiers.push("warning");
  }

  // Success → completed
  return { lifecycle: "completed", qualifiers };
}

function tailLines(value: string, maximum: number): { text: string; omitted: number } {
  const lines = value.replace(/\r\n?/g, "\n").split("\n");
  const selected = lines.slice(-maximum);
  return { text: selected.join("\n"), omitted: Math.max(0, lines.length - selected.length) };
}

function metadata(details: Record<string, unknown>): DisplayMetadataEntry[] {
  const agent = record(details.agent);
  const usage = record(details.usage);
  const entries: Array<DisplayMetadataEntry | undefined> = [
    shortId(details.id) ? { label: "id", value: shortId(details.id)! } : undefined,
    typeof details.mode === "string" ? { label: "mode", value: details.mode } : undefined,
    typeof details.phase === "string" ? { label: "phase", value: details.phase } : undefined,
    typeof details.model === "string" && details.model ? { label: "model", value: details.model } : undefined,
    typeof agent.effort === "string" && agent.effort ? { label: "effort", value: agent.effort } : undefined,
    typeof usage.turns === "number" ? { label: "turns", value: String(usage.turns) } : undefined,
    typeof details.retries === "number" && details.retries > 0 ? { label: "retries", value: String(details.retries), tone: "warning" } : undefined,
  ];
  return entries.filter((entry): entry is DisplayMetadataEntry => Boolean(entry));
}

function activityRows(timeline: SubagentTimelineItem[], expanded: boolean): DisplayRow[] {
  if (!Array.isArray(timeline) || timeline.length === 0) return [];
  if (!expanded) return [{ text: latestToolCallSummary(timeline), tone: "muted" }];
  const calls = timeline
    .filter((item) => item?.kind === "tool" && item.phase === "start")
    .slice(-8)
    .map((item) => ({ text: latestToolCallSummary([item]), tone: "muted" as const }));
  return calls.length > 0 ? calls : [{ text: latestToolCallSummary(timeline), tone: "muted" }];
}

function issueRows(details: Record<string, unknown>, expanded: boolean): DisplayRow[] {
  if (!expanded || !Array.isArray(details.toolErrors)) return [];
  return details.toolErrors.slice(-4).flatMap((value) => {
    const issue = record(value);
    const message = typeof issue.message === "string" ? issue.message : typeof issue.error === "string" ? issue.error : undefined;
    return message ? [{ text: message, tone: "error" as const }] : [];
  });
}

function activityItems(timeline: SubagentTimelineItem[]): DisplayActivityItem[] {
  if (!Array.isArray(timeline)) return [];
  const latest = new Map<string, SubagentTimelineItem>();
  for (const item of timeline) {
    if (!item || item.kind !== "tool" || typeof item.text !== "string") continue;
    const [tool] = item.text.split(/\s+/, 1);
    const key = tool || item.text;
    if (item.phase === "start" || item.phase === "end") latest.set(key, item);
  }
  return [...latest.values()].slice(-8).map((item) => {
    const text = item.text;
    const separator = text.indexOf(" ");
    const tool = separator > 0 ? text.slice(0, separator) : text;
    return {
      tool,
      summary: latestToolCallSummary([item]),
      status: item.phase === "end" ? (item.isError ? "error" : "done") : "running",
    };
  });
}

function issueRecords(details: Record<string, unknown>): DisplaySection | undefined {
  if (!Array.isArray(details.toolErrors)) return undefined;
  const items = details.toolErrors.slice(-4).flatMap((value) => {
    const issue = record(value);
    const message = typeof issue.message === "string" ? issue.message : typeof issue.error === "string" ? issue.error : undefined;
    return message
      ? [{ title: typeof issue.tool === "string" ? issue.tool : "tool", body: message, tone: "error" as const }]
      : [];
  });
  return items.length > 0 ? { title: "Issues", blocks: [{ kind: "records", items }], compact: false } : undefined;
}

function usageSection(details: Record<string, unknown>): DisplaySection | undefined {
  const usage = record(details.usage);
  const items = [
    typeof usage.turns === "number" ? { label: "turns", value: String(usage.turns) } : undefined,
    typeof usage.input === "number" ? { label: "input", value: String(usage.input) } : undefined,
    typeof usage.output === "number" ? { label: "output", value: String(usage.output) } : undefined,
    typeof usage.cacheRead === "number" ? { label: "cacheRead", value: String(usage.cacheRead) } : undefined,
    typeof usage.cacheWrite === "number" ? { label: "cacheWrite", value: String(usage.cacheWrite) } : undefined,
    typeof usage.cost === "number" ? { label: "cost", value: String(usage.cost) } : undefined,
  ].filter((item): item is { label: string; value: string } => Boolean(item));
  return items.length > 0 ? { title: "Usage", blocks: [{ kind: "list", items }], compact: true } : undefined;
}

function markdownResult(title: string, text: string): DisplaySection | undefined {
  if (!text) return undefined;
  return { title, blocks: [{ kind: "markdown", text }], compact: true };
}

function activitySection(timeline: SubagentTimelineItem[], expanded: boolean): DisplaySection | undefined {
  const items = expanded ? activityItems(timeline) : activityItems(timeline).slice(-1);
  return items.length > 0 ? { title: "Activity", blocks: [{ kind: "activity", items }], compact: !expanded } : undefined;
}

function runTarget(details: Record<string, unknown>, args: Record<string, unknown>): string | undefined {
  const agent = record(details.agent);
  if (typeof agent.name === "string" && agent.name) return agent.name;
  if (typeof args.agent === "string" && args.agent) return args.agent;
  return shortId(details.id ?? args.id);
}

function createSubagentAdapter(name: string): InternalToolDisplayAdapter<any, unknown, unknown> {
  return {
    describeCall(argsValue, context) {
      const args = record(argsValue);
      const task = typeof args.task === "string" ? args.task : undefined;
      const metadataEntries: DisplayMetadataEntry[] = [];
      for (const key of ["mode", "model", "thinkingLevel", "context"] as const) {
        if (args[key] !== undefined && args[key] !== "") metadataEntries.push({ label: key, value: String(args[key]) });
      }
      return {
        version: 1,
        tool: name,
        family: "agent",
        lifecycle: context.executionStarted ? "running" : "queued",
        title: name === "subagent_resume" ? "Resume subagent" : "Subagent",
        target: typeof args.agent === "string" && args.agent ? args.agent : shortId(args.id) ?? "default",
        metadata: metadataEntries,
        ...(task ? { preview: { text: task } } : {}),
      };
    },
    describeResult(result, options, context) {
      const details = record(result.details);
      const args = record(context.args);
      const text = textResult(result);
      const isRun = details.version === 3 && Array.isArray(details.timeline);
      if (!isRun) {
        return {
          version: 1,
          tool: name,
          family: "agent",
          lifecycle: context.isError ? "failed" : options.isPartial ? "running" : "completed",
          ...(options.isPartial ? { qualifiers: ["partial"] } : {}),
          title: name === "subagent_resume" ? "Resume subagent" : "Subagent",
          target: runTarget(details, args),
          rows: text ? [{ text }] : [],
          ...(context.isError && text ? { error: text } : {}),
        };
      }

      const run = details as unknown as SubagentRunDetails;
      const live = String(run.liveText || run.finalText || text || "").trim();
      const selected = options.expanded ? { text: live, omitted: 0 } : tailLines(live, 5);
      const rows = [
        ...activityRows(run.timeline, options.expanded),
        ...issueRows(details, options.expanded),
      ];
      if (options.isPartial && live) {
        rows.push({ text: selected.text, tone: "default" });
      }
      if (!options.isPartial && !options.expanded && live) {
        rows.unshift({ text: live.split(/\r?\n/, 1)[0]!, tone: context.isError ? "error" : "default" });
      }
      if (run.mode === "bg" && run.phase === "running" && !options.isPartial) {
        rows.unshift({ text: "Queued in the parent session", tone: "muted" });
      }
      const structuredSections = [
        markdownResult(options.isPartial ? "Live" : "Result", live),
        activitySection(run.timeline, options.expanded),
        issueRecords(details),
        usageSection(details),
      ].filter((section): section is DisplaySection => Boolean(section));
      const lc = subagentLifecycle(details, options.isPartial, context.isError, "result");
      return {
        version: 1,
        tool: name,
        family: "agent",
        lifecycle: lc.lifecycle,
        ...(lc.qualifiers.length > 0 ? { qualifiers: lc.qualifiers } : {}),
        title: name === "subagent_resume" ? "Resume subagent" : "Subagent",
        target: runTarget(details, args),
        metadata: metadata(details),
        rows,
        sections: options.expanded
          ? structuredSections
          : structuredSections.filter((section) => section.compact === true && section.title !== "Live"),
        durationMs: typeof run.durationMs === "number" ? run.durationMs : undefined,
        ...(context.isError || run.phase === "error"
          ? { error: String(run.error || text || "Subagent failed") }
          : {}),
      } satisfies DisplayDescriptionV1;
    },
  };
}

export function decorateSubagentTool<T extends ToolDefinition<any, any, any>>(
  definition: T,
  runtime: DisplayRuntimeProvider,
): T {
  return decorateToolDefinition(definition, runtime, createSubagentAdapter(definition.name)) as T;
}
