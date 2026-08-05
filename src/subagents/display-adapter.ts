import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { decorateToolDefinition, type DisplayRuntimeProvider, type InternalToolDisplayAdapter } from "../display/tool-renderer";
import type { DisplayDescriptionV1, DisplayMetadataEntry, DisplayRow, DisplayStatus } from "../display/types";
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

function statusFor(details: Record<string, unknown>, partial: boolean, isError: boolean): DisplayStatus {
  if (isError) return "error";
  const phase = String(details.phase ?? "").toLowerCase();
  if (phase === "error" || phase === "failed") return "error";
  if (phase === "aborted" || phase === "cancelled" || phase === "canceled") return "aborted";
  if (phase === "cancelling") return "warning";
  if (partial) return "partial";
  if (phase === "running" || phase === "queued") return "pending";
  return "success";
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
  if (!expanded) return [{ text: `ACTIVITY  ${latestToolCallSummary(timeline)}`, tone: "muted" }];
  const calls = timeline
    .filter((item) => item?.kind === "tool" && item.phase === "start")
    .slice(-8)
    .map((item) => ({ text: `ACTIVITY  ${latestToolCallSummary([item])}`, tone: "muted" as const }));
  return calls.length > 0 ? calls : [{ text: `ACTIVITY  ${latestToolCallSummary(timeline)}`, tone: "muted" }];
}

function issueRows(details: Record<string, unknown>, expanded: boolean): DisplayRow[] {
  if (!expanded || !Array.isArray(details.toolErrors)) return [];
  return details.toolErrors.slice(-4).flatMap((value) => {
    const issue = record(value);
    const message = typeof issue.message === "string" ? issue.message : typeof issue.error === "string" ? issue.error : undefined;
    return message ? [{ text: `ISSUE  ${message}`, tone: "error" as const }] : [];
  });
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
        status: context.executionStarted ? "pending" : "partial",
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
          status: context.isError ? "error" : options.isPartial ? "partial" : "success",
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
      if (!options.isPartial && !options.expanded && live) {
        rows.unshift({ text: live.split(/\r?\n/, 1)[0]!, tone: context.isError ? "error" : "default" });
      }
      if (run.mode === "bg" && run.phase === "running" && !options.isPartial) {
        rows.unshift({ text: "Queued in the parent session", tone: "muted" });
      }
      return {
        version: 1,
        tool: name,
        family: "agent",
        status: statusFor(details, options.isPartial, context.isError),
        title: name === "subagent_resume" ? "Resume subagent" : "Subagent",
        target: runTarget(details, args),
        metadata: metadata(details),
        rows,
        durationMs: typeof run.durationMs === "number" ? run.durationMs : undefined,
        ...(live && (options.isPartial || options.expanded)
          ? { preview: { text: selected.text, omittedLines: selected.omitted } }
          : {}),
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
