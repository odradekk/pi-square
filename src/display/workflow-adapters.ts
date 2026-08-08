import type { InternalToolDisplayAdapter } from "./tool-renderer";
import {
  asArray,
  asRecord,
  baseDescription,
  codeSection,
  field,
  metadata,
  recordsSection,
  sections,
  stringOf,
  summarySection,
  textOf,
  textSection,
  type UnknownRecord,
} from "./adapter-utils";
import type { DisplayMetadataEntry, DisplayRecordItem, DisplaySection, OperationalLifecycle } from "./types";

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function todoItems(details: UnknownRecord): DisplayRecordItem[] {
  const currentId = stringOf(details.currentId);
  return asArray(details.items).map((value, index) => {
    const item = asRecord(value);
    const status = stringOf(item.status) ?? "pending";
    const isCurrent = currentId !== undefined && stringOf(item.id) === currentId;
    const marker = status === "completed" ? "✓" : isCurrent ? "◆" : "○";
    return {
      title: `${marker} ${index + 1}. ${stringOf(item.text) ?? "(untitled task)"}`,
      tone: status === "completed" ? "success" : status === "in_progress" ? "accent" : "muted",
      fields: metadata([
        field("id", item.id),
        field("status", status),
        isCurrent ? field("current", "yes", "accent") : undefined,
      ]),
    } satisfies DisplayRecordItem;
  });
}

function askAnswers(details: UnknownRecord): DisplayRecordItem[] {
  return asArray(details.answers).map((value) => {
    const answer = asRecord(value);
    const selectedLabels = asArray(answer.selected).map((selected) => stringOf(asRecord(selected).label) ?? String(selected)).join(", ");
    const isCommentOnly = selectedLabels === "" && answer.skipped !== true;
    return {
      title: stringOf(answer.questionText) ?? stringOf(answer.questionId) ?? "Question",
      fields: metadata([
        field("selected", selectedLabels),
        isCommentOnly ? field("comment-only", "yes", "muted") : undefined,
        answer.skipped === true ? field("skipped", "yes", "warning") : undefined,
      ]),
      body: stringOf(answer.comment),
    } satisfies DisplayRecordItem;
  });
}

function timeSections(text: string): DisplaySection[] {
  const [local, iso, timezone] = text.split("\n");
  return sections(
    summarySection("Local", [
      field("time", local),
      field("iso", iso?.replace(/^ISO 8601:\s*/, "")),
      field("timezone", timezone?.replace(/^Timezone:\s*/, "")),
    ]),
  );
}

function actionFields(name: string, args: UnknownRecord, details: UnknownRecord): Array<DisplayMetadataEntry | undefined> {
  if (name === "todo") {
    return [
      field("action", args.action ?? details.action),
      field("changed", details.changed),
      // Target IDs and advance policy belong in ACTION per the workflow spec
      args.id !== undefined ? field("id", args.id) : undefined,
      Array.isArray(args.ids) && args.ids.length > 0 ? field("ids", (args.ids as unknown[]).join(", ")) : undefined,
      args.advance !== undefined ? field("advance", args.advance) : undefined,
    ];
  }
  if (name === "ask") {
    // During the call phase, details IS args (no result yet), so derive
    // the question count from the args array. During result, totalQuestions
    // is the canonical count.
    const questionCount = details.totalQuestions ?? (Array.isArray(args.questions) ? (args.questions as unknown[]).length : undefined);
    return [
      field("phase", details.phase),
      field("questions", questionCount),
      field("answered", details.answeredCount),
      field("skipped", details.skippedCount),
      field("current", details.currentQuestion),
      field("reason", details.reason),
    ];
  }
  return [];
}

function todoSummaryFields(details: UnknownRecord): Array<DisplayMetadataEntry | undefined> {
  const counts = asRecord(details.counts);
  return [
    field("total", counts.total),
    field("pending", counts.pending),
    field("inProgress", counts.inProgress),
    field("completed", counts.completed),
    field("current", details.currentId),
    details.title ? field("title", details.title) : undefined,
  ];
}

function todoPersistenceFields(details: UnknownRecord): Array<DisplayMetadataEntry | undefined> {
  return [
    field("stateVersion", details.stateVersion),
    field("widget", details.widget),
    details.error !== undefined ? field("error", asRecord(details.error).code, "error") : undefined,
  ];
}

/**
 * Derive an explicit lifecycle for the Time tool so it renders through the
 * new operational path rather than the compatibility bridge.
 */
function timeLifecycle(
  context: { executionStarted: boolean; argsComplete: boolean; isError: boolean },
  phase: "call" | "result",
): OperationalLifecycle {
  if (phase === "result") return context.isError ? "failed" : "completed";
  if (context.executionStarted) return "running";
  if (context.argsComplete) return "pending";
  return "queued";
}

