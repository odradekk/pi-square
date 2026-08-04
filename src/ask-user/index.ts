import { stripVTControlCharacters } from "node:util";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { promptQuestions } from "./prompt";
import { decorateInternalTool } from "../display/internal-adapters";
import type { DisplayRuntimeProvider } from "../display/tool-renderer";
import { renderAskCall, renderAskResult } from "./render";
import type {
  AnswerDraft,
  AskCancelledPayload,
  AskDetails,
  AskErrorCode,
  AskErrorPayload,
  AskProgress,
  AskSubmittedPayload,
  NormalizedQuestion,
  Question,
  SubmittedAnswer,
} from "./types";
import { ASK_LIMITS, AskValidationError, normalizeQuestions } from "./validation";

const OptionSchema = Type.Object({
  value: Type.String({
    description: "Machine-readable value returned in the answer",
    minLength: 1,
    maxLength: ASK_LIMITS.identifier,
  }),
  label: Type.String({
    description: "Human-readable label shown to the user",
    minLength: 1,
    maxLength: ASK_LIMITS.optionLabel,
  }),
  description: Type.Optional(Type.String({
    description: "Optional decision context shown as secondary text",
    minLength: 1,
    maxLength: ASK_LIMITS.optionDescription,
  })),
}, { additionalProperties: false });

const QuestionSchema = Type.Object({
  id: Type.String({
    description: "Unique identifier for this question",
    minLength: 1,
    maxLength: ASK_LIMITS.identifier,
  }),
  text: Type.String({
    description: "The question text displayed to the user",
    minLength: 1,
    maxLength: ASK_LIMITS.questionText,
  }),
  type: Type.Union([Type.Literal("single"), Type.Literal("multi")], {
    description: "single = pick one, multi = pick any number",
  }),
  options: Type.Array(OptionSchema, {
    description: "Available choices",
    minItems: 1,
    maxItems: ASK_LIMITS.options,
  }),
  allowComment: Type.Optional(Type.Boolean({
    description: "Whether the user can add free-text alongside their selection (default: false)",
    default: false,
  })),
  commentPlaceholder: Type.Optional(Type.String({
    description: "Placeholder text for the optional comment editor",
    minLength: 1,
    maxLength: ASK_LIMITS.commentPlaceholder,
  })),
  required: Type.Optional(Type.Boolean({
    description: "Whether the user must provide a selection or comment (default: true)",
    default: true,
  })),
}, { additionalProperties: false });

const AskParamsSchema = Type.Object({
  questions: Type.Array(QuestionSchema, {
    description: "One to ten questions presented in a persistent reviewable wizard",
    minItems: 1,
    maxItems: ASK_LIMITS.questions,
  }),
}, { additionalProperties: false });

interface AskUserNotifications {
  question(): void;
}

interface AskToolDependencies {
  prompt?: typeof promptQuestions;
}

const NO_NOTIFICATIONS: AskUserNotifications = Object.freeze({ question() {} });

