import type { InternalToolDisplayAdapter } from "./tool-renderer";
import {
  asArray,
  asRecord,
  baseDescription,
  numberOf,
  stringOf,
  textOf,
  type UnknownRecord,
} from "./adapter-utils";
import { truncateCodePoints } from "./sanitize";
import type {
  DisplayRecordItem,
  DisplaySection,
  DisplayTone,
  OperationalLifecycle,
  OperationalQualifier,
} from "./types";

// ─── todo ──────────────────────────────────────────────────────────

/** Lifecycle glyph for a todo item: ○ pending, ● in progress, ✓ completed. */
function todoGlyph(status: string, isCurrent: boolean): string {
  if (status === "completed") return "✓";
  if (isCurrent || status === "in_progress") return "●";
  return "○";
}

/** Human sentence for a todo error code. */
function todoErrorSentence(details: UnknownRecord, args: UnknownRecord): string {
  const errorObj = asRecord(details.error);
  const code = stringOf(errorObj.code) ?? "";
  const id = stringOf(args.id) ?? stringOf(errorObj.id) ?? "";
  switch (code) {
    case "TODO_UNKNOWN_ID": return `Unknown task id ${id}`;
    case "TODO_DUPLICATE_ID": return `Task id ${id} already exists`;
    case "TODO_EMPTY": return "No task list exists";
    case "TODO_TOO_MANY": return "A list holds at most 20 items";
    case "TODO_PERSIST_ERROR": return "Task list could not be saved";
    default: return stringOf(errorObj.message) ?? "Task operation failed";
  }
}

/** Collapsed summary row for a successful todo operation. */
function todoSummary(details: UnknownRecord, args: UnknownRecord): string {
  const action = stringOf(args.action) ?? stringOf(details.action) ?? "list";
  const changed = details.changed !== false;
  const items = asArray(details.items);
  const counts = asRecord(details.counts);
  const total = numberOf(counts.total) ?? items.length;
  const completed = numberOf(counts.completed) ?? 0;
  const title = stringOf(details.title) ?? "";
  const currentId = stringOf(details.currentId);
  const currentText = currentId
    ? items.map((v) => asRecord(v)).find((item) => stringOf(item.id) === currentId)
    : undefined;
  const currentTextStr = currentText ? (stringOf(currentText.text) ?? "") : "";

  if (!changed && action !== "list") return "No change";
  if (action === "clear" || (total === 0 && items.length === 0 && action !== "list")) return "List cleared";
  if (total === 0) return "No tasks";

  const parts: string[] = [];
  if (title) parts.push(title);
  parts.push(`${completed} of ${total} done`);
  if (currentTextStr) {
    parts.push(`now: ${truncateCodePoints(currentTextStr, 40)}`);
  } else {
    parts.push("paused");
  }
  return parts.join(" · ");
}

/** Expanded TASKS section for a todo result. */
function todoTasksSection(details: UnknownRecord): DisplaySection | undefined {
  const currentId = stringOf(details.currentId);
  const items = asArray(details.items);
  if (items.length === 0) return undefined;
  const records: DisplayRecordItem[] = items.map((value, index) => {
    const item = asRecord(value);
    const status = stringOf(item.status) ?? "pending";
    const isCurrent = currentId !== undefined && stringOf(item.id) === currentId;
    const glyph = todoGlyph(status, isCurrent);
    const customId = stringOf(item.id);
    const hasCustomId = customId !== undefined && customId !== `todo-${index + 1}`;
    const title = `${glyph}  ${index + 1}  ${stringOf(item.text) ?? "(untitled task)"}`;
    return {
      title,
      ...(hasCustomId ? { body: customId, bodyTone: "muted" as DisplayTone } : {}),
    } satisfies DisplayRecordItem;
  });
  return { title: "Tasks", blocks: [{ kind: "records", items: records }], compact: true };
}

// ─── ask ───────────────────────────────────────────────────────────

