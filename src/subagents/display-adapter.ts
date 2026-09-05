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

/** Derive an explicit lifecycle + qualifiers from the V4 run phase. */
function subagentLifecycle(
  details: Record<string, unknown>,
  isError: boolean,
): { lifecycle: OperationalLifecycle; qualifiers: OperationalQualifier[] } {
  const detailPhase = String(details.phase ?? "").toLowerCase();
  const qualifiers: OperationalQualifier[] = [];

  if (detailPhase === "queued") return { lifecycle: "queued", qualifiers };

  if (detailPhase === "running") return { lifecycle: "running", qualifiers };

  if (detailPhase === "cancelling") return { lifecycle: "running", qualifiers: ["cancelling"] };

  if (detailPhase === "aborted") return { lifecycle: "aborted", qualifiers };

  if (detailPhase === "failed" || isError) {
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
      ? (call.endItem.isWarning ? "warning" : call.endItem.isError ? "error" : "done")
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

function refusalRows(details: Record<string, unknown>): DisplayRow[] {
  if (!Array.isArray(details.toolWarnings)) return [];
  return details.toolWarnings.slice(-4).flatMap((value) => {
    const refusal = record(value);
    const message = typeof refusal.message === "string" && refusal.message
      ? refusal.message
      : typeof refusal.tool === "string" && refusal.tool ? `${refusal.tool} refused` : undefined;
    return message ? [{ text: message, tone: "warning" as DisplayTone }] : [];
  });
}

/** Anchored refusals are the safety mechanism doing its job, so they render in
 *  their own warning section rather than the failure-toned Issues section. */
function refusalSection(details: Record<string, unknown>): DisplaySection | undefined {
  const rows = refusalRows(details);
  return rows.length > 0
    ? { title: "Refusals", blocks: rows.map((r) => ({ kind: "text" as const, text: r.text, tone: r.tone })) }
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
  const toolWarnings = Array.isArray(details.toolWarnings) ? details.toolWarnings.length : 0;
  const isResume = details.operation === "resume";

  const parts: string[] = [];

  switch (lifecycle) {
    case "completed":
      parts.push("completed");
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
      parts.push(lifecycle);
      if (turns !== undefined) parts.push(`${turns} turns`);
      if (id) parts.push(`run ${id}`);
      break;
    default:
      if (id) parts.push(`run ${id}`);
      break;
  }

  if (toolErrors > 0) parts.push(`${toolErrors} ${toolErrors === 1 ? "tool error" : "tool errors"}`);
  if (toolWarnings > 0) parts.push(`${toolWarnings} anchored refusal${toolWarnings === 1 ? "" : "s"}`);

  return parts.length > 0 ? parts.join(" · ") : undefined;
}

// ─── Target ────────────────────────────────────────────────────────

/**
 * Target for delegate_subagent: the agent name.
 * For resume_subagent: the short run ID, identical in call and result.
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
  options: { expanded: boolean; isError: boolean },
  fallbackText: string,
  args: Record<string, unknown> = {},
): DisplayDescriptionV1 {
  const details = run as unknown as Record<string, unknown>;
  const live = String(run.finalText || fallbackText || "").trim();
  const lc = subagentLifecycle(details, options.isError);
  const isResume = name === "resume_subagent";
  const summary = subagentSummary(details, lc.lifecycle);
  const qualifiers: OperationalQualifier[] = [...lc.qualifiers];
  if (Array.isArray(details.toolErrors) && details.toolErrors.length > 0 && !qualifiers.includes("warning")) {
    qualifiers.push("warning");
  }
  if (Array.isArray(details.toolWarnings) && details.toolWarnings.length > 0 && !qualifiers.includes("warning")) {
    qualifiers.push("warning");
  }

  const isTerminal = lc.lifecycle === "completed" || lc.lifecycle === "failed" || lc.lifecycle === "aborted";

  // C4 revision: collapsed entries are exactly one row, so state messages
  // that used to live in the collapsed body move into the inline summary. The
  // queued summary keeps the short run ID visible for named agents too,
  // because the queued outcome and the ID are one fact for the caller.
  const queuedRunId = lc.lifecycle === "queued" ? shortId(details.id ?? args.id) : undefined;
  const queuedMessage = !isTerminal && lc.lifecycle === "queued"
    ? ["Queued in the parent session", queuedRunId ? `run ${queuedRunId}` : undefined].filter(Boolean).join(" · ")
    : undefined;
  const effectiveSummary = queuedMessage ?? summary;

  // Rows for the queued state render only when expanded.
  const rows: DisplayRow[] = [];
  if (!isTerminal && lc.lifecycle === "queued") {
    rows.push({ text: "Queued in the parent session", tone: "muted" as DisplayTone });
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
    // Identity row: operation · model · effort
    const agent = record(details.agent);
    const identityParts: string[] = [];
    if (typeof details.operation === "string") identityParts.push(details.operation);
    if (typeof details.model === "string" && details.model) identityParts.push(details.model);
    if (typeof agent.effort === "string" && agent.effort) identityParts.push(agent.effort);
    if (identityParts.length > 0) {
      expandedSections.push({ title: "Identity", blocks: [{ kind: "text", text: identityParts.join(" · "), tone: "muted" as DisplayTone }], compact: true });
    }
    expandedSections.push(...[
      taskSection(details),
      resultSection("Result", live),
      activitySection(run.timeline),
      refusalSection(details),
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
    summary: effectiveSummary,
    ...(options.isError || run.phase === "failed"
      ? { error: String(run.error || fallbackText || "Subagent failed") }
      : {}),
  } satisfies DisplayDescriptionV1;
}

function createSubagentAdapter(name: string): InternalToolDisplayAdapter<any, unknown, unknown> {
  return {
    describeCall(argsValue, context) {
      const args = record(argsValue);
      const task = typeof args.task === "string" ? args.task : undefined;
      const isResume = name === "resume_subagent";
      const id = shortId(args.id);
      const agentName = typeof args.agent === "string" && args.agent ? args.agent : undefined;

      // Target: agent name for delegate_subagent, short run ID for resume_subagent
      let target: string | undefined;
      if (isResume) {
        target = id; // Will be updated when run details are available
      } else {
        target = agentName ?? id;
      }

      // Call rows: task preview + context info
      const rows: DisplayRow[] = [];
      if (task) {
        rows.push({ text: task });
      }
      if (isResume) {
        rows.push({ text: "frozen model and effort", tone: "muted" as DisplayTone });
      } else {
        const contextCount = typeof args.context === "number" ? args.context : undefined;
        const contextStr = contextCount !== undefined
          ? `${contextCount} ${contextCount === 1 ? "context message" : "context messages"}`
          : undefined;
        if (contextStr) {
          rows.push({ text: contextStr, tone: "muted" as DisplayTone });
        }
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
      const isRun = details.version === 4 && Array.isArray(details.timeline);
      if (!isRun) {
        const isResume = name === "resume_subagent";
        const lc = subagentLifecycle(details, context.isError);
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
        { expanded: options.expanded, isError: context.isError },
        text,
        args,
      );
    },
  };
}

// ─── abort_subagent adapter ─────────────────────────────────────────

/** One human sentence for a failed abort request, derived from its structured
 * error code; the full raw text stays in errorRaw for the expanded body. */
function abortFailureSentence(code: string | undefined): string {
  if (code === "ABORTED") {
    return "The abort wait ended before every selected target reached a terminal state; abort signals already sent stay in effect.";
  }
  if (code === "SUBAGENT_NOT_FOUND") {
    return "The abort request was rejected because a selected subagent is unknown or belongs to another parent session.";
  }
  if (code === "INVALID_ARGUMENT") {
    return "The abort request was rejected because the ids selection is invalid.";
  }
  if (code === "PERSISTENCE_FAILED") {
    return "The abort request failed because the parent session has no stable session ID.";
  }
  return "The abort request failed.";
}

function createAbortAdapter(): InternalToolDisplayAdapter<any, unknown, unknown> {
  return {
    describeCall(argsValue, context) {
      const args = record(argsValue);
      const ids = waitSelection(args.ids);

      const rows: DisplayRow[] = [];
      const shortIds = ids.map((id) => shortId(id)).filter(Boolean);
      if (shortIds.length > 0) {
        rows.push({ text: shortIds.join(" "), tone: "muted" as DisplayTone });
      }

      return {
        version: 1,
        tool: "abort_subagent",
        family: "agent",
        lifecycle: context.executionStarted ? "running" : "queued",
        title: "Abort",
        target: waitTarget(ids),
        metadata: [],
        rows,
      };
    },
    describeResult(result, options, context) {
      const details = record(result.details);
      const text = textResult(result);

      // The V1 abort details carry the ordered per-target outcomes; anything
      // else is a rejected or interrupted request rendered as one failure row.
      const entries = Array.isArray(details.results)
        ? details.results.map((entry) => record(entry))
        : [];
      const isAbort = details.version === 1 && entries.length > 0;

      if (!isAbort) {
        // C6 error contract: the header states one human sentence derived from
        // the structured error code; the full raw failure text moves to
        // errorRaw and renders exactly once as an expanded Error section, so a
        // collapsed failure stays one row and never leaks the raw text.
        const errorInfo = record(details.error);
        const code = typeof errorInfo.code === "string" ? errorInfo.code : undefined;
        return {
          version: 1,
          tool: "abort_subagent",
          family: "agent",
          lifecycle: context.isError ? "failed" : "completed",
          title: "Abort",
          target: waitTarget(waitSelection(record(context.args).ids)),
          metadata: [],
          rows: [],
          sections: [],
          summary: undefined,
          ...(context.isError
            ? { error: abortFailureSentence(code), ...(text ? { errorRaw: text } : {}) }
            : {}),
        };
      }

      // A successful abort request is a successful call: aborted is the
      // expected outcome, so the lifecycle stays completed unless the call
      // itself failed (validation, ownership, infrastructure, interruption).
      const lifecycle: OperationalLifecycle = context.isError ? "failed" : "completed";

      // Ordered target evidence, one row per selected run in requested order
      // (at most six): the terminal outcome, the pre-request state, and the
      // bounded task line. Payload evidence appears only in the expanded body.
      const rowsSection: DisplaySection = {
        title: "Targets",
        blocks: entries.map((entry) => {
          const status = String(entry.status);
          const before = String(entry.before ?? "");
          const task = clipTaskPreview(entry.task);
          const tone: DisplayTone = status === "failed" ? "error" : status === "aborted" ? "muted" : "default";
          return {
            kind: "text" as const,
            text: [shortId(entry.id), status, before ? `was ${before}` : undefined, task].filter(Boolean).join(" · "),
            tone,
          };
        }),
      };

      const evidenceSections: DisplaySection[] = [];
      for (const entry of entries) {
        const status = String(entry.status);
        const id = shortId(entry.id);
        const reasonText = typeof entry.reason === "string" ? entry.reason.trim() : "";
        const errorText = typeof entry.error === "string" ? entry.error.trim() : "";
        if (status === "failed" && errorText) {
          evidenceSections.push({
            title: `Error ${id}`,
            blocks: [{ kind: "text", text: errorText, tone: "error" as DisplayTone }],
          });
        } else if (status === "aborted" && reasonText) {
          evidenceSections.push({
            title: `Reason ${id}`,
            blocks: [{ kind: "text", text: reasonText, tone: "muted" as DisplayTone }],
          });
        }
      }

      const ids = Array.isArray(details.ids) ? details.ids.map((id) => String(id)) : [];

      return {
        version: 1,
        tool: "abort_subagent",
        family: "agent",
        lifecycle,
        title: "Abort",
        target: waitTarget(ids),
        metadata: [],
        rows: [],
        sections: options.expanded ? [rowsSection, ...evidenceSections] : [],
        summary: waitSummary(entries.map((entry) => ({ status: String(entry.status) }))),
        durationMs: typeof details.waitedMs === "number" ? details.waitedMs : undefined,
      };
    },
  };
}

// ─── shared multi-ID selection helpers (wait/abort) ─────────────────

/** The requested-ID selection of one multi-ID call, deduplicated in order. */
function waitSelection(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !item) continue;
    const id = item.trim();
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

function waitTarget(ids: string[]): string | undefined {
  if (ids.length === 0) return undefined;
  if (ids.length === 1) return shortId(ids[0]);
  return `${ids.length} runs`;
}

function clipTaskPreview(value: unknown): string {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
}

/** Count summary of one wait's ordered terminal outcomes. */
export function waitSummary(results: { status: string }[]): string | undefined {
  if (results.length === 0) return undefined;
  const counts = new Map<string, number>();
  for (const entry of results) counts.set(entry.status, (counts.get(entry.status) ?? 0) + 1);
  const parts: string[] = [];
  for (const status of ["completed", "failed", "aborted"]) {
    const count = counts.get(status);
    if (count) parts.push(count === 1 ? status : `${count} ${status}`);
  }
  if (parts.length === 0) return undefined;
  return parts.join(" · ");
}

// ─── wait_subagent adapter ──────────────────────────────────────────

/** One bounded human sentence from the structured wait failure. The complete
 * model-facing failure stays separate in `errorRaw` for expanded evidence. */
function waitFailureSentence(errorInfo: Record<string, unknown>): string {
  const message = typeof errorInfo.message === "string"
    ? errorInfo.message.replace(/\s+/g, " ").trim()
    : "";
  if (message) return message;

  const code = typeof errorInfo.code === "string" ? errorInfo.code : undefined;
  if (code === "ABORTED") return "The wait was interrupted before every selected subagent reached a terminal state.";
  if (code === "SESSION_HISTORY_UNAVAILABLE") return "A selected subagent's history became unavailable while waiting.";
  if (code === "SUBAGENT_NOT_FOUND") return "The wait request was rejected because a selected subagent is unknown or belongs to another parent session.";
  if (code === "INVALID_ARGUMENT") return "The wait request was rejected because the ids selection is invalid.";
  if (code === "RESULT_CLAIMED") return "A selected subagent result is already claimed by another wait_subagent call.";
  if (code === "RESULT_SENT") return "A selected subagent result is already scheduled for automatic delivery.";
  if (code === "WAIT_CAPACITY") return "The wait request exceeded the active reservation capacity.";
  if (code === "RESULT_UNAVAILABLE" || code === "RESULT_DELIVERED") return "A selected subagent result is no longer available to wait for.";
  if (code === "PERSISTENCE_FAILED") return "The wait request failed because the parent session has no stable session ID.";
  return "The wait request failed.";
}

function createWaitAdapter(): InternalToolDisplayAdapter<any, unknown, unknown> {
  return {
    describeCall(argsValue, context) {
      const args = record(argsValue);
      const ids = waitSelection(args.ids);

      const rows: DisplayRow[] = [];
      const shortIds = ids.map((id) => shortId(id)).filter(Boolean);
      if (shortIds.length > 0) {
        rows.push({ text: shortIds.join(" "), tone: "muted" as DisplayTone });
      }

      return {
        version: 1,
        tool: "wait_subagent",
        family: "agent",
        lifecycle: context.executionStarted ? "running" : "queued",
        title: "Wait",
        target: waitTarget(ids),
        metadata: [],
        rows,
      };
    },
    describeResult(result, options, context) {
      const details = record(result.details);
      const text = textResult(result);

      // The V1 wait details carry the ordered aggregate; anything else is a
      // rejected request rendered as one failure row.
      const entries = Array.isArray(details.results)
        ? details.results.map((entry) => record(entry))
        : [];
      const isWait = details.version === 1 && entries.length > 0;

      if (!isWait) {
        const errorInfo = record(details.error);
        return {
          version: 1,
          tool: "wait_subagent",
          family: "agent",
          lifecycle: context.isError ? "failed" : "completed",
          title: "Wait",
          target: waitTarget(waitSelection(record(context.args).ids)),
          metadata: [],
          rows: [],
          sections: [],
          summary: undefined,
          ...(context.isError
            ? { error: waitFailureSentence(errorInfo), ...(text ? { errorRaw: text } : {}) }
            : {}),
        };
      }

      const statuses = entries.map((entry) => String(entry.status));
      const lifecycle: OperationalLifecycle = statuses.includes("failed")
        ? "failed"
        : statuses.includes("aborted")
          ? "aborted"
          : "completed";

      // Ordered terminal evidence, one block per selected run in requested
      // order (at most six): the compact outcome row, then the bounded result
      // or error text of each run. The payload appears only in the expanded
      // body — a collapsed wait entry is exactly one row — and each failure's
      // raw text appears exactly once, in its own expanded Error section.
      const rowsSection: DisplaySection = {
        title: "Results",
        blocks: entries.map((entry) => {
          const status = String(entry.status);
          const run = record(entry.run);
          const id = shortId(run.id ?? entry.id);
          const task = clipTaskPreview(run.task);
          const tone: DisplayTone = status === "failed" ? "error" : status === "aborted" ? "muted" : "default";
          return { kind: "text" as const, text: [id, status, task].filter(Boolean).join(" · "), tone };
        }),
      };

      const evidenceSections: DisplaySection[] = [];
      for (const entry of entries) {
        const status = String(entry.status);
        const run = record(entry.run);
        const id = shortId(run.id ?? entry.id);
        const resultText = typeof run.result === "string" ? run.result.trim() : "";
        const errorText = typeof run.error === "string" ? run.error.trim() : "";
        if (status === "completed" && resultText) {
          evidenceSections.push({
            title: `Result ${id}`,
            blocks: [{ kind: "markdown", text: resultText }],
            compact: false,
          });
        } else if (status !== "completed" && errorText) {
          evidenceSections.push({
            title: `Error ${id}`,
            blocks: [{ kind: "text", text: errorText, tone: "error" as DisplayTone }],
          });
        }
      }

      const notCompleted = statuses.filter((status) => status !== "completed").length;
      const ids = Array.isArray(details.ids) ? details.ids.map((id) => String(id)) : [];

      return {
        version: 1,
        tool: "wait_subagent",
        family: "agent",
        lifecycle,
        title: "Wait",
        target: waitTarget(ids),
        metadata: [],
        rows: [],
        sections: options.expanded ? [rowsSection, ...evidenceSections] : [],
        summary: waitSummary(entries.map((entry) => ({ status: String(entry.status) }))),
        durationMs: typeof details.waitedMs === "number" ? details.waitedMs : undefined,
        ...(notCompleted > 0
          ? { error: `${notCompleted} of ${statuses.length} selected runs failed or aborted` }
          : {}),
      };
    },
  };
}

export function decorateSubagentTool<T extends ToolDefinition<any, any, any>>(
  definition: T,
  runtime: DisplayRuntimeProvider,
): T {
  const adapter = definition.name === "wait_subagent"
    ? createWaitAdapter()
    : definition.name === "abort_subagent"
      ? createAbortAdapter()
      : createSubagentAdapter(definition.name);
  return decorateToolDefinition(definition, runtime, adapter) as T;
}

export const __testables = {
  createWaitAdapter,
  createAbortAdapter,
  waitSummary,
};
