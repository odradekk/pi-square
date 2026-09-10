import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SCENARIOS, PRIMARY_ARM_VARIANTS, buildScript } from "./scenarios.mjs";
import { createJiti } from "jiti";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { CONTINUITY_SESSION_CONFIG } from "./session.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(HERE, "..", "..", "..");
export const REPORT_SCHEMA = "pi-square.context-memory/continuity-qualification/2";
export const EVIDENCE_SCHEMA = "pi-square.context-memory/continuity-evidence/2";
export const MEASURED_WINDOW = CONTINUITY_SESSION_CONFIG.contextWindow;
export const MAX_OUTPUT_TOKENS = CONTINUITY_SESSION_CONFIG.maxTokens;
export const RUN_LIMITS = Object.freeze({ checkpoints: CONTINUITY_SESSION_CONFIG.maxCheckpoints, promptDeadlineMs: CONTINUITY_SESSION_CONFIG.promptTimeoutMs, requests: CONTINUITY_SESSION_CONFIG.maxRequests });
export const MODEL_LANES = Object.freeze({
  primary: Object.freeze({ provider: "ccr-claude", id: "claude-sonnet-5" }),
  secondary: Object.freeze({ provider: "cpa", id: "glm-5.3" }),
});

export function deriveSeed(run) { return createHash("sha256").update(`${run.scenario}|${run.variant}|${run.arm}`).digest("hex").slice(0, 16); }
/** The fixed 12 + 4 qualification matrix. */
export function planRuns() {
  return SCENARIOS.flatMap((scenario) => [
    ...PRIMARY_ARM_VARIANTS.map((variant) => ({ scenario: scenario.id, variant, arm: "primary" })),
    { scenario: scenario.id, variant: "canonical", arm: "secondary" },
  ]).map((run) => ({ ...run, seed: deriveSeed(run), model: MODEL_LANES[run.arm] }));
}
export function runLabel(run) { return `${run.scenario}/${run.variant}/${run.arm}`; }
function modelMetadata(model, fallback) {
  return {
    provider: typeof model?.provider === "string" ? model.provider : fallback.provider,
    id: typeof model?.id === "string" ? model.id : fallback.id,
    api: typeof model?.api === "string" ? model.api : null,
  };
}

function collectExactSecrets(authResult, output) {
  const auth = authResult?.auth;
  if (typeof auth?.apiKey === "string" && auth.apiKey) output.add(auth.apiKey);
  for (const [name, value] of Object.entries(auth?.headers ?? {})) {
    if (/(authorization|credential|key|secret|token)/i.test(name) && typeof value === "string" && value) output.add(value);
  }
}
export async function resolveRunModels(runtime) {
  const modelRuntime = runtime ?? await ModelRuntime.create({ allowModelNetwork: false, refreshOnCreate: false });
  const models = new Map();
  const exactSecrets = new Set();
  for (const [arm, pin] of Object.entries(MODEL_LANES)) {
    const model = modelRuntime.getModel(pin.provider, pin.id);
    if (!model) throw new Error(`Pi model configuration does not define ${pin.provider}/${pin.id}`);
    // No availability refresh runs here. Resolve auth directly; the cached
    // configured-provider snapshot is empty until Pi refreshes it.
    let authResult;
    try { authResult = await modelRuntime.getAuth(model); }
    catch { throw new Error(`Pi authentication resolution failed for ${pin.provider}/${pin.id}`); }
    if (!authResult) throw new Error(`Pi authentication is unavailable for ${pin.provider}/${pin.id}`);
    collectExactSecrets(authResult, exactSecrets);
    models.set(arm, model);
  }
  return { modelRuntime, models, exactSecrets: [...exactSecrets] };
}

function git(args) { const result = spawnSync("git", args, { cwd: PACKAGE_ROOT, encoding: "utf8" }); return result.status === 0 ? result.stdout.trim() : null; }
function refreshPinDigest(pins) {
  const { digest, ...unhashed } = pins;
  return { ...unhashed, digest: createHash("sha256").update(JSON.stringify(unhashed)).digest("hex") };
}
/** Pins all checkout state; real qualification refuses a dirty checkout. */
export function pinEnvironment() {
  const packageJson = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"));
  const status = git(["status", "--porcelain=v1", "--untracked-files=all"]);
  const value = { commit: git(["rev-parse", "HEAD"]), tree: git(["rev-parse", "HEAD^{tree}"]), dirty: status !== "", dirtyEntries: status === null ? null : status.split("\n").filter(Boolean).length, pi: packageJson.peerDependencies?.["@earendil-works/pi-coding-agent"] ?? null, models: MODEL_LANES, sessionConfig: CONTINUITY_SESSION_CONFIG };
  return { ...value, digest: createHash("sha256").update(JSON.stringify(value)).digest("hex") };
}

