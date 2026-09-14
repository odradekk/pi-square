import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { safeDiagnosticProjection, safeErrorDiagnostic, safeProcessDiagnostic } from "./diagnostics.mjs";
import { createQualificationReport } from "./qualify.mjs";

const privateOutput = "source: private Memory body; credential=super-secret-token";
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
let assertionError;
try { assert.equal("actual private Memory body", "expected credential=super-secret-token"); }
catch (error) { assertionError = error; }

const assertionDiagnostic = safeErrorDiagnostic(assertionError, { repoRoot });
assert.deepEqual([assertionDiagnostic.kind, assertionDiagnostic.name, assertionDiagnostic.code], ["assertion", "AssertionError", "ERR_ASSERTION"]);
assert.equal(assertionDiagnostic.locations.some((location) => location.startsWith("tests/context-memory/qualification/qualify.test.mjs:")), true);
assert.equal(JSON.stringify(assertionDiagnostic).includes("super-secret-token"), false);

const unknownDiagnostic = safeErrorDiagnostic({ message: privateOutput }, { repoRoot });
assert.equal(unknownDiagnostic.kind, "unknown");
assert.equal(safeDiagnosticProjection(unknownDiagnostic)?.fingerprint, unknownDiagnostic.fingerprint,
  "an unclassified failure retains its bounded diagnostic identity");

const timeoutDiagnostic = safeProcessDiagnostic({ stdout: privateOutput, stderr: "", error: Object.assign(new Error(privateOutput), { code: "ETIMEDOUT" }) }, { repoRoot });
assert.deepEqual([timeoutDiagnostic.kind, timeoutDiagnostic.code], ["timeout", "ETIMEDOUT"]);
const parsedAssertionDiagnostic = safeProcessDiagnostic({ stdout: assertionError.stack, stderr: privateOutput, error: null }, { repoRoot });
assert.deepEqual([parsedAssertionDiagnostic.kind, parsedAssertionDiagnostic.code], ["assertion", "ERR_ASSERTION"]);

const bodyCodes = safeProcessDiagnostic({
  stdout: "ordinary output mentions ERR_ASSERTION and ENOENT",
  stderr: "TypeError: expected ERR_MODULE_NOT_FOUND as fixture text\n    at runner (file:///outside/project.mjs:1:2)", error: null,
}, { repoRoot });
assert.deepEqual([bodyCodes.kind, bodyCodes.name, bodyCodes.code], ["error", "TypeError", null]);

const report = createQualificationReport({
  suites: ["tests/context-memory/failing.test.mjs", "tests/context-memory/timed-out.test.mjs", "tests/context-memory/passing.test.mjs"],
  runs: [
    { area: "protocol", suite: "tests/context-memory/failing.test.mjs", ok: false, exitCode: 1, signal: null, diagnostic: parsedAssertionDiagnostic, tail: privateOutput },
    { area: "protocol", suite: "tests/context-memory/timed-out.test.mjs", ok: false, exitCode: null, signal: "SIGTERM", diagnostic: timeoutDiagnostic, tail: privateOutput },
    { area: "protocol", suite: "tests/context-memory/passing.test.mjs", ok: true, exitCode: 0, signal: null, diagnostic: null, tail: privateOutput },
  ],
  provenanceData: { head: "abc", branchDirty: false, implementationDigest: "implementation", corpusDigest: "corpus" },
  generatedAt: "2026-09-13T00:00:00.000Z",
});
assert.equal(report.result, "fail");
assert.equal(report.schema, "pi-square.context-memory/qualification/3");
assert.equal(report.failures.length, 2);
assert.equal(JSON.stringify(report).includes(privateOutput), false);
assert.equal(JSON.stringify(report).includes("super-secret-token"), false);

console.log("context-memory qualification report privacy tests passed");
