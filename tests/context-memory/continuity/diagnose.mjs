import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createJiti } from "jiti";
import { executeRun, HISTORICAL_REPORT_SCHEMA, LOW_THINKING_REPORT_SCHEMA, pinEnvironment, planRuns, REPORT_SCHEMA,
  resolveRunModels, runLabel, UNVERIFIED_THINKING_REPORT_SCHEMA, VERIFIED_OFF_THINKING_REPORT_SCHEMA } from "./runner.mjs";
import { runContinuitySession } from "./session.mjs";
import { buildScript } from "./scenarios.mjs";
import { safeErrorDiagnostic } from "../qualification/diagnostics.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");
const { sanitizeDisplayText } = createJiti(import.meta.url)("../../../src/display/sanitize.ts");
const SECRET_KEY = /^(?:authorization|proxy-authorization|headers|cookie|set-cookie|(?:x-)?api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passphrase|secret|credentials?)$/i;
const MAX_EVENT_BYTES = 8 * 1024 * 1024;

// Readable local evidence is an explicit exception, not a replacement for the
// hash-only qualification report. Sanitize before writing or bounding output.
function cleanText(value, exactSecrets) {
  return sanitizeDisplayText(value, { exactSecrets })
    .replace(/("(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passphrase|secret)"\s*:\s*)"(?:\\.|[^"\\])*"/gi, '$1"[REDACTED]"')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi, "[REDACTED]")
    .replace(/((?:set-cookie|cookie)\s*:\s*)[^\r\n]+/gi, "$1[REDACTED]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@");
}

export function createDiagnosticRecorder(path, { exactSecrets = [], expected = {}, maxBytes = 32 * 1024 * 1024 } = {}) {
  const fd = openSync(path, "wx", 0o600);
  let bytes = 0;
  let events = 0;
  let complete = true;
  let closed = false;
  return {
    observe(event) {
      if (closed || !complete) return;
      try {
        const raw = JSON.stringify(event);
        if (Buffer.byteLength(raw) > MAX_EVENT_BYTES) throw new Error("event bound");
        let nodes = 0;
        const factMatches = [];
        function project(value, path = "$", depth = 0) {
          if (++nodes > 200_000 || depth > 48) throw new Error("structure bound");
          if (typeof value === "string") {
            // Presence metadata is computed before credential cleaning: a
            // fixture's route_token may itself look like a secret assignment.
            const fields = Object.entries(expected).filter(([, fact]) => typeof fact === "string" && value.includes(fact)).map(([field]) => field);
            if (fields.length) factMatches.push({ path: cleanText(path, exactSecrets), fields });
            return cleanText(value, exactSecrets);
          }
          if (Array.isArray(value)) return value.map((item, index) => project(item, `${path}[${index}]`, depth + 1));
          if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [
            cleanText(key, exactSecrets), SECRET_KEY.test(key) ? "[REDACTED]" : project(item, `${path}.${key}`, depth + 1),
          ]));
          return value;
        }
        const sanitized = project(JSON.parse(raw));
        const text = `${JSON.stringify({ event: sanitized, factMatches })}\n`;
        if (bytes + Buffer.byteLength(text) > maxBytes) throw new Error("file bound");
        writeFileSync(fd, text);
        bytes += Buffer.byteLength(text);
        events += 1;
        if (event.type === "capture-failure") complete = false;
      } catch { complete = false; }
    },
    close() {
      if (closed) return;
      closed = true;
      try { fsyncSync(fd); } catch { complete = false; }
      finally { closeSync(fd); }
    },
    status() { return { complete, events, bytes }; },
  };
}

export function selectDiagnosticRuns(report) {
  const planned = new Map(planRuns().map((run) => [runLabel(run), run]));
  const selected = (report.runs ?? []).filter((row) => ["fail", "inconclusive", "error"].includes(row.status));
  if (selected.length === 0 || selected.length > 16) throw new Error("diagnosis requires 1–16 non-passing cells");
  const seen = new Set();
  return selected.map((row) => {
    const run = planned.get(row.run);
    if (!run || seen.has(row.run)) throw new Error("unknown or duplicate diagnostic cell");
    seen.add(row.run);
    return run;
  });
}

export async function runObservedSession(options, recorder, sessionRunner = runContinuitySession) {
  try { return await sessionRunner({ ...options, diagnosticObserver: recorder.observe }); }
  catch (error) {
    recorder.observe({ type: "exception", message: error instanceof Error ? error.message : "non-Error thrown value",
      diagnostic: safeErrorDiagnostic(error, { repoRoot: ROOT }) });
    throw error;
  }
}