function exclusiveWrite(path, content) {
  const fd = openSync(path, "wx", 0o600);
  try { writeFileSync(fd, content); } finally { closeSync(fd); }
}
function artifactPaths(reportDir) {
  mkdirSync(reportDir, { recursive: true, mode: 0o700 });
  if (!lstatSync(reportDir).isDirectory() || realpathSync(reportDir) !== resolve(reportDir)) throw new Error("continuity report directory must be a real directory without symlinks");
  chmodSync(reportDir, 0o700);
  const id = `${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${randomUUID()}`;
  return { attemptId: id, report: join(reportDir, `continuity-qualification-${id}.json`), markdown: join(reportDir, `continuity-qualification-${id}.md`), evidence: join(reportDir, `continuity-evidence-${id}.json`), attempts: join(reportDir, "attempts.jsonl") };
}
function appendAttempt(path, value) {
  try {
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error("continuity attempts log must be a regular file");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    if (!fstatSync(fd).isFile()) throw new Error("continuity attempts log must be a regular file");
    fchmodSync(fd, 0o600);
    writeFileSync(fd, `${JSON.stringify(value)}\n`);
  } finally {
    closeSync(fd);
  }
}
function redactText(value, exactSecrets = []) {
  let text = String(value);
  for (const secret of exactSecrets) if (typeof secret === "string" && secret) text = text.split(secret).join("[REDACTED]");
  return sanitizeDisplayText(text);
}
function errorText(error, exactSecrets) { return redactText(error instanceof Error ? error.message : String(error), exactSecrets).slice(0, 1000); }
function compactCoverage(value = {}) {
  return {
    ok: value.ok === true,
    failures: Array.isArray(value.failures) ? value.failures.slice(0, 32).map(String) : ["missing coverage"],
    compactions: Number(value.compactions ?? 0), appends: Number(value.appends ?? 0), rebuilds: Number(value.rebuilds ?? 0),
    sourceCovered: value.sourceCovered === true, rawSourceAbsent: value.rawSourceAbsent === true,
  };
}
function compactIntegrity(value = {}) {
  return { ok: value.ok === true, failures: Array.isArray(value.failures) ? value.failures.slice(0, 32).map(String) : ["missing integrity"] };
}
export function safeUsage(requests) {
  return (Array.isArray(requests) ? requests : []).slice(0, RUN_LIMITS.requests).map(({ phase, request, stopReason, input, output, cacheRead, cacheWrite, tools }) => ({
    phase: typeof phase === "string" ? phase : null,
    request: Number.isInteger(request) ? request : null,
    stopReason: typeof stopReason === "string" ? stopReason : null,
    input: Number.isFinite(input) ? input : null,
    output: Number.isFinite(output) ? output : null,
    cacheRead: Number.isFinite(cacheRead) ? cacheRead : null,
    cacheWrite: Number.isFinite(cacheWrite) ? cacheWrite : null,
    tools: Array.isArray(tools) ? tools.slice(0, 16).filter((tool) => typeof tool === "string").map((tool) => sanitizeDisplayText(tool).slice(0, 128)) : [],
  }));
}
function safeSourceReads(reads) { return (Array.isArray(reads) ? reads : []).slice(0, 32).map(({ block, page, complete, coversSource }) => ({ block: Number(block), page: Number(page), complete: complete === true, coversSource: coversSource === true })); }
const jiti = createJiti(import.meta.url);
const { sanitizeDisplayText } = jiti("../../../src/display/sanitize.ts");
function sanitizeEvidence(value, exactSecrets) {
  if (typeof value === "string") return redactText(value, exactSecrets);
  if (Array.isArray(value)) return value.map((item) => sanitizeEvidence(item, exactSecrets));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [redactText(key, exactSecrets).slice(0, 256), sanitizeEvidence(item, exactSecrets)]));
  return value === null || typeof value === "number" || typeof value === "boolean" ? value : null;
}
export function buildPrivateEvidence(records, { attemptId, pins, exactSecrets = [] }) {
  const runs = records.map((record) => ({ run: runLabel(record.run), evidence: record.result?.evidence ?? null, missing: record.result?.evidence ? null : record.error ?? record.integrity.failures[0] ?? "driver returned no evidence" }));
  if (!runs.some((entry) => entry.evidence !== null)) return null;
  const evidence = { schema: EVIDENCE_SCHEMA, attemptId, pins, runs: sanitizeEvidence(runs, exactSecrets) };
  const text = `${JSON.stringify(evidence)}\n`;
  return { evidence, text, sha256: createHash("sha256").update(text).digest("hex"), complete: runs.every((entry) => entry.evidence !== null) };
}
function inconclusiveScore(run, message) { return { run, result: "inconclusive", critical: { total: 0, matched: 0 }, continuity: { total: 0, matched: 0 }, finalTask: false, fields: [], severe: {}, failures: [{ code: "runner-error", message }] }; }
let oracleModule;
async function oracle() { oracleModule ??= import("./oracles.mjs"); return oracleModule; }