function serialize(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function safeReason(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return stripVTControlCharacters(raw)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
    .slice(0, 1_000) || "Unknown ask UI failure";
}

function buildSubmittedAnswers(questions: NormalizedQuestion[], drafts: AnswerDraft[]): SubmittedAnswer[] {
  return questions.map((question, index) => {
    const draft = drafts[index] ?? { selected: [], skipped: true, completed: true };
    const selectedValues = new Set(draft.selected);
    return {
      questionId: question.id,
      questionText: question.text,
      selected: question.options
        .filter((option) => selectedValues.has(option.value))
        .map((option) => ({ value: option.value, label: option.label })),
      ...(draft.comment !== undefined ? { comment: draft.comment } : {}),
      skipped: draft.skipped,
    };
  });
}

function progressDetails(progress: AskProgress): AskDetails {
  return {
    version: 1,
    phase: progress.phase,
    totalQuestions: progress.totalQuestions,
    ...(progress.currentQuestion !== undefined ? { currentQuestion: progress.currentQuestion } : {}),
    answeredCount: progress.answeredCount,
    skippedCount: progress.skippedCount,
  };
}

function errorResult(code: AskErrorCode, message: string, totalQuestions: number) {
  const payload: AskErrorPayload = { version: 1, status: "error", error: { code, message } };
  const details: AskDetails = {
    version: 1,
    phase: "error",
    totalQuestions,
    answeredCount: 0,
    skippedCount: 0,
    error: payload.error,
  };
  return {
    content: [{ type: "text" as const, text: serialize(payload) }],
    isError: true,
    details,
  };
}

function cancelledResult(reason: "user" | "aborted", totalQuestions: number) {
  const payload: AskCancelledPayload = { version: 1, status: "cancelled", reason };
  const details: AskDetails = {
    version: 1,
    phase: "cancelled",
    totalQuestions,
    answeredCount: 0,
    skippedCount: 0,
    reason,
  };
  return {
    content: [{ type: "text" as const, text: serialize(payload) }],
    ...(reason === "aborted" ? { isError: true } : {}),
    details,
  };
}

export function createAskToolDefinition(
  notifications: AskUserNotifications = NO_NOTIFICATIONS,
  dependencies: AskToolDependencies = {},
): ToolDefinition<typeof AskParamsSchema, AskDetails> {
  const prompt = dependencies.prompt ?? promptQuestions;

  return {
    name: "ask",
    label: "Ask",
    description:
      "Present one to ten interactive single-select or multi-select questions in a reviewable terminal wizard. "
      + "Questions may accept an optional multiline comment. Submitted answers are returned as versioned JSON.",
    promptSnippet:
      "Use ask for decisions with enumerable choices. It supports single-select, multi-select, optional multiline comments, back navigation, and review before submitting multiple questions.",
    promptGuidelines: [
      "Use ask instead of an open-ended chat question when the choices are enumerable.",
      "Keep questions concise and prefer 2-6 options. Optional option descriptions should explain material trade-offs.",
      "allowComment defaults to false and required defaults to true; set either explicitly when different behavior is intended.",
      "Question ids must be unique, and option values must be unique within each question.",
      "For yes/no decisions, provide concrete labels that describe the consequences rather than generic Yes and No labels.",
    ],
    parameters: AskParamsSchema,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const rawQuestions = Array.isArray(params?.questions) ? params.questions as Question[] : [];
      let questions: NormalizedQuestion[];
      try {
        questions = normalizeQuestions(rawQuestions);
      } catch (error) {
        const message = error instanceof AskValidationError ? error.message : safeReason(error);
        return errorResult("ASK_INVALID_INPUT", message, rawQuestions.length);
      }

      if (!ctx.hasUI) {
        return errorResult(
          "ASK_UI_UNAVAILABLE",
          "ask requires an interactive terminal and is unavailable in RPC or print mode",
          questions.length,
        );
      }
      if (signal?.aborted) return cancelledResult("aborted", questions.length);

      let lastProgress = "";
      const emitProgress = (progress: AskProgress) => {
        const key = JSON.stringify(progress);
        if (key === lastProgress) return;
        lastProgress = key;
        onUpdate?.({
          content: [{
            type: "text" as const,
            text: serialize({
              version: 1,
              status: progress.phase,
              totalQuestions: progress.totalQuestions,
              ...(progress.currentQuestion !== undefined ? { currentQuestion: progress.currentQuestion } : {}),
              answeredCount: progress.answeredCount,
              skippedCount: progress.skippedCount,
            }),
          }],
          details: progressDetails(progress),
        });
      };

      emitProgress({
        phase: "asking",
        totalQuestions: questions.length,
        currentQuestion: 1,
        answeredCount: 0,
        skippedCount: 0,
      });
      notifications.question();

      try {
        const outcome = await prompt(ctx.ui, questions, signal, emitProgress);
        if (outcome.status === "cancelled") return cancelledResult(outcome.reason, questions.length);

        const answers = buildSubmittedAnswers(questions, outcome.drafts);
        const payload: AskSubmittedPayload = { version: 1, status: "submitted", answers };
        const answeredCount = answers.filter((answer) => !answer.skipped).length;
        const skippedCount = answers.filter((answer) => answer.skipped).length;
        return {
          content: [{ type: "text" as const, text: serialize(payload) }],
          details: {
            version: 1,
            phase: "done",
            totalQuestions: questions.length,
            answeredCount,
            skippedCount,
            answers,
          } satisfies AskDetails,
        };
      } catch (error) {
        return errorResult("ASK_UI_FAILED", safeReason(error), questions.length);
      }
    },

    renderCall(args: any, theme: any, context: any) {
      return renderAskCall(args, theme, context);
    },
    renderResult(result: any, options: { expanded: boolean; isPartial: boolean }, theme: any, context: any) {
      return renderAskResult(result, options, theme, context);
    },
  };
}

export default function registerAskUser(
  pi: ExtensionAPI,
  notifications: AskUserNotifications = NO_NOTIFICATIONS,
  runtime?: DisplayRuntimeProvider,
): void {
  const definition = createAskToolDefinition(notifications);
  pi.registerTool(runtime ? decorateInternalTool(definition, runtime) : definition);
}