/** Collapsed outcome row for an ask result. */
function askSummary(details: UnknownRecord): string {
  const phase = stringOf(details.phase) ?? "";
  if (phase === "cancelled") return "Cancelled";
  if (phase === "error") return stringOf(asRecord(details.error).message) ?? "Invalid question set";
  if (phase === "no-terminal") return "An interactive terminal is required";
  const answered = numberOf(details.answeredCount) ?? 0;
  const skipped = numberOf(details.skippedCount) ?? 0;
  if (skipped > 0) return `${answered} answered · ${skipped} skipped`;
  return `${answered} answered`;
}

/** Expanded answer records for an ask result (C9: no section rule when only section). */
function askAnswersSection(details: UnknownRecord): DisplaySection | undefined {
  const answers = asArray(details.answers);
  if (answers.length === 0) return undefined;
  const records: DisplayRecordItem[] = answers.map((value) => {
    const answer = asRecord(value);
    const questionText = stringOf(answer.questionText) ?? stringOf(answer.questionId) ?? "Question";
    const selectedLabels = asArray(answer.selected)
      .map((selected) => stringOf(asRecord(selected).label) ?? String(selected))
      .join(", ");
    const comment = stringOf(answer.comment);
    const isSkipped = answer.skipped === true;
    const bodyParts: string[] = [];
    if (isSkipped) bodyParts.push("skipped");
    else if (selectedLabels) bodyParts.push(selectedLabels);
    if (comment) bodyParts.push(`note: ${comment}`);
    return {
      title: questionText,
      tone: "default" as DisplayTone,
      ...(bodyParts.length > 0 ? { body: bodyParts.join("\n"), bodyTone: (isSkipped ? "muted" : "default") as DisplayTone } : {}),
    } satisfies DisplayRecordItem;
  });
  return { title: "Answers", blocks: [{ kind: "records", items: records }] };
}

// ─── time ──────────────────────────────────────────────────────────

/** Parse the three-line model text into its parts. */
function timeParts(text: string): { local?: string; iso?: string; timezone?: string } {
  const lines = text.split("\n");
  return {
    local: lines[0],
    iso: lines[1]?.replace(/^ISO 8601:\s*/, ""),
    timezone: lines[2]?.replace(/^Timezone:\s*/, ""),
  };
}

// ─── lifecycle helpers ─────────────────────────────────────────────

function todoLifecycle(
  context: { executionStarted: boolean; argsComplete: boolean; isError: boolean },
  phase: "call" | "result",
  isError: boolean,
): OperationalLifecycle {
  if (phase === "result") return isError ? "failed" : "completed";
  if (context.executionStarted) return "running";
  if (context.argsComplete) return "pending";
  return "queued";
}

function askLifecycle(
  context: { executionStarted: boolean; argsComplete: boolean; isPartial?: boolean },
  phase: "call" | "result",
  detailPhase?: string,
): OperationalLifecycle {
  if (phase === "result") {
    if (context.isPartial) return "running";
    if (detailPhase === "error") return "failed";
    if (detailPhase === "cancelled") return "aborted";
    return "completed";
  }
  if (context.executionStarted) return "running";
  if (context.argsComplete) return "pending";
  return "queued";
}

function timeLifecycle(
  context: { executionStarted: boolean; argsComplete: boolean; isError: boolean },
  phase: "call" | "result",
): OperationalLifecycle {
  if (phase === "result") return context.isError ? "failed" : "completed";
  if (context.executionStarted) return "running";
  if (context.argsComplete) return "pending";
  return "queued";
}

// ─── adapter ───────────────────────────────────────────────────────

