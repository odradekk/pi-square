/** A single option in a question. */
export interface QuestionOption {
  /** Machine-readable value returned to the LLM. */
  value: string;
  /** Human-readable label shown in TUI. */
  label: string;
}

/** A question the LLM wants to ask the user. */
export interface Question {
  /** Unique id for this question (used in response mapping). */
  id: string;
  /** The question text shown to the user. */
  text: string;
  /** Selection type. */
  type: "single" | "multi";
  /** Available options. */
  options: QuestionOption[];
  /** Whether the user can add free-text alongside their selection (default: false). */
  allowComment?: boolean;
  /** Placeholder for the optional comment input. */
  commentPlaceholder?: string;
  /** If true, the user must select at least one option (default: true). */
  required?: boolean;
}

/** The user's answer to one question. */
export interface Answer {
  /** Matches `Question.id`. */
  questionId: string;
  /** Selected value(s). Single-select returns one-element array. */
  selected: string[];
  /** Optional free-text comment. */
  comment?: string;
  /** True if the user skipped / cancelled this question. */
  skipped: boolean;
}

/** Tool execution details for rendering. */
export interface AskDetails {
  /** Current phase. */
  phase: "asking" | "done" | "cancelled";
  /** Total number of questions. */
  totalQuestions: number;
  /** Number of questions answered so far. */
  answeredCount: number;
  /** The answers collected so far. */
  answers: Answer[];
}
