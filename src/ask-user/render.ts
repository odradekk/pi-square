import { stripVTControlCharacters } from "node:util";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { Container, Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import type { AskDetails, SubmittedAnswer } from "./types";

class AskResultComponent extends Container {}

function sanitizeDisplay(value: unknown): string {
  return stripVTControlCharacters(String(value ?? ""))
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "   ")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
}

function inlineDisplay(value: unknown): string {
  return sanitizeDisplay(value).replace(/\s+/g, " ").trim();
}

function firstText(result: any): string {
  if (!Array.isArray(result?.content)) return "";
  return result.content
    .filter((item: any) => item?.type === "text" && typeof item.text === "string")
    .map((item: any) => item.text)
    .join("\n");
}

function nonNegativeInteger(value: unknown): number | undefined {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
}

function validAnswer(value: unknown): value is SubmittedAnswer {
  if (!value || typeof value !== "object") return false;
  const answer = value as Partial<SubmittedAnswer>;
  if (typeof answer.questionId !== "string" || typeof answer.questionText !== "string") return false;
  if (typeof answer.skipped !== "boolean" || !Array.isArray(answer.selected)) return false;
  if (answer.comment !== undefined && typeof answer.comment !== "string") return false;
  return answer.selected.every((selected) => Boolean(
    selected
    && typeof selected === "object"
    && typeof selected.value === "string"
    && typeof selected.label === "string",
  ));
}

function validDetails(value: unknown): AskDetails | undefined {
  if (!value || typeof value !== "object") return undefined;
  const details = value as Partial<AskDetails>;
  if (details.version !== 1) return undefined;
  if (!["asking", "reviewing", "done", "cancelled", "error"].includes(String(details.phase))) return undefined;
  const totalQuestions = nonNegativeInteger(details.totalQuestions);
  if (totalQuestions === undefined) return undefined;
  if (nonNegativeInteger(details.answeredCount) === undefined) return undefined;
  if (nonNegativeInteger(details.skippedCount) === undefined) return undefined;
  if (details.currentQuestion !== undefined) {
    const currentQuestion = nonNegativeInteger(details.currentQuestion);
    if (currentQuestion === undefined || currentQuestion < 1 || currentQuestion > totalQuestions) return undefined;
  }
  if (details.answers !== undefined && (!Array.isArray(details.answers) || !details.answers.every(validAnswer))) return undefined;
  if (details.phase === "done" && (!Array.isArray(details.answers) || details.answers.length !== totalQuestions)) return undefined;
  if (details.phase === "cancelled" && details.reason !== "user" && details.reason !== "aborted") return undefined;
  if (details.phase === "error" && (
    !details.error
    || typeof details.error.code !== "string"
    || typeof details.error.message !== "string"
  )) return undefined;
  return details as AskDetails;
}

function buildCallText(args: any, theme: any, expanded: boolean): string {
  const questions = Array.isArray(args?.questions) ? args.questions : [];
  const count = questions.length;
  let output = theme.fg("toolTitle", theme.bold("ASK"));
  output += theme.fg("muted", `  ${count} question${count === 1 ? "" : "s"}`);
  if (!expanded || count === 0) return output;

  questions.forEach((question: any, questionIndex: number) => {
    const type = question?.type === "multi" ? "multi" : "single";
    const required = question?.required === false ? "optional" : "required";
    const number = String(questionIndex + 1).padStart(2, "0");
    output += `\n\n${theme.fg("dim", number)}  ${theme.fg("text", theme.bold(sanitizeDisplay(question?.text)))}`;
    output += theme.fg("muted", `  [${type} · ${required}]`);
    if (Array.isArray(question?.options)) {
      question.options.forEach((option: any) => {
        output += `\n  ${theme.fg("muted", "○")} ${sanitizeDisplay(option?.label)}`;
        output += theme.fg("dim", ` (${inlineDisplay(option?.value)})`);
        if (typeof option?.description === "string") {
          output += `\n    ${theme.fg("dim", sanitizeDisplay(option.description))}`;
        }
      });
    }
    if (question?.allowComment === true) {
      const placeholder = typeof question?.commentPlaceholder === "string"
        ? ` · ${inlineDisplay(question.commentPlaceholder)}`
        : "";
      output += `\n  ${theme.fg("muted", `Comment enabled${placeholder}`)}`;
    }
  });
  return output;
}