/** Bind an uncommitted diagnostic run to actual file bytes, not HEAD alone. */
function checkoutDigest() {
  const listed = spawnSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd: ROOT, encoding: "utf8" });
  if (listed.status !== 0) throw new Error("checkout snapshot unavailable");
  const hash = createHash("sha256");
  for (const path of [...new Set(listed.stdout.split("\0").filter(Boolean))].sort()) {
    hash.update(path).update("\0");
    const file = join(ROOT, path);
    try {
      if (!lstatSync(file).isFile()) throw new Error("snapshot requires regular files");
      hash.update(createHash("sha256").update(readFileSync(file)).digest());
    } catch (error) { if (error.code !== "ENOENT") throw error; hash.update("deleted"); }
  }
  return hash.digest("hex");
}

function privateDirectory() {
  const parent = join(HERE, "report");
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (!lstatSync(parent).isDirectory() || realpathSync(parent) !== parent) throw new Error("diagnostic directory must not contain symlinks");
  chmodSync(parent, 0o700);
  return mkdtempSync(join(parent, "diagnostic-"));
}

export async function runDiagnostic(reportPath) {
  const stat = lstatSync(reportPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw new Error("invalid input report");
  const input = readFileSync(reportPath, "utf8");
  const previous = JSON.parse(input);
  // Old reports select cells only; reruns use the current checkout's criterion,
  // never reinterpret the stored score or page-completeness evidence.
  if (![REPORT_SCHEMA, LOW_THINKING_REPORT_SCHEMA, VERIFIED_OFF_THINKING_REPORT_SCHEMA, UNVERIFIED_THINKING_REPORT_SCHEMA,
    HISTORICAL_REPORT_SCHEMA].includes(previous.schema)) throw new Error("expected a qualification report");
  const runs = selectDiagnosticRuns(previous);
  const pins = pinEnvironment();
  const fileDigest = checkoutDigest();
  const { modelRuntime, models, exactSecrets } = await resolveRunModels();
  const directory = privateDirectory();
  const manifest = { schema: "pi-square.context-memory/local-diagnostic/1", qualification: false, releasePass: false,
    sourceAttempt: previous.attemptId, sourceReportSha256: createHash("sha256").update(input).digest("hex"),
    pins, checkoutSha256: fileDigest, startedAt: new Date().toISOString(),
    observation: "post-pi-square context handler; not a wire payload or provider delivery receipt; thinking omitted; sanitized copies are not byte-exact replay fixtures; synchronous capture can affect timing; checkout digest covers nonignored regular-file paths and bytes, not modes",
    retention: "local owner-only; no automatic publication; manually remove this diagnostic directory after review", runs: [] };
  const start = createDiagnosticRecorder(join(directory, "start.jsonl"), { exactSecrets });
  start.observe(manifest); start.close();
  if (!start.status().complete) throw new Error("diagnostic start record unavailable");
  console.log(`diagnostic directory: ${directory}`);
  for (const run of runs) {
    if (checkoutDigest() !== fileDigest) throw new Error("checkout changed during diagnosis");
    const label = runLabel(run);
    const recorder = createDiagnosticRecorder(join(directory, `${label.replaceAll("/", "--")}.jsonl`), { exactSecrets, expected: buildScript(run.scenario, run.placement).oracle.expected });
    console.log(`start: ${label}`);
    let record;
    try {
      record = await executeRun({ runtime: modelRuntime, model: models.get(run.lane), run, exactSecrets,
        sessionRunner: (options) => runObservedSession(options, recorder) });
      recorder.observe({ type: "result", score: record.score, integrity: record.integrity, coverage: record.coverage,
        error: record.error, diagnostic: record.diagnostic, measurements: record.result?.measurements, requests: record.result?.requests });
    } finally { recorder.close(); }
    manifest.runs.push({ run: label, status: record.score.result, capture: recorder.status() });
    console.log(`end: ${label} (${record.score.result}; capture ${recorder.status().complete ? "complete" : "incomplete"})`);
  }
  manifest.finishedAt = new Date().toISOString();
  manifest.checkoutUnchanged = checkoutDigest() === fileDigest;
  const end = createDiagnosticRecorder(join(directory, "manifest.jsonl"), { exactSecrets });
  end.observe(manifest); end.close();
  if (!end.status().complete) throw new Error("diagnostic manifest unavailable");
  return { directory, manifest };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== "--real" || args[1] !== "--retain-local-diagnostics" || args[2] !== "--from-report") {
    console.log("Usage: node tests/context-memory/continuity/diagnose.mjs --real --retain-local-diagnostics --from-report <qualification.json>");
    process.exitCode = args.length ? 2 : 0;
  } else {
    try {
      const { manifest } = await runDiagnostic(resolve(args[3]));
      process.exitCode = manifest.checkoutUnchanged && manifest.runs.every((run) => run.capture.complete) ? 0 : 1;
    } catch { console.error("diagnostic run failed; inspect the owner-only partial capture if created"); process.exitCode = 2; }
  }
}
