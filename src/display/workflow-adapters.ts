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
import type { DisplayMetadataEntry, DisplayRecordItem, DisplaySection } from "./types";

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function todoItems(details: UnknownRecord): DisplayRecordItem[] {
  return asArray(details.items).map((value) => {
    const item = asRecord(value);
    return {
      title: stringOf(item.text) ?? "(untitled task)",
      tone: item.status === "completed" ? "success" : item.status === "in_progress" ? "accent" : "muted",
      fields: metadata([
        field("id", item.id),
        field("status", item.status),
        field("changed", item.changed),
      ]),
    } satisfies DisplayRecordItem;
  });
}

function askAnswers(details: UnknownRecord): DisplayRecordItem[] {
  return asArray(details.answers).map((value) => {
    const answer = asRecord(value);
    return {
      title: stringOf(answer.questionText) ?? stringOf(answer.questionId) ?? "Question",
      fields: metadata([
        field("selected", asArray(answer.selected).map((selected) => stringOf(asRecord(selected).label) ?? String(selected)).join(", ")),
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
    const counts = asRecord(details.counts);
    return [
      field("action", args.action ?? details.action),
      field("changed", details.changed),
      field("total", counts.total),
      field("pending", counts.pending),
      field("inProgress", counts.inProgress),
      field("completed", counts.completed),
      field("current", details.currentId),
      field("stateVersion", details.stateVersion),
    ];
  }
  if (name === "ask") {
    return [
      field("phase", details.phase),
      field("questions", details.totalQuestions),
      field("answered", details.answeredCount),
      field("skipped", details.skippedCount),
      field("current", details.currentQuestion),
      field("reason", details.reason),
    ];
  }
  return [];
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
        metadata: [...(description.metadata ?? []), ...metadata(actionFields(name, source, source))].slice(0, 16),
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
          summarySection(name === "todo" ? "Action" : "Request", actionFields(name, asRecord(context.args), details)),
          name === "todo" ? recordsSection("Tasks", todoItems(details)) : undefined,
          name === "ask" ? recordsSection("Answers", askAnswers(details)) : undefined,
          options.expanded && name === "ask" && askAnswers(details).length === 0 && payload.answers
            ? codeSection("Result", text, "json", false)
            : undefined,
        );
      const hasDomain = structured.some((section) => section.title === "Tasks" || section.title === "Answers" || section.title === "Result" || section.title === "Local");
      const output = options.expanded && !hasDomain ? codeSection("Result", text, "json", false) : undefined;
      return baseDescription(description, {
        metadata: [...(description.metadata ?? []), ...metadata(actionFields(name, asRecord(context.args), details))].slice(0, 16),
        sections: [...structured, ...sections(output)],
        ...(options.expanded ? { preview: undefined } : {}),
      });
    },
  };
}
