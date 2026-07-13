/** A single option supplied by the tool caller. */
export interface QuestionOption {
  /** Machine-readable value returned in the answer. */
  value: string;
  /** Human-readable label shown in the TUI. */
  label: string;
  /** Optional decision context shown as secondary text. */
  description?: string;
}

/** A question supplied by the tool caller before defaults are applied. */
export interface Question {
  /** Unique id used in response mapping. */
  id: string;
  /** Question text shown to the user. */
  text: string;
  /** Selection type. */
  type: "single" | "multi";
  /** Available choices. */
  options: QuestionOption[];
  /** Whether free-text context can accompany the selection. */
  allowComment?: boolean;
  /** Placeholder shown in the optional comment editor. */
  commentPlaceholder?: string;
  /** Whether the user must provide a selection or comment. */
  required?: boolean;
}

/** A validated question with all behavioral defaults applied. */
export interface NormalizedQuestion extends Omit<Question, "allowComment" | "required"> {
  allowComment: boolean;
  required: boolean;
}

/** Mutable answer state owned by the interactive wizard. */
export interface AnswerDraft {
  selected: string[];
  comment?: string;
  skipped: boolean;
  completed: boolean;
}

export interface SelectedAnswerOption {
  value: string;
  label: string;
}

/** A submitted, self-contained answer returned to the model and renderer. */
export interface SubmittedAnswer {
  questionId: string;
  questionText: string;
  selected: SelectedAnswerOption[];
  comment?: string;
  skipped: boolean;
}

export interface AskSubmittedPayload {
  version: 1;
  status: "submitted";
  answers: SubmittedAnswer[];
}

export interface AskCancelledPayload {
  version: 1;
  status: "cancelled";
  reason: "user" | "aborted";
}

export type AskErrorCode = "ASK_INVALID_INPUT" | "ASK_UI_UNAVAILABLE" | "ASK_UI_FAILED";

export interface AskErrorPayload {
  version: 1;
  status: "error";
  error: {
    code: AskErrorCode;
    message: string;
  };
}

export type AskPayload = AskSubmittedPayload | AskCancelledPayload | AskErrorPayload;

export interface AskProgress {
  phase: "asking" | "reviewing";
  totalQuestions: number;
  currentQuestion?: number;
  answeredCount: number;
  skippedCount: number;
}

export type PromptOutcome =
  | { status: "submitted"; drafts: AnswerDraft[] }
  | { status: "cancelled"; reason: "user" | "aborted" };

/** Structured metadata for native rendering. Draft answer content is never included. */
export interface AskDetails {
  version: 1;
  phase: "asking" | "reviewing" | "done" | "cancelled" | "error";
  totalQuestions: number;
  currentQuestion?: number;
  answeredCount: number;
  skippedCount: number;
  answers?: SubmittedAnswer[];
  reason?: "user" | "aborted";
  error?: AskErrorPayload["error"];
}
