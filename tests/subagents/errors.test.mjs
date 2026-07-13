import assert from "node:assert/strict";
import { resolve } from "node:path";

import jiti from "jiti";
import { run, test } from "./lib/test-helpers.mjs";

const packageRoot = resolve(import.meta.dirname, "..", "..");
const load = jiti(import.meta.url, { moduleCache: false });
const {
  createSubagentError,
  failureToolResult,
  normalizeSubagentError,
  sanitizeErrorCause,
} = await load(resolve(packageRoot, "src", "subagents", "errors.ts"));

test("error causes remove credentials, ANSI, and control characters", () => {
  const sanitized = sanitizeErrorCause("\u001b[31mAuthorization: Bearer secret-token\u001b[0m\u0000");
  assert.doesNotMatch(sanitized, /secret-token|\u001b|\u0000/);
  assert.match(sanitized, /\[REDACTED\]/);
});

test("structured and visible error contracts carry the same fields", () => {
  const error = createSubagentError({
    code: "SESSION_HISTORY_UNAVAILABLE",
    message: "History is unavailable.",
    operation: "resume",
    id: "subagent_00000000-0000-4000-8000-000000000061",
    retryable: false,
    retries: 0,
    cause: "missing file",
    suggestedAction: "Restore the files.",
  });
  const result = failureToolResult(error);
  assert.equal(result.isError, true);
  assert.deepEqual(result.details.error, error.info);
  for (const value of [error.info.code, error.info.message, error.info.operation, error.info.id, error.info.cause, error.info.suggestedAction]) {
    assert.ok(result.content[0].text.includes(value));
  }
});

test("authentication and context failures are classified without retries", () => {
  const auth = normalizeSubagentError(new Error("401 invalid API key"), { operation: "fg" });
  assert.equal(auth.info.code, "AUTH_FAILED");
  assert.equal(auth.info.retryable, false);

  const context = normalizeSubagentError(new Error("maximum context length exceeded"), { operation: "resume" });
  assert.equal(context.info.code, "CONTEXT_TOO_LARGE");
  assert.equal(context.info.retryable, false);
});

test("causes are bounded", () => {
  const sanitized = sanitizeErrorCause("x".repeat(5000));
  assert.equal(sanitized.length, 2000);
  assert.ok(sanitized.endsWith("..."));
});

await run();