/** Execute one real native Pi session; fake adapters and transcript simulation are deliberately absent. */
export async function executeRun({ runtime, model, sessionRunner, run, exactSecrets = [] }) {
  const scenario = SCENARIOS.find((entry) => entry.id === run.scenario);
  if (!scenario) throw new Error(`unknown continuity scenario: ${run.scenario}`);
  const script = buildScript(scenario, run.variant);
  try {
    const result = await sessionRunner({ packageRoot: PACKAGE_ROOT, modelRuntime: runtime, model: model ?? run.model, script, run });
    const integrity = compactIntegrity(result?.integrity); const coverage = compactCoverage(result?.coverage);
    const score = (await oracle()).scoreRun({ run, script, artifactText: result?.artifactText, integrity, coverage, sourceReads: result?.sourceReads ?? [] });
    return { run, script, result, integrity, coverage, score, error: null };
  } catch (error) {
    const message = errorText(error, exactSecrets);
    return { run, script, result: null, integrity: { ok: false, failures: [message] }, coverage: compactCoverage(), score: inconclusiveScore(run, message), error: message };
  }
}

function summary(record) {
  const { score, run, integrity, coverage, result, error } = record;
  return {
    run: runLabel(run), scenario: run.scenario, variant: run.variant, arm: run.arm, seed: run.seed, model: run.model,
    status: error ? "error" : score.result, ok: score.result === "pass", integrity, coverage, error,
    score: {
      result: score.result, severe: score.severe, critical: score.critical, continuity: score.continuity,
      artifactValid: score.artifactValid === true, sourceVerified: score.sourceVerified === true, finalTask: score.finalTask,
      fields: (score.fields ?? []).slice(0, 32).map(({ key, family, status }) => ({ key, family, status })),
      failures: (score.failures ?? []).slice(0, 32).map(({ id, code, field, class: klass }) => ({ id: id ?? code, field: field ?? null, class: klass ?? null })),
    },
    requests: safeUsage(result?.requests),
    sourceReads: safeSourceReads(result?.sourceReads),
  };
}
function markdown(report) {
  const lines = ["# Context Memory continuity qualification", "", `machine status: **${report.machineStatus}**`, "", "This report requires human review; it is not a release pass.", "", "| run | status | integrity | coverage |", "| --- | --- | --- | --- |"];
  for (const run of report.runs) lines.push(`| ${run.run} | ${run.status} | ${run.integrity.ok ? "ok" : "inconclusive"} | ${run.coverage.ok ? "ok" : "inconclusive"} |`);
  return `${lines.join("\n")}\n`;
}

export function qualificationStatus(records, gates, privateEvidence) {
  const complete = records.length === 16 && records.every((record) => record.integrity.ok && record.coverage.ok && !record.error);
  const inconclusive = !complete || !privateEvidence?.complete || gates.result === "inconclusive";
  return { complete, machineStatus: inconclusive ? "inconclusive-needs-human-review" : gates.result === "pass" ? "pass-needs-human-review" : "failed-needs-human-review" };
}

