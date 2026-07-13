import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { promptQuestions } from "./prompt";
import type { Answer, AskDetails, Question } from "./types";

// ── Schema ───────────────────────────────────────────────────────────────

const OptionSchema = Type.Object({
  value: Type.String({ description: "Machine-readable value returned in the answer" }),
  label: Type.String({ description: "Human-readable label shown to the user" }),
});

const QuestionSchema = Type.Object({
  id: Type.String({ description: "Unique identifier for this question" }),
  text: Type.String({ description: "The question text displayed to the user" }),
  type: Type.Union([Type.Literal("single"), Type.Literal("multi")], {
    description: "single = pick one, multi = pick any number",
  }),
  options: Type.Array(OptionSchema, {
    description: "Available choices",
    minItems: 1,
  }),
  allowComment: Type.Optional(Type.Boolean({
    description: "Whether the user can add free-text alongside their selection (default: false)",
  })),
  commentPlaceholder: Type.Optional(Type.String({
    description: "Placeholder text for the optional comment input",
  })),
  required: Type.Optional(Type.Boolean({
    description: "Whether the user must select at least one option (default: true)",
  })),
});

const AskParams = Type.Object({
  questions: Type.Array(QuestionSchema, {
    description: "One or more questions to present to the user",
    minItems: 1,
  }),
});

// ── Formatting ───────────────────────────────────────────────────────────

function formatAnswersForLLM(answers: Answer[], questions: Question[]): string {
  const lines: string[] = [];

  for (const answer of answers) {
    const q = questions.find((qu) => qu.id === answer.questionId);
    const label = q?.text ?? answer.questionId;

    if (answer.skipped) {
      lines.push(`## ${label}\n*Skipped*`);
      continue;
    }

    const selectedLabels = answer.selected.map((v) => {
      const opt = q?.options.find((o) => o.value === v);
      return opt ? `${opt.label} (${v})` : v;
    });

    lines.push(`## ${label}`);
    if (selectedLabels.length === 1) {
      lines.push(`Selected: ${selectedLabels[0]}`);
    } else {
      lines.push(`Selected:\n${selectedLabels.map((s) => `- ${s}`).join("\n")}`);
    }

    if (answer.comment) {
      lines.push(`Comment: ${answer.comment}`);
    }

    lines.push("");
  }

  return lines.join("\n").trim();
}

// ── Extension ────────────────────────────────────────────────────────────

interface AskUserNotifications {
  question(): void;
}

const NO_NOTIFICATIONS: AskUserNotifications = Object.freeze({ question() {} });

export default function registerAskUser(
  pi: ExtensionAPI,
  notifications: AskUserNotifications = NO_NOTIFICATIONS,
): void {
  pi.registerTool({
    name: "ask",
    label: "Ask",
    description:
      "Present interactive questions to the user with single-select or multi-select options. " +
      "Each question can optionally accept a free-text comment. " +
      "Use this when you need user input to make a decision, clarify requirements, " +
      "or confirm choices before proceeding.",
    promptSnippet:
      "Use ask to present structured questions with selectable options to the user. " +
      "Supports single-select, multi-select, and optional free-text comments per question.",
    promptGuidelines: [
      "Use ask instead of asking open-ended questions in chat when the choices are enumerable.",
      "Keep questions concise. Use 2-6 options per question for best UX.",
      "Set allowComment: true when the user might need to add context beyond the predefined options.",
      "For yes/no questions, prefer ask with clear option labels over plain text questions.",
    ],
    parameters: AskParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const questions: Question[] = params.questions;

      if (!ctx.hasUI) {
        return {
          content: [{ type: "text" as const, text: "Error: ask requires an interactive terminal (not available in RPC/print mode)." }],
          details: {
            phase: "cancelled",
            totalQuestions: questions.length,
            answeredCount: 0,
            answers: [],
          } as AskDetails,
        };
      }

      onUpdate?.({
        content: [{ type: "text" as const, text: "Waiting for user input..." }],
        details: {
          phase: "asking",
          totalQuestions: questions.length,
          answeredCount: 0,
          answers: [],
        } as AskDetails,
      });
      notifications.question();

      const answers = await promptQuestions(ctx.ui, questions, signal);

      const allCancelled = answers.length === 0 || answers.every((a) => a.skipped);
      const formatted = allCancelled
        ? "The user cancelled or skipped all questions."
        : formatAnswersForLLM(answers, questions);

      return {
        content: [{ type: "text" as const, text: formatted }],
        details: {
          phase: allCancelled ? "cancelled" : "done",
          totalQuestions: questions.length,
          answeredCount: answers.filter((a) => !a.skipped).length,
          answers,
        } as AskDetails,
      };
    },
  });
}
