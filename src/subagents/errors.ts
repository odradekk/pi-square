import type {
  SubagentErrorCode,
  SubagentErrorInfo,
  SubagentFailureDetails,
  SubagentRunDetails,
} from "./types";

const MAX_CAUSE_LENGTH = 2000;
const ANSI_PATTERN = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const CONTROL_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const AUTH_HEADER_PATTERN = /(authorization\s*:\s*)[^,;\r\n]+/gi;
const SECRET_ASSIGNMENT_PATTERN = /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[=:]\s*)([^\s,;]+)/gi;
const BEARER_PATTERN = /(bearer\s+)[A-Za-z0-9._~+/=-]+/gi;

export class SubagentError extends Error {
  constructor(public readonly info: SubagentErrorInfo) {
    super(`${info.code}: ${info.message}`);
    this.name = "SubagentError";
  }
}

export function sanitizeErrorCause(value: unknown): string | undefined {
  const raw = value instanceof Error ? value.message : String(value ?? "");
  const sanitized = raw
    .replace(ANSI_PATTERN, "")
    .replace(CONTROL_PATTERN, "")
    .replace(AUTH_HEADER_PATTERN, "$1[REDACTED]")
    .replace(SECRET_ASSIGNMENT_PATTERN, "$1[REDACTED]")
    .replace(BEARER_PATTERN, "$1[REDACTED]")
    .trim();
  if (!sanitized) return undefined;
  return sanitized.length > MAX_CAUSE_LENGTH
    ? `${sanitized.slice(0, MAX_CAUSE_LENGTH - 3)}...`
    : sanitized;
}

export function createSubagentError(input: {
  code: SubagentErrorCode;
  message: string;
  operation: string;
  id?: string;
  retryable?: boolean;
  retries?: number;
  cause?: unknown;
  suggestedAction?: string;
}): SubagentError {
  const cause = sanitizeErrorCause(input.cause);
  return new SubagentError({
    code: input.code,
    message: input.message,
    operation: input.operation,
    ...(input.id ? { id: input.id } : {}),
    retryable: input.retryable === true,
    retries: Math.max(0, Math.trunc(input.retries ?? 0)),
    ...(cause && cause !== input.message ? { cause } : {}),
    ...(input.suggestedAction ? { suggestedAction: input.suggestedAction } : {}),
  });
}

export function isContextOverflowMessage(value: unknown): boolean {
  return /context(?:\s+window)?(?:\s+length)?|maximum context|too many tokens|token limit|prompt is too long/i.test(String(value ?? ""));
}

export function normalizeSubagentError(
  error: unknown,
  defaults: {
    operation: string;
    id?: string;
    retries?: number;
    code?: SubagentErrorCode;
    message?: string;
    retryable?: boolean;
    suggestedAction?: string;
  },
): SubagentError {
  if (error instanceof SubagentError) return error;

  const cause = sanitizeErrorCause(error) ?? "Unknown subagent failure.";
  const aborted = (error as any)?.name === "AbortError" || /\babort(?:ed)?\b|cancel(?:led|ed)/i.test(cause);
  const auth = /authentication|credentials?|api key|unauthorized|forbidden|\b401\b|\b403\b/i.test(cause);
  const contextTooLarge = isContextOverflowMessage(cause);
  const code = aborted
    ? "ABORTED"
    : auth
      ? "AUTH_FAILED"
      : contextTooLarge
        ? "CONTEXT_TOO_LARGE"
        : defaults.code ?? "SUBAGENT_FAILED";

  const message = defaults.message
    ?? (aborted
      ? "Subagent execution was aborted."
      : auth
        ? "Subagent authentication failed."
        : contextTooLarge
          ? "The delegated prompt does not fit in the child model context."
          : "Subagent execution failed.");

  return createSubagentError({
    code,
    message,
    operation: defaults.operation,
    id: defaults.id,
    retryable: defaults.retryable,
    retries: defaults.retries,
    cause,
    suggestedAction: defaults.suggestedAction,
  });
}

export function formatSubagentError(info: SubagentErrorInfo): string {
  const lines = [
    `Subagent failed: ${info.code}`,
    `Message: ${info.message}`,
    `Operation: ${info.operation}`,
    `Retryable: ${info.retryable ? "yes" : "no"}`,
    `Retries: ${info.retries}`,
  ];
  if (info.id) lines.push(`ID: ${info.id}`);
  if (info.cause) lines.push(`Cause: ${info.cause}`);
  if (info.suggestedAction) lines.push(`Suggested action: ${info.suggestedAction}`);
  return lines.join("\n");
}

export function failureToolResult(error: SubagentError | SubagentErrorInfo) {
  const info = error instanceof SubagentError ? error.info : error;
  const details: SubagentFailureDetails = { status: "error", error: info };
  return {
    content: [{ type: "text" as const, text: formatSubagentError(info) }],
    details,
    isError: true as const,
  };
}

export function applyRunFailure(details: SubagentRunDetails, error: SubagentError | SubagentErrorInfo): void {
  const info = error instanceof SubagentError ? error.info : error;
  details.phase = info.code === "ABORTED" ? "aborted" : "error";
  details.errorInfo = info;
  details.error = formatSubagentError(info);
  details.retries = Math.max(details.retries, info.retries);
}

export const __testables = {
  MAX_CAUSE_LENGTH,
};