export function renderAskCall(args: any, theme: any, context: any): Component {
  const component = context?.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
  component.setText(buildCallText(args, theme, Boolean(context?.expanded)));
  return component;
}

function summary(details: AskDetails, theme: any): string {
  switch (details.phase) {
    case "asking": {
      const position = details.currentQuestion ? ` · Question ${details.currentQuestion}/${details.totalQuestions}` : "";
      return theme.fg("muted", `… Waiting for answers${position} · ${details.answeredCount} answered · ${details.skippedCount} skipped`);
    }
    case "reviewing":
      return theme.fg("muted", `… Reviewing ${details.totalQuestions} questions · ${details.answeredCount} answered · ${details.skippedCount} skipped`);
    case "done":
      return theme.fg("success", `✓ Answered ${details.answeredCount}/${details.totalQuestions}`)
        + (details.skippedCount > 0 ? theme.fg("muted", ` · ${details.skippedCount} skipped`) : "");
    case "cancelled":
      return theme.fg(details.reason === "aborted" ? "error" : "warning", details.reason === "aborted" ? "! Ask aborted" : "– Ask cancelled");
    case "error":
      return theme.fg("error", `! ${details.error?.code ?? "ASK_ERROR"}: ${sanitizeDisplay(details.error?.message ?? "Ask failed")}`);
  }
}

function renderAnswer(answer: SubmittedAnswer, index: number, theme: any): string {
  let output = `${theme.fg("dim", String(index + 1).padStart(2, "0"))}  ${theme.fg("text", theme.bold(sanitizeDisplay(answer.questionText)))}`;
  output += theme.fg("dim", ` (${inlineDisplay(answer.questionId)})`);
  if (answer.skipped) return `${output}\n  ${theme.fg("muted", "Skipped")}`;

  if (answer.selected.length > 0) {
    for (const selected of answer.selected) {
      output += `\n  ${theme.fg("success", "●")} ${sanitizeDisplay(selected.label)}`;
      output += theme.fg("dim", ` (${inlineDisplay(selected.value)})`);
    }
  }
  if (answer.comment !== undefined) {
    output += `\n  ${theme.fg("muted", "Comment")}`;
    for (const line of sanitizeDisplay(answer.comment).split("\n")) {
      output += `\n    ${theme.fg("toolOutput", line || " ")}`;
    }
  }
  return output;
}

function addWidthSafeHint(component: AskResultComponent, theme: any, label: string): void {
  component.addChild({
    render(width: number): string[] {
      const hint = theme.fg("muted", "(") + keyHint("app.tools.expand", label) + theme.fg("muted", ")");
      return [truncateToWidth(hint, Math.max(1, width), "...")];
    },
    invalidate(): void {},
  });
}

export function renderAskResult(
  result: any,
  options: { expanded: boolean; isPartial: boolean },
  theme: any,
  context: any,
): Component {
  const component = context?.lastComponent instanceof AskResultComponent
    ? context.lastComponent
    : new AskResultComponent();
  component.clear();
  const details = validDetails(result?.details);

  if (!details) {
    const fallback = sanitizeDisplay(firstText(result));
    if (options.expanded && fallback) {
      component.addChild(new Text(`\n${theme.fg("toolOutput", fallback)}`, 0, 0));
    } else {
      component.addChild({
        render(width: number): string[] {
          const label = options.isPartial
            ? "Waiting for answers"
            : context?.isError && fallback
              ? inlineDisplay(fallback)
              : "Ask result";
          return ["", truncateToWidth(theme.fg(context?.isError ? "error" : "muted", label), Math.max(1, width), "...")];
        },
        invalidate(): void {},
      });
      if (fallback && !options.isPartial) addWidthSafeHint(component, theme, "to expand");
    }
    component.invalidate();
    return component;
  }

  component.addChild(new Text(`\n${summary(details, theme)}`, 0, 0));
  const answers = details.phase === "done" && Array.isArray(details.answers) ? details.answers : [];
  if (answers.length > 0) {
    if (options.expanded) {
      const body = answers.map((answer, index) => renderAnswer(answer, index, theme)).join("\n\n");
      component.addChild(new Text(`\n\n${body}`, 0, 0));
      addWidthSafeHint(component, theme, "to collapse");
    } else {
      addWidthSafeHint(component, theme, "to expand");
    }
  }
  component.invalidate();
  return component;
}