export function createWorkflowAdapter(
  name: string,
  base: InternalToolDisplayAdapter<any, unknown, unknown>,
): InternalToolDisplayAdapter<any, unknown, unknown> {
  return {
    ...base,
    describeCall(args, context) {
      const description = base.describeCall(args, context);
      const source = asRecord(args);

      if (name === "todo") {
        return baseDescription(description, {
          lifecycle: todoLifecycle(context, "call", false),
          title: "Tasks",
          target: stringOf(source.action) ?? undefined,
          metadata: [],
          sections: [],
        });
      }

      if (name === "ask") {
        const questionCount = Array.isArray(source.questions)
          ? source.questions.length
          : undefined;
        const qualifiers: OperationalQualifier[] = context.executionStarted ? ["needs-input"] : [];
        return baseDescription(description, {
          lifecycle: askLifecycle(context, "call"),
          title: "Questions",
          target: questionCount !== undefined ? `${questionCount} ${questionCount === 1 ? "question" : "questions"}` : undefined,
          metadata: [],
          sections: [],
          ...(qualifiers.length > 0 ? { qualifiers } : {}),
        });
      }

      if (name === "time") {
        return baseDescription(description, {
          lifecycle: timeLifecycle(context, "call"),
          title: "Local time",
          target: undefined,
          metadata: [],
          sections: [],
        });
      }

      return description;
    },

    describeResult(result, options, context) {
      const description = base.describeResult(result, options, context);
      const details = asRecord(result.details);
      const text = textOf(result);
      const isError = Boolean((result as { isError?: boolean }).isError) || details.status === "error" || details.phase === "error";

      // ── todo ──
      if (name === "todo") {
        const action = stringOf(asRecord(context.args).action) ?? stringOf(details.action) ?? "list";
        if (isError) {
          const sentence = todoErrorSentence(details, asRecord(context.args));
          return baseDescription(description, {
            lifecycle: "failed",
            title: "Tasks",
            target: action,
            metadata: [],
            sections: [],
            rows: [],
            summary: sentence,
            error: sentence,
            errorRaw: text,
          });
        }
        const summary = todoSummary(details, asRecord(context.args));
        const tasksSection = options.expanded ? todoTasksSection(details) : undefined;
        const widgetState = stringOf(details.widget);
        const widgetDegradation = widgetState === "unavailable";
        const sections: DisplaySection[] = [];
        if (tasksSection) sections.push(tasksSection);
        if (widgetDegradation) {
          sections.push({ title: "", blocks: [{ kind: "text", text: "Task widget unavailable", tone: "muted" }] });
        }
        return baseDescription(description, {
          lifecycle: todoLifecycle(context, "result", isError),
          title: "Tasks",
          target: action,
          metadata: [],
          sections,
          rows: [],
          summary,
        });
      }

      // ── ask ──
      if (name === "ask") {
        const phase = stringOf(details.phase) ?? "";
        if (isError || phase === "error") {
          const sentence = stringOf(asRecord(details.error).message) ?? "Invalid question set";
          return baseDescription(description, {
            lifecycle: "failed",
            title: "Questions",
            target: undefined,
            metadata: [],
            sections: [],
            rows: [],
            summary: sentence,
            error: sentence,
            errorRaw: text,
          });
        }
        const questionCount = numberOf(details.totalQuestions)
          ?? (Array.isArray(asRecord(context.args).questions) ? asArray(asRecord(context.args).questions).length : undefined);
        const target = questionCount !== undefined
          ? `${questionCount} ${questionCount === 1 ? "question" : "questions"}`
          : undefined;
        const summary = askSummary(details);

        if (phase === "cancelled") {
          return baseDescription(description, {
            lifecycle: "aborted",
            title: "Questions",
            target,
            metadata: [],
            sections: [],
            rows: [],
            summary,
          });
        }

        const answersSection = options.expanded ? askAnswersSection(details) : undefined;
        return baseDescription(description, {
          lifecycle: askLifecycle(context, "result", phase),
          title: "Questions",
          target,
          metadata: [],
          sections: answersSection ? [answersSection] : [],
          rows: [],
          summary,
        });
      }

      // ── time ──
      if (name === "time") {
        const parts = timeParts(text);
        const localTime = parts.local ?? "";
        const tz = parts.timezone ?? "";
        const summary = [localTime, tz].filter(Boolean).join(" · ");
        const isoRow: DisplaySection[] = options.expanded && parts.iso
          ? [{ title: "ISO", blocks: [{ kind: "text", text: parts.iso, tone: "muted" as DisplayTone }], compact: true }]
          : [];
        return baseDescription(description, {
          lifecycle: timeLifecycle(context, "result"),
          title: "Local time",
          target: undefined,
          metadata: [],
          sections: isoRow,
          rows: [],
          summary,
        });
      }

      return description;
    },
  };
}