/** Executes all sixteen runs sequentially, logging an attempt before any request. */
export async function runQualification({ runtime, reportDir, mode = "real", sessionRunner, onEvent } = {}) {
  if (!sessionRunner) ({ runContinuitySession: sessionRunner } = await import("./session.mjs"));
  if (typeof sessionRunner !== "function") throw new Error("runQualification requires the native runContinuitySession sessionRunner");
  if (mode !== "real") throw new Error("continuity qualification has no synthetic dry-run; use the offline provider from tests");
  let pins = pinEnvironment();
  const paths = artifactPaths(reportDir ?? join(HERE, "report"));
  appendAttempt(paths.attempts, { at: new Date().toISOString(), attemptId: paths.attemptId, status: "started", pins: pins.digest, mode, planned: planRuns().map(runLabel) });
  let exactSecrets = [];
  try {
    if (pins.dirty) throw new Error("refusing credentialed continuity qualification from a dirty checkout (tracked or untracked changes present)");
    const resolved = await resolveRunModels(runtime);
    exactSecrets = resolved.exactSecrets;
    pins = refreshPinDigest({ ...pins, models: Object.fromEntries([...resolved.models].map(([arm, model]) => [arm, modelMetadata(model, MODEL_LANES[arm])])) });
    appendAttempt(paths.attempts, { at: new Date().toISOString(), attemptId: paths.attemptId, status: "models-resolved", pins: pins.digest });
    const records = [];
    for (const planned of planRuns()) {
      const model = resolved.models.get(planned.arm);
      const run = { ...planned, model: modelMetadata(model, planned.model) };
      try { onEvent?.({ type: "run-start", run }); } catch {}
      const record = await executeRun({ runtime: resolved.modelRuntime, model, sessionRunner, run, exactSecrets });
      records.push(record);
      try { onEvent?.({ type: "run-end", run, record }); } catch {}
    }
    const scores = records.map((record) => record.score);
    const gates = (await oracle()).evaluateGates(scores);
    const privateEvidence = buildPrivateEvidence(records, { attemptId: paths.attemptId, pins: pins.digest, exactSecrets });
    const status = qualificationStatus(records, gates, privateEvidence);
    const report = {
      schema: REPORT_SCHEMA,
      attemptId: paths.attemptId,
      generatedAt: new Date().toISOString(),
      mode,
      pins,
      machineStatus: status.machineStatus,
      releasePass: false,
      gates,
      runs: records.map(summary),
      completeness: { expected: 16, completed: records.length, ok: status.complete },
      rawEvidence: { schema: EVIDENCE_SCHEMA, retained: false, reason: "missing private evidence blocks a positive result" },
    };
    if (privateEvidence) {
      exclusiveWrite(paths.evidence, privateEvidence.text);
      report.rawEvidence = { schema: EVIDENCE_SCHEMA, retained: true, path: paths.evidence, sha256: privateEvidence.sha256, complete: privateEvidence.complete };
    }
    const json = `${JSON.stringify(report, null, 2)}\n`;
    const md = markdown(report);
    exclusiveWrite(paths.report, json);
    exclusiveWrite(paths.markdown, md);
    appendAttempt(paths.attempts, { at: report.generatedAt, attemptId: paths.attemptId, status: "completed", pins: pins.digest, machineStatus: report.machineStatus, report: paths.report });
    return { report, json, markdown: md, files: { reportJson: paths.report, reportMarkdown: paths.markdown, evidence: report.rawEvidence.retained ? paths.evidence : null, attempts: paths.attempts } };
  } catch (error) {
    const message = errorText(error, exactSecrets);
    appendAttempt(paths.attempts, { at: new Date().toISOString(), attemptId: paths.attemptId, status: "failed", pins: pins.digest, error: message });
    throw new Error(message);
  }
}
export function selectRerunScope({ kind, scenarios = [], arms = [] }) { const all = planRuns(); if (kind === "ui" || kind === "documentation") return { scope: "none", runs: [] }; if ((kind === "provider" || kind === "pi-compat") && arms.length) return { scope: "affected", runs: all.filter((run) => arms.includes(run.arm)) }; if (kind === "defect" && scenarios.length) return { scope: "affected", runs: all.filter((run) => scenarios.includes(run.scenario)) }; return { scope: "full", runs: all }; }