function dedupeMetadata(base: readonly DisplayMetadataEntry[], fresh: readonly DisplayMetadataEntry[]): DisplayMetadataEntry[] {
  const freshLabels = new Set(fresh.map((e) => e.label));
  return [...base.filter((e) => !freshLabels.has(e.label)), ...fresh].slice(0, 16);
}

function todoLifecycle(context: { executionStarted: boolean; argsComplete: boolean; isError: boolean }, phase: "call" | "result"): OperationalLifecycle {
  if (phase === "result") return context.isError ? "failed" : "completed";
  if (context.executionStarted) return "running";
  if (context.argsComplete) return "pending";
  return "queued";
}

/**
 * Derive an explicit lifecycle for the Ask tool. The wizard uses
 * interactive input, so the call shows a needs-input qualifier while
 * running. Results map phase "cancelled" to aborted even when the tool
 * sets isError (tool-aborted), and phase "error" to failed.
 */
function askLifecycle(
  context: { executionStarted: boolean; argsComplete: boolean; isPartial?: boolean },
  phase: "call" | "result",
  detailPhase?: string,
): OperationalLifecycle {
  if (phase === "result") {
    // Progress updates (wizard still open) show running
    if (context.isPartial) return "running";
    if (detailPhase === "error") return "failed";
    if (detailPhase === "cancelled") return "aborted";
    return "completed";
  }
  if (context.executionStarted) return "running";
  if (context.argsComplete) return "pending";
  return "queued";
}

export function createWorkflowAdapter(
  name: string,
  base: InternalToolDisplayAdapter<any, unknown, unknown>,
): InternalToolDisplayAdapter<any, unknown, unknown> {
  return {
    ...base,
    describeCall(args, context) {
      const description = base.describeCall(args, context);
      const source = asRecord(args);
      return baseDescription(description, {
        ...(name === "time" ? { lifecycle: timeLifecycle(context, "call") } : {}),
        ...(name === "todo" ? { lifecycle: todoLifecycle(context, "call") } : {}),
        ...(name === "ask" ? { lifecycle: askLifecycle(context, "call"), ...(context.executionStarted ? { qualifiers: ["needs-input"] } : {}) } : {}),
        metadata: dedupeMetadata(description.metadata ?? [], metadata(actionFields(name, source, source))),
        sections: sections(summarySection(name === "todo" ? "Action" : name === "ask" ? "Request" : "Local", actionFields(name, source, source))),
      });
    },
    describeResult(result, options, context) {
      const description = base.describeResult(result, options, context);
      const details = asRecord(result.details);
      const text = textOf(result);
      const payload = asRecord(safeJson(text));
      const error = stringOf(details.error)
        ?? stringOf(asRecord(details.error).message)
        ?? stringOf(payload.error)
        ?? ((result as { isError?: boolean }).isError ? text : undefined);
      const structured = name === "time"
        ? sections(
          textSection("Error", error, "error"),
          ...timeSections(text),
        )
        : sections(
          textSection("Error", error, "error"),
          summarySection(name === "todo" ? "Action" : "Request", actionFields(name, asRecord(context.args), details), name === "todo" || name === "ask"),
          name === "todo" ? summarySection("Summary", todoSummaryFields(details), true) : undefined,
          name === "todo" ? recordsSection("Tasks", todoItems(details)) : undefined,
          name === "todo" ? summarySection("Persistence", todoPersistenceFields(details), true) : undefined,
          name === "ask" ? recordsSection("Answers", askAnswers(details)) : undefined,
          options.expanded && name === "ask" && askAnswers(details).length === 0 && payload.answers
            ? codeSection("Result", text, "json", false)
            : undefined,
        );
      const hasDomain = structured.some((section) => section.title === "Tasks" || section.title === "Answers" || section.title === "Result" || section.title === "Local" || section.title === "Summary" || section.title === "Request");
      const output = options.expanded && !hasDomain ? codeSection("Result", text, "json", false) : undefined;
      return baseDescription(description, {
        ...(name === "time" ? { lifecycle: timeLifecycle(context, "result") } : {}),
        ...(name === "todo" ? { lifecycle: todoLifecycle({ executionStarted: true, argsComplete: true, isError: Boolean((result as { isError?: boolean }).isError) || details.status === "error" }, "result") } : {}),
        ...(name === "ask" ? { lifecycle: askLifecycle(context, "result", stringOf(details.phase)) } : {}),
        metadata: dedupeMetadata(description.metadata ?? [], metadata(actionFields(name, asRecord(context.args), details))),
        sections: [...structured, ...sections(output)],
        ...(options.expanded ? { preview: undefined } : {}),
      });
    },
  };
}
