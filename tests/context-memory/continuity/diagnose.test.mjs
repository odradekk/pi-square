import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDiagnosticRecorder, runObservedSession, selectDiagnosticRuns } from "./diagnose.mjs";
import { runLabel } from "./runner.mjs";

const root = mkdtempSync(join(tmpdir(), "continuity-diagnostic-test-"));
try {
  const path = join(root, "events.jsonl");
  const recorder = createDiagnosticRecorder(path, { exactSecrets: ["opaque-credential-value"] });
  recorder.observe({ type: "context", messages: [{ content: "project QUARTZ-71\nAuthorization: Bearer opaque-credential-value\n\u001b[31mhello" }],
    headers: { arbitrary: "header-private" }, apiKey: "structured-private", "opaque-credential-value": "safe" });
  recorder.observe({ type: "response", message: { errorMessage: '400 {"api_key":"json-private","message":"bad request"}' } });
  recorder.observe({ type: "session", entries: [{ authorization: "opaque-auth", cookie: "opaque-cookie", nested: [{ password: "opaque-password" }],
    content: "https://user:opaque-url@example.test\n-----BEGIN PRIVATE KEY-----\nprivate-key-data\n-----END PRIVATE KEY-----" }] });
  recorder.close();
  const text = readFileSync(path, "utf8");
  for (const secret of ["opaque-credential-value", "header-private", "structured-private", "json-private", "opaque-auth", "opaque-cookie", "opaque-password", "opaque-url", "private-key-data", "\u001b"]) assert.equal(text.includes(secret), false, secret);
  assert.ok(text.includes("QUARTZ-71"));
  assert.ok(text.includes("bad request"));
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(recorder.status().complete, true);
  assert.throws(() => createDiagnosticRecorder(path), /EEXIST/);
  const link = join(root, "link.jsonl");
  symlinkSync(path, link);
  assert.throws(() => createDiagnosticRecorder(link));
  const bounded = createDiagnosticRecorder(join(root, "bounded.jsonl"), { maxBytes: 512 });
  bounded.observe({ type: "context", content: "x".repeat(1024) });
  bounded.close();
  assert.equal(bounded.status().complete, false);
  assert.ok(statSync(join(root, "bounded.jsonl")).size <= 512);
  const failed = createDiagnosticRecorder(join(root, "failed.jsonl"));
  failed.observe({ type: "capture-failure", reason: "native-journal-unavailable" });
  failed.close();
  assert.equal(failed.status().complete, false);
  const thrown = createDiagnosticRecorder(join(root, "thrown.jsonl"), { exactSecrets: ["exact-provider-secret"] });
  await assert.rejects(() => runObservedSession({}, thrown, async () => { throw new Error("Connection closed for exact-provider-secret"); }), /Connection closed/);
  thrown.close();
  const thrownText = readFileSync(join(root, "thrown.jsonl"), "utf8");
  assert.ok(thrownText.includes("Connection closed"));
  assert.equal(thrownText.includes("exact-provider-secret"), false);
  const fact = createDiagnosticRecorder(join(root, "fact.jsonl"), { exactSecrets: ["SYNTHETIC-TOKEN"], expected: { route_token: "SYNTHETIC-TOKEN" } });
  fact.observe({ type: "context", content: "route_token=SYNTHETIC-TOKEN" });
  fact.close();
  const factText = readFileSync(join(root, "fact.jsonl"), "utf8");
  assert.equal(factText.includes("SYNTHETIC-TOKEN"), false);
  assert.deepEqual(JSON.parse(factText).factMatches, [{ path: "$.content", fields: ["route_token"] }]);
  const report = { runs: [
    { run: "exact-work/middle/grok/search-enabled", status: "fail" },
    { run: "exact-work/early/grok/search-enabled", status: "inconclusive" },
    { run: "exact-work/late/grok/search-enabled", status: "pass" },
  ] };
  assert.deepEqual(selectDiagnosticRuns(report).map(runLabel), ["exact-work/middle/grok/search-enabled", "exact-work/early/grok/search-enabled"]);
  assert.throws(() => selectDiagnosticRuns({ runs: [{ run: "invented/run/grok/search-enabled", status: "fail" }] }), /unknown/);
} finally { rmSync(root, { recursive: true, force: true }); }
console.log("continuity controlled diagnostic tests passed");
