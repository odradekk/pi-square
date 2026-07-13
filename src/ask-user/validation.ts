import type { NormalizedQuestion, Question } from "./types";

export const ASK_LIMITS = Object.freeze({
  questions: 10,
  options: 20,
  identifier: 128,
  questionText: 2_000,
  optionLabel: 500,
  optionDescription: 1_000,
  commentPlaceholder: 200,
  comment: 4_000,
});

const MACHINE_CONTROLS = /[\u0000-\u001f\u007f-\u009f]/u;
const DISPLAY_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;

export class AskValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AskValidationError";
  }
}

export function countCharacters(value: string): number {
  return Array.from(value).length;
}

function validateString(
  value: string,
  field: string,
  maximum: number,
  controls: RegExp = DISPLAY_CONTROLS,
): void {
  const length = countCharacters(value);
  if (value.trim().length === 0) throw new AskValidationError(`${field} must not be blank`);
  if (length > maximum) throw new AskValidationError(`${field} must be at most ${maximum} characters`);
  if (controls.test(value)) throw new AskValidationError(`${field} contains unsupported control characters`);
}

export function normalizeQuestions(input: Question[]): NormalizedQuestion[] {
  if (input.length < 1 || input.length > ASK_LIMITS.questions) {
    throw new AskValidationError(`questions must contain between 1 and ${ASK_LIMITS.questions} items`);
  }

  const questionIds = new Set<string>();
  return input.map((question, questionIndex) => {
    const prefix = `questions[${questionIndex}]`;
    validateString(question.id, `${prefix}.id`, ASK_LIMITS.identifier, MACHINE_CONTROLS);
    validateString(question.text, `${prefix}.text`, ASK_LIMITS.questionText);
    if (questionIds.has(question.id)) throw new AskValidationError(`question id ${JSON.stringify(question.id)} is duplicated`);
    questionIds.add(question.id);

    if (question.options.length < 1 || question.options.length > ASK_LIMITS.options) {
      throw new AskValidationError(`${prefix}.options must contain between 1 and ${ASK_LIMITS.options} items`);
    }

    const optionValues = new Set<string>();
    const options = question.options.map((option, optionIndex) => {
      const optionPrefix = `${prefix}.options[${optionIndex}]`;
      validateString(option.value, `${optionPrefix}.value`, ASK_LIMITS.identifier, MACHINE_CONTROLS);
      validateString(option.label, `${optionPrefix}.label`, ASK_LIMITS.optionLabel);
      if (option.description !== undefined) {
        validateString(option.description, `${optionPrefix}.description`, ASK_LIMITS.optionDescription);
      }
      if (optionValues.has(option.value)) {
        throw new AskValidationError(`option value ${JSON.stringify(option.value)} is duplicated in question ${JSON.stringify(question.id)}`);
      }
      optionValues.add(option.value);
      return { ...option };
    });

    if (question.commentPlaceholder !== undefined) {
      validateString(
        question.commentPlaceholder,
        `${prefix}.commentPlaceholder`,
        ASK_LIMITS.commentPlaceholder,
        MACHINE_CONTROLS,
      );
      if (question.allowComment !== true) {
        throw new AskValidationError(`${prefix}.commentPlaceholder requires allowComment: true`);
      }
    }

    return {
      ...question,
      options,
      allowComment: question.allowComment ?? false,
      required: question.required ?? true,
    };
  });
}

export function validateComment(value: string): string | undefined {
  if (countCharacters(value) > ASK_LIMITS.comment) {
    return `Comment must be at most ${ASK_LIMITS.comment} characters`;
  }
  if (DISPLAY_CONTROLS.test(value)) return "Comment contains unsupported control characters";
  return undefined;
}
