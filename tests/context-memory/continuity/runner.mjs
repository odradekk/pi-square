import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PLACEMENTS, SCENARIOS, buildScript } from "./scenarios.mjs";
import { createJiti } from "jiti";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { CONTINUITY_SESSION_CONFIG } from "./session.mjs";
import { SEED_MEMORY } from "./scenarios.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(HERE, "..", "..", "..");
export const REPORT_SCHEMA = "pi-square.context-memory/continuity-qualification/3";
export const HISTORICAL_REPORT_SCHEMA = "pi-square.context-memory/continuity-qualification/2";
export const EVIDENCE_SCHEMA = "pi-square.context-memory/continuity-evidence/3";
export const RECOVERY_REPORT_SCHEMA = "pi-square.context-memory/recovery-comparison/1";
// Each native cell retains the pre-#340 2 MiB diagnostic bound. The one
// owner-only matrix artifact is separately capped at 24 such cells.
const EVIDENCE_ARTIFACT_MAX_BYTES = 48 * 1024 * 1024;
export const MEASURED_WINDOW = CONTINUITY_SESSION_CONFIG.contextWindow;
export const MAX_OUTPUT_TOKENS = CONTINUITY_SESSION_CONFIG.maxTokens;
export const RUN_LIMITS = Object.freeze({ checkpoints: CONTINUITY_SESSION_CONFIG.maxCheckpoints, promptDeadlineMs: CONTINUITY_SESSION_CONFIG.promptTimeoutMs, requests: CONTINUITY_SESSION_CONFIG.maxRequests });
/** The fixture-owned compression schedule every valid run must show (#227 amendment, #325). */
export const SCHEDULE_POLICY = Object.freeze({
  seededRenderedTokens: SEED_MEMORY.renderedTokens,
  seededBlocks: SEED_MEMORY.blockCount,
  halfBudgetTokens: SEED_MEMORY.halfBudgetTokens,
  requiredAppends: CONTINUITY_SESSION_CONFIG.requiredAppends,
  requiredRebuilds: CONTINUITY_SESSION_CONFIG.requiredRebuilds,
  note: "the seed renders at exactly half the Memory budget, so the first due maintenance appends and every later one rebuilds, for any model-authored block size",
});
export const MODEL_LANES = Object.freeze({
  sonnet: Object.freeze({ provider: "ccr-claude", id: "claude-sonnet-5" }),
  glm: Object.freeze({ provider: "cpa", id: "glm-5.3" }),
});

export function parseQualificationReport(value) {
  if (!value || typeof value !== "object") throw new Error("continuity report must be an object");
  if (value.schema === HISTORICAL_REPORT_SCHEMA) {
    return { kind: "historical-16-cell-asymmetric", currentQualification: false, report: value };
  }
  if (value.schema === REPORT_SCHEMA) {
    if (value.completeness?.expected !== 24) throw new Error("current continuity report must declare 24 expected cells");
    return { kind: "current-24-cell-symmetric", currentQualification: true, report: value };
  }
  throw new Error(`unsupported continuity report schema: ${String(value.schema ?? "missing")}`);
}

const digest = (value) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
const hashPublicIdentity = (domain, value) => digest(`${domain}\0${value}`);
export function deriveSeed(run) { return digest(`${run.scenario}|${run.placement}`).slice(0, 16); }
export function caseKey(run) { return `${run.scenario}/${run.placement}`; }

/** One canonical 12-case corpus. Model identity never enters its seed or scripts. */
export function planCases() {
  return SCENARIOS.flatMap((scenario) => PLACEMENTS.map((placement) => {
    const script = buildScript(scenario, placement);
    return {
      scenario: scenario.id,
      placement,
      caseKey: caseKey({ scenario: scenario.id, placement }),
      seed: deriveSeed({ scenario: scenario.id, placement }),
      scriptDigest: digest({ ...script, oracle: undefined }),
      evaluationDigest: digest(script.oracle),
    };
  }));
}

/** The symmetric 24-cell qualification matrix: two lanes over one corpus. */
export function planRuns({ retrievalArm = "search-enabled" } = {}) {
  const retrievalCapability = { searchMemorySourceEnabled: retrievalArm !== "read-only" };
  return Object.keys(MODEL_LANES).flatMap((lane) => planCases().map((definition) => ({
    ...definition,
    lane,
    retrievalArm,
    retrievalCapabilityDigest: digest(retrievalCapability),
    model: MODEL_LANES[lane],
  })));
}
export function planRecoveryRuns() {
  return ["search-enabled", "read-only"].flatMap((retrievalArm) =>
    planRuns({ retrievalArm }).filter((run) => run.scenario === "source-recovery"));
}
export function runLabel(run) { return `${run.scenario}/${run.placement}/${run.lane}/${run.retrievalArm ?? "search-enabled"}`; }
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
  const value = { commit: git(["rev-parse", "HEAD"]), tree: git(["rev-parse", "HEAD^{tree}"]), dirty: status !== "", dirtyEntries: status === null ? null : status.split("\n").filter(Boolean).length,
    pi: packageJson.peerDependencies?.["@earendil-works/pi-coding-agent"] ?? null,
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    models: MODEL_LANES,
    sessionConfig: CONTINUITY_SESSION_CONFIG,
    executionConfig: {
      nativeCompaction: { enabled: false, keepRecentTokens: CONTINUITY_SESSION_CONFIG.keepRecentTokens },
      retry: { enabled: false, providerMaxRetries: 0 },
      thinkingLevel: "off",
      requestedTools: ["read", "bash", "write", "compact_to_memory_block", "read_memory_source", "search_memory_source"],
    },
    fixtureDigest: digest(planCases().map(({ caseKey: key, seed, scriptDigest, evaluationDigest }) => ({ key, seed, scriptDigest, evaluationDigest }))),
  };
  return { ...value, digest: createHash("sha256").update(JSON.stringify(value)).digest("hex") };
}

function exclusiveWrite(path, content) {
  const fd = openSync(path, "wx", 0o600);
  try { writeFileSync(fd, content); } finally { closeSync(fd); }
}
function artifactPaths(reportDir, kind = "continuity-qualification") {
  mkdirSync(reportDir, { recursive: true, mode: 0o700 });
  if (!lstatSync(reportDir).isDirectory() || realpathSync(reportDir) !== resolve(reportDir)) throw new Error("continuity report directory must be a real directory without symlinks");
  chmodSync(reportDir, 0o700);
  const id = `${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${randomUUID()}`;
  return { attemptId: id, report: join(reportDir, `${kind}-${id}.json`), markdown: join(reportDir, `${kind}-${id}.md`), evidence: join(reportDir, `continuity-evidence-${id}.json`), attempts: join(reportDir, "attempts.jsonl") };
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
    memoryStates: Number(value.memoryStates ?? 0), appends: Number(value.appends ?? 0), rebuilds: Number(value.rebuilds ?? 0),
    multiBlockMemory: value.multiBlockMemory === true,
    sourceCovered: value.sourceCovered === true, rawSourceAbsent: value.rawSourceAbsent === true,
  };
}
function compactIntegrity(value = {}) {
  return { ok: value.ok === true, failures: Array.isArray(value.failures) ? value.failures.slice(0, 32).map(String) : ["missing integrity"] };
}
export function safeUsage(requests) {
  return (Array.isArray(requests) ? requests : []).slice(0, RUN_LIMITS.requests).map(({ phase, request, stopReason, input, output, cacheRead, cacheWrite, tools, activeTools, errorPresent }) => ({
    phase: typeof phase === "string" ? phase : null,
    request: Number.isInteger(request) ? request : null,
    stopReason: typeof stopReason === "string" ? stopReason : null,
    input: Number.isFinite(input) ? input : null,
    output: Number.isFinite(output) ? output : null,
    cacheRead: Number.isFinite(cacheRead) ? cacheRead : null,
    cacheWrite: Number.isFinite(cacheWrite) ? cacheWrite : null,
    tools: Array.isArray(tools) ? tools.slice(0, 16).filter((tool) => typeof tool === "string").map((tool) => sanitizeDisplayText(tool).slice(0, 128)) : [],
    activeTools: Array.isArray(activeTools) ? activeTools.slice(0, 32).filter((tool) => typeof tool === "string").map((tool) => sanitizeDisplayText(tool).slice(0, 128)) : [],
    errorPresent: errorPresent === true,
  }));
}
export function safeRetrieval(value = {}) {
  const proof = (Array.isArray(value.proof) ? value.proof : []).slice(0, 16).map((row) => ({
    kind: row.kind === "search" || row.kind === "read" ? row.kind : null,
    resultSha256: typeof row.resultSha256 === "string" ? row.resultSha256.slice(0, 64) : null,
    viewSha256: typeof row.viewSha256 === "string" ? row.viewSha256.slice(0, 64) : null,
    provenanceSha256: typeof row.provenanceSha256 === "string" ? row.provenanceSha256.slice(0, 64) : null,
    scope: row.scope && typeof row.scope === "object" ? {
      kind: row.scope.kind === "all" || row.scope.kind === "block" ? row.scope.kind : null,
      selectedBlock: Number.isSafeInteger(row.scope.selectedBlock) ? row.scope.selectedBlock : null,
      sourceBlockCount: Number.isSafeInteger(row.scope.sourceBlockCount) ? row.scope.sourceBlockCount : null,
    } : null,
    locations: (Array.isArray(row.locations) ? row.locations : []).slice(0, 12).map((location) => ({
      block: Number.isSafeInteger(location?.block) ? location.block : null,
      pages: (Array.isArray(location?.pages) ? location.pages : []).slice(0, 2).map((page) => Number.isSafeInteger(page) ? page : null),
    })),
    observedAtRequest: Number.isSafeInteger(row.observedAtRequest) ? row.observedAtRequest : null,
    returnedBytes: Number.isSafeInteger(row.returnedBytes) ? row.returnedBytes : null,
    coveredFields: Array.isArray(row.coveredFields) ? row.coveredFields.slice(0, 16).map((field) => sanitizeDisplayText(String(field)).slice(0, 128)) : [],
  }));
  const integerOrMissing = (field) => Number.isSafeInteger(value[field]) ? value[field] : null;
  return {
    required: value.required === true ? true : value.required === false ? false : null,
    qualified: value.qualified === true ? true : value.qualified === false ? false : null,
    bounded: value.bounded === true ? true : value.bounded === false ? false : null,
    code: typeof value.code === "string" ? sanitizeDisplayText(value.code).slice(0, 64) : "missing",
    searches: integerOrMissing("searches"),
    targetedReads: integerOrMissing("targetedReads"),
    pageReads: integerOrMissing("pageReads"),
    returnedEvidenceBytes: integerOrMissing("returnedEvidenceBytes"),
    observedSearches: integerOrMissing("observedSearches"),
    observedReads: integerOrMissing("observedReads"),
    requirements: value.requirements && typeof value.requirements === "object" ? {
      total: Number.isSafeInteger(value.requirements.total) ? value.requirements.total : null,
      satisfied: Number.isSafeInteger(value.requirements.satisfied) ? value.requirements.satisfied : null,
    } : null,
    proof,
  };
}
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
  if (Buffer.byteLength(text) > EVIDENCE_ARTIFACT_MAX_BYTES) return null;
  return { evidence, text, sha256: createHash("sha256").update(text).digest("hex"), complete: runs.every((entry) => entry.evidence !== null) };
}
function inconclusiveScore(run, message) { return { run, result: "inconclusive", critical: { total: 0, matched: 0 }, continuity: { total: 0, matched: 0 }, finalTask: false, fields: [], severe: {}, failures: [{ code: "runner-error", message }] }; }
let oracleModule;
async function oracle() { oracleModule ??= import("./oracles.mjs"); return oracleModule; }

/** Execute one real native Pi session; fake adapters and transcript simulation are deliberately absent. */
export async function executeRun({ runtime, model, sessionRunner, run, exactSecrets = [], signal }) {
  const scenario = SCENARIOS.find((entry) => entry.id === run.scenario);
  if (!scenario) throw new Error(`unknown continuity scenario: ${run.scenario}`);
  const script = buildScript(scenario, run.placement);
  try {
    const result = await sessionRunner({ packageRoot: PACKAGE_ROOT, modelRuntime: runtime, model: model ?? run.model, script, run, signal });
    if (signal?.aborted || result?.cancelled === true) return cancelledRecord(run, "cancelled", script);
    const integrity = compactIntegrity(result?.integrity); const coverage = compactCoverage(result?.coverage);
    const score = (await oracle()).scoreRun({ run, script, artifactText: result?.artifactText, integrity, coverage, retrievalQualification: result?.retrievalQualification });
    const terminal = result?.timedOut === true ? "timeout" : result?.providerError === true ? "error" : score.result;
    return { run, script, result, integrity, coverage, score, terminal, error: null };
  } catch (error) {
    if (signal?.aborted) return cancelledRecord(run, "cancelled", script);
    const message = errorText(error, exactSecrets);
    const terminal = /\b(?:deadline|timed?\s*out|timeout)\b/i.test(message) ? "timeout" : "error";
    return { run, script, result: null, integrity: { ok: false, failures: [message] }, coverage: compactCoverage(), score: inconclusiveScore(run, message), terminal, error: message };
  }
}

function cancelledRecord(run, terminal, script = null) {
  const message = terminal === "cancelled" ? "user cancellation interrupted this cell" : "not attempted because the qualification was cancelled";
  return { run, script, result: null, integrity: { ok: false, failures: [message] }, coverage: compactCoverage(), score: inconclusiveScore(run, message), terminal, error: null };
}

/** Two concurrently started queues; every queue awaits its own cases in order. */
export async function runModelQueues({ plannedRuns = planRuns(), models, runtime, sessionRunner, exactSecrets = [], signal, onEvent } = {}) {
  const lanes = Object.keys(MODEL_LANES);
  async function runQueue(lane) {
    const records = [];
    for (const planned of plannedRuns.filter((run) => run.lane === lane)) {
      const model = models?.get(lane) ?? planned.model;
      const run = { ...planned, model: modelMetadata(model, planned.model) };
      if (signal?.aborted) {
        records.push(cancelledRecord(run, "not-attempted"));
        continue;
      }
      try { onEvent?.({ type: "run-start", run }); } catch {}
      const record = await executeRun({ runtime, model, sessionRunner, run, exactSecrets, signal });
      records.push(record);
      try { onEvent?.({ type: "run-end", run, record }); } catch {}
    }
    return records;
  }
  const queues = lanes.map((lane) => runQueue(lane));
  return (await Promise.all(queues)).flat();
}

function summary(record) {
  const { score, run, integrity, coverage, result, error } = record;
  return {
    run: runLabel(run), caseKey: run.caseKey, scenario: run.scenario, placement: run.placement, lane: run.lane,
    retrievalArm: run.retrievalArm, seed: run.seed, scriptDigest: run.scriptDigest, evaluationDigest: run.evaluationDigest, model: run.model,
    retrievalCapabilityDigest: run.retrievalCapabilityDigest,
    status: record.terminal, ok: score.result === "pass", integrity, coverage, error,
    score: {
      result: score.result, severe: score.severe, critical: score.critical, continuity: score.continuity,
      artifactValid: score.artifactValid === true, sourceVerified: score.sourceVerified === true, finalTask: score.finalTask,
      fields: (score.fields ?? []).slice(0, 32).map(({ key, family, status }) => ({ key, family, status })),
      failures: (score.failures ?? []).slice(0, 32).map(({ id, code, field, class: klass }) => ({ id: id ?? code, field: field ?? null, class: klass ?? null })),
    },
    requests: safeUsage(result?.requests),
    retrieval: safeRetrieval(result?.retrievalQualification),
    measurements: safeMeasurements(result?.measurements),
    phaseLatency: safeLatency(result?.phaseLatency),
    elapsedMs: totalIfComplete(result?.phaseLatency, "ms"),
    isolation: result?.isolation && typeof result.isolation === "object"
      ? Object.fromEntries(Object.entries(result.isolation).slice(0, 8).map(([key, value]) => [key, typeof value === "string" ? value.slice(0, 64) : null]))
      : null,
  };
}

/** Bounded per-run measurements: indexes, counts, and hashes only, never bodies. */
function safeMeasurements(value = {}) {
  return {
    acceptanceToApplication: (Array.isArray(value.acceptanceToApplication) ? value.acceptanceToApplication : []).slice(0, 16)
      .map((row) => ({ stateHash: typeof row.id === "string" ? hashPublicIdentity("memory-state", row.id) : null, operation: row.operation ?? null, phase: row.phase ?? null,
        recordedAtRequest: Number.isInteger(row.recordedAtRequest) ? row.recordedAtRequest : null,
        appliedAtRequest: Number.isInteger(row.appliedAtRequest) ? row.appliedAtRequest : null,
        requestGap: Number.isInteger(row.requestGap) ? row.requestGap : null })),
    prefixStable: value.prefixStable === true,
    refusals: value.refusals && typeof value.refusals === "object" ? Object.fromEntries(Object.entries(value.refusals).slice(0, 8).map(([code, count]) => [sanitizeDisplayText(String(code)).slice(0, 48), Number(count) || 0])) : {},
    peakPromptTokens: Number.isFinite(value.peakPromptTokens) ? value.peakPromptTokens : null,
    netInputChange: Number.isInteger(value.netInputChange) ? value.netInputChange : null,
  };
}

function safeLatency(rows) {
  return (Array.isArray(rows) ? rows : []).slice(0, 32).map((row) => ({ phase: typeof row.phase === "string" ? row.phase : null, ms: Number.isFinite(row.ms) ? row.ms : null }));
}

function totalIfComplete(rows, field) {
  if (!Array.isArray(rows) || rows.length === 0 || rows.some((row) => !Number.isFinite(row?.[field]))) return null;
  return rows.reduce((total, row) => total + row[field], 0);
}

function usageSummary(record) {
  const rows = Array.isArray(record?.result?.requests) ? record.result.requests : [];
  const field = (name) => ({
    present: rows.some((row) => Number.isFinite(row?.[name])),
    reportedRequests: rows.filter((row) => Number.isFinite(row?.[name])).length,
    total: totalIfComplete(rows, name),
  });
  return { requests: rows.length, input: field("input"), output: field("output"), cacheRead: field("cacheRead"), cacheWrite: field("cacheWrite") };
}

function pairCell(record) {
  if (!record) return null;
  const retrieval = safeRetrieval(record.result?.retrievalQualification);
  const unknowns = (record.score?.fields ?? []).filter((field) => field.family === "unknown");
  return {
    terminal: record.terminal,
    factualFields: (record.score?.fields ?? []).slice(0, 32).map(({ key, family, status }) => ({ key, family, status })),
    unknownsPreserved: unknowns.length > 0 && unknowns.every((field) => field.status === "matched"),
    artifactValid: record.score?.artifactValid === true,
    compressionCoverage: compactCoverage(record.coverage),
    retrieval,
    usage: usageSummary(record),
    elapsedMs: totalIfComplete(record.result?.phaseLatency, "ms"),
  };
}

function difference(right, left) {
  return Number.isFinite(right) && Number.isFinite(left) ? right - left : null;
}

/** Stable corresponding pairs keyed by the shared case definition, never completion order. */
export function buildPairs(records) {
  const byCell = new Map(records.map((record) => [`${record.run.lane}\0${record.run.caseKey}`, record]));
  return planCases().map((definition) => {
    const sonnetRecord = byCell.get(`sonnet\0${definition.caseKey}`);
    const glmRecord = byCell.get(`glm\0${definition.caseKey}`);
    const sonnet = pairCell(sonnetRecord);
    const glm = pairCell(glmRecord);
    return {
      caseKey: definition.caseKey,
      scenario: definition.scenario,
      placement: definition.placement,
      seed: definition.seed,
      sonnet,
      glm,
      differences: {
        direction: "glm-minus-sonnet",
        inputTokens: difference(glm?.usage.input.total, sonnet?.usage.input.total),
        elapsedMs: difference(glm?.elapsedMs, sonnet?.elapsedMs),
        returnedEvidenceBytes: difference(glm?.retrieval.returnedEvidenceBytes, sonnet?.retrieval.returnedEvidenceBytes),
      },
    };
  });
}

export function buildRecoveryPairs(records) {
  const byCell = new Map(records.map((record) => [`${record.run.lane}\0${record.run.caseKey}\0${record.run.retrievalArm}`, record]));
  return Object.keys(MODEL_LANES).flatMap((lane) => planCases().filter((definition) => definition.scenario === "source-recovery").map((definition) => {
    const enabledRecord = byCell.get(`${lane}\0${definition.caseKey}\0search-enabled`);
    const readOnlyRecord = byCell.get(`${lane}\0${definition.caseKey}\0read-only`);
    const searchEnabled = pairCell(enabledRecord);
    const readOnly = pairCell(readOnlyRecord);
    return {
      lane,
      caseKey: definition.caseKey,
      scenario: definition.scenario,
      placement: definition.placement,
      seed: definition.seed,
      searchEnabled,
      readOnly,
      capabilityPins: {
        searchEnabled: enabledRecord?.run.retrievalCapabilityDigest ?? null,
        readOnly: readOnlyRecord?.run.retrievalCapabilityDigest ?? null,
      },
      differences: {
        direction: "search-enabled-minus-read-only",
        inputTokens: difference(searchEnabled?.usage.input.total, readOnly?.usage.input.total),
        elapsedMs: difference(searchEnabled?.elapsedMs, readOnly?.elapsedMs),
        returnedEvidenceBytes: difference(searchEnabled?.retrieval.returnedEvidenceBytes, readOnly?.retrieval.returnedEvidenceBytes),
      },
    };
  }));
}
function markdown(report) {
  const display = (value) => value === null || value === undefined ? "missing" : String(value);
  const lines = ["# Context Memory continuity qualification", "", `machine status: **${report.machineStatus}**`, "",
    "This report requires human review; it is not a release pass.", "",
    `schedule: seeded Memory renders at exactly ${report.schedulePolicy.seededRenderedTokens} tokens (half budget ${report.schedulePolicy.halfBudgetTokens}); every valid run needs ≥${report.schedulePolicy.requiredAppends} append and ≥${report.schedulePolicy.requiredRebuilds} suffix rebuilds`, "",
    "## Cells", "",
    "| run | status | integrity | coverage | ops (append/rebuild) | artifact | unknowns | retrieval | search/read/pages/bytes | input/cache read/cache write | elapsed ms |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"];
  for (const run of report.runs) {
    const unknowns = run.score.fields.filter((field) => field.family === "unknown");
    const unknownStatus = unknowns.length > 0 && unknowns.every((field) => field.status === "matched") ? "preserved" : "failed";
    const input = run.requests.length > 0 && run.requests.every((request) => Number.isFinite(request.input)) ? run.requests.reduce((total, request) => total + request.input, 0) : null;
    const cacheRead = run.requests.length > 0 && run.requests.every((request) => Number.isFinite(request.cacheRead)) ? run.requests.reduce((total, request) => total + request.cacheRead, 0) : null;
    const cacheWrite = run.requests.length > 0 && run.requests.every((request) => Number.isFinite(request.cacheWrite)) ? run.requests.reduce((total, request) => total + request.cacheWrite, 0) : null;
    lines.push(`| ${run.run} | ${run.status} | ${run.integrity.ok ? "ok" : "inconclusive"} | ${run.coverage.ok ? "ok" : "inconclusive"} | ${run.coverage.appends ?? 0}/${run.coverage.rebuilds ?? 0} | ${run.score.artifactValid ? "valid" : "invalid"} | ${unknownStatus} | ${run.retrieval.code} | ${display(run.retrieval.searches)}/${display(run.retrieval.targetedReads)}/${display(run.retrieval.pageReads)}/${display(run.retrieval.returnedEvidenceBytes)} | ${display(input)}/${display(cacheRead)}/${display(cacheWrite)} | ${display(run.elapsedMs)} |`);
  }
  lines.push("", "## Corresponding model pairs", "",
    "Valid numeric differences are GLM minus Sonnet; missing provider measurements remain missing.", "",
    "| case | Sonnet | GLM | input-token difference | evidence-byte difference | elapsed-ms difference |",
    "| --- | --- | --- | --- | --- | --- |");
  for (const pair of report.pairs) lines.push(`| ${pair.caseKey} | ${pair.sonnet?.terminal ?? "missing"} | ${pair.glm?.terminal ?? "missing"} | ${display(pair.differences.inputTokens)} | ${display(pair.differences.returnedEvidenceBytes)} | ${display(pair.differences.elapsedMs)} |`);
  lines.push("", "## Per-model totals", "",
    "Bytes are returned evidence bytes, not billed tokens.", "",
    "| model | completed / failed / inconclusive / error / timeout / cancelled / not attempted | requests | input | cache read present | cache write present | search/read/pages/bytes | elapsed ms |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const [lane, totals] of Object.entries(report.modelTotals)) {
    const terminal = totals.terminal;
    lines.push(`| ${lane} | ${terminal.completed}/${terminal.failed}/${terminal.inconclusive}/${terminal.errors}/${terminal.timeouts}/${terminal.cancelled}/${terminal.notAttempted} | ${totals.usage.requests} | ${display(totals.usage.input.total)} | ${totals.cachePresence.read ? "present" : "missing"} | ${totals.cachePresence.write ? "present" : "missing"} | ${display(totals.retrieval.searches)}/${display(totals.retrieval.targetedReads)}/${display(totals.retrieval.pageReads)}/${display(totals.retrieval.returnedEvidenceBytes)} | ${display(totals.elapsedMs)} |`);
  }
  return `${lines.join("\n")}\n`;
}

export function qualificationStatus(records, gates, privateEvidence) {
  const complete = records.length === 24 && records.every((record) => record.integrity.ok && record.coverage.ok && !record.error
    && !["cancelled", "not-attempted", "error", "timeout"].includes(record.terminal));
  const inconclusive = !complete || !privateEvidence?.complete || gates.result === "inconclusive";
  return { complete, machineStatus: inconclusive ? "inconclusive-needs-human-review" : gates.result === "pass" ? "pass-needs-human-review" : "failed-needs-human-review" };
}

function countsFor(records) {
  const counts = { planned: records.length, attempted: 0, completed: 0, succeeded: 0, failed: 0, inconclusive: 0, errors: 0, timeouts: 0, cancelled: 0, notAttempted: 0 };
  for (const record of records) {
    if (record.terminal !== "not-attempted") counts.attempted += 1;
    if (!["not-attempted", "cancelled"].includes(record.terminal)) counts.completed += 1;
    if (record.terminal === "pass") counts.succeeded += 1;
    if (record.terminal === "fail") counts.failed += 1;
    if (record.terminal === "inconclusive") counts.inconclusive += 1;
    if (record.terminal === "error") counts.errors += 1;
    if (record.terminal === "timeout") counts.timeouts += 1;
    if (record.terminal === "cancelled") counts.cancelled += 1;
    if (record.terminal === "not-attempted") counts.notAttempted += 1;
  }
  return counts;
}

function completenessOf(records, ok) {
  return {
    expected: 24,
    ...countsFor(records),
    byModel: Object.fromEntries(Object.keys(MODEL_LANES).map((lane) => [lane, countsFor(records.filter((record) => record.run.lane === lane))])),
    ok,
  };
}

function modelTotals(records) {
  return Object.fromEntries(Object.keys(MODEL_LANES).map((lane) => {
    const cells = records.filter((record) => record.run.lane === lane);
    const requests = cells.flatMap((record) => record.result?.requests ?? []);
    const retrievals = cells.map((record) => safeRetrieval(record.result?.retrievalQualification));
    const retrievalTotal = (field) => retrievals.every((value) => Number.isFinite(value[field]))
      ? retrievals.reduce((total, value) => total + value[field], 0)
      : null;
    return [lane, {
      terminal: countsFor(cells),
      usage: usageSummary({ result: { requests } }),
      cachePresence: {
        read: requests.some((row) => Number.isFinite(row?.cacheRead)),
        write: requests.some((row) => Number.isFinite(row?.cacheWrite)),
      },
      retrieval: {
        searches: retrievalTotal("searches"),
        targetedReads: retrievalTotal("targetedReads"),
        pageReads: retrievalTotal("pageReads"),
        returnedEvidenceBytes: retrievalTotal("returnedEvidenceBytes"),
      },
      elapsedMs: cells.every((record) => totalIfComplete(record.result?.phaseLatency, "ms") !== null)
        ? cells.reduce((total, record) => total + totalIfComplete(record.result?.phaseLatency, "ms"), 0)
        : null,
    }];
  }));
}

/** Executes the symmetric 24 cells as two concurrently started sequential queues. */
export async function runQualification({ runtime, reportDir, mode = "real", sessionRunner, onEvent, signal } = {}) {
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
    pins = refreshPinDigest({ ...pins,
      models: Object.fromEntries([...resolved.models].map(([arm, model]) => [arm, modelMetadata(model, MODEL_LANES[arm])])),
      retrievalCapabilities: { searchMemorySourceEnabled: true },
    });
    appendAttempt(paths.attempts, { at: new Date().toISOString(), attemptId: paths.attemptId, status: "models-resolved", pins: pins.digest });
    const records = await runModelQueues({ plannedRuns: planRuns(), models: resolved.models, runtime: resolved.modelRuntime,
      sessionRunner, exactSecrets, signal, onEvent });
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
      humanReview: "required",
      schedulePolicy: SCHEDULE_POLICY,
      gates,
      runs: records.map(summary),
      execution: { laneConcurrency: "parallel", caseOrderWithinLane: "sequential", laneOrder: Object.keys(MODEL_LANES), caseOrder: planCases().map((entry) => entry.caseKey) },
      completeness: completenessOf(records, status.complete),
      pairs: buildPairs(records),
      modelTotals: modelTotals(records),
      rawEvidence: { schema: EVIDENCE_SCHEMA, retained: false, reason: "missing private evidence blocks a positive result" },
    };
    if (privateEvidence) {
      exclusiveWrite(paths.evidence, privateEvidence.text);
      report.rawEvidence = { schema: EVIDENCE_SCHEMA, retained: true, file: basename(paths.evidence), sha256: privateEvidence.sha256, complete: privateEvidence.complete };
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
export function selectRerunScope({ kind, scenarios = [], lanes = [] }) { const all = planRuns(); if (kind === "ui" || kind === "documentation") return { scope: "none", runs: [] }; if ((kind === "provider" || kind === "pi-compat") && lanes.length) return { scope: "affected", runs: all.filter((run) => lanes.includes(run.lane)) }; if (kind === "defect" && scenarios.length) return { scope: "affected", runs: all.filter((run) => scenarios.includes(run.scenario)) }; return { scope: "full", runs: all }; }

function recoveryMarkdown(report) {
  const lines = [
    "# Context Memory recovery capability comparison",
    "",
    `machine status: **${report.machineStatus}**`,
    "",
    "This separate A/B report does not contribute cells to the 24-cell continuity qualification and requires human review.",
    "",
    "| model | case | search-enabled | read-only | input delta | evidence-byte delta |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const pair of report.recoveryComparison.pairs) {
    lines.push(`| ${pair.lane} | ${pair.caseKey} | ${pair.searchEnabled?.terminal ?? "missing"} | ${pair.readOnly?.terminal ?? "missing"} | ${pair.differences.inputTokens ?? "missing"} | ${pair.differences.returnedEvidenceBytes ?? "missing"} |`);
  }
  return `${lines.join("\n")}\n`;
}

/** Separate both-model search-enabled versus read-only recovery comparison. */
export async function runRecoveryComparison({ runtime, reportDir, mode = "real", sessionRunner, onEvent, signal } = {}) {
  if (!sessionRunner) ({ runContinuitySession: sessionRunner } = await import("./session.mjs"));
  if (typeof sessionRunner !== "function") throw new Error("runRecoveryComparison requires the native runContinuitySession sessionRunner");
  if (mode !== "real") throw new Error("recovery comparison has no synthetic dry-run; use the offline provider from tests");
  let pins = pinEnvironment();
  const paths = artifactPaths(reportDir ?? join(HERE, "report"), "recovery-comparison");
  const planned = planRecoveryRuns();
  appendAttempt(paths.attempts, { at: new Date().toISOString(), attemptId: paths.attemptId, status: "started", pins: pins.digest, mode, kind: "recovery-comparison", planned: planned.map(runLabel) });
  let exactSecrets = [];
  try {
    if (pins.dirty) throw new Error("refusing credentialed recovery comparison from a dirty checkout (tracked or untracked changes present)");
    const resolved = await resolveRunModels(runtime);
    exactSecrets = resolved.exactSecrets;
    const capabilityPin = { "search-enabled": { searchMemorySourceEnabled: true }, "read-only": { searchMemorySourceEnabled: false } };
    pins = refreshPinDigest({ ...pins,
      models: Object.fromEntries([...resolved.models].map(([lane, model]) => [lane, modelMetadata(model, MODEL_LANES[lane])])),
      retrievalCapabilities: { ...capabilityPin, digest: digest(capabilityPin) },
    });
    appendAttempt(paths.attempts, { at: new Date().toISOString(), attemptId: paths.attemptId, status: "models-resolved", pins: pins.digest });
    const records = await runModelQueues({ plannedRuns: planned, models: resolved.models, runtime: resolved.modelRuntime,
      sessionRunner, exactSecrets, signal, onEvent });
    const privateEvidence = buildPrivateEvidence(records, { attemptId: paths.attemptId, pins: pins.digest, exactSecrets });
    const counts = countsFor(records);
    const complete = records.length === 12 && counts.notAttempted === 0 && counts.cancelled === 0 && counts.errors === 0 && counts.timeouts === 0
      && records.every((record) => record.integrity.ok && record.coverage.ok);
    const report = {
      schema: RECOVERY_REPORT_SCHEMA,
      attemptId: paths.attemptId,
      generatedAt: new Date().toISOString(),
      mode,
      pins,
      machineStatus: complete && privateEvidence?.complete ? "complete-needs-human-review" : "inconclusive-needs-human-review",
      releasePass: false,
      humanReview: "required",
      execution: { laneConcurrency: "parallel", caseOrderWithinLane: "sequential", qualificationCellsAffected: 0 },
      runs: records.map(summary),
      recoveryComparison: { expected: 12, counts, complete, pairs: buildRecoveryPairs(records), modelTotals: modelTotals(records) },
      rawEvidence: { schema: EVIDENCE_SCHEMA, retained: false, reason: "missing private evidence blocks a complete comparison" },
    };
    if (privateEvidence) {
      exclusiveWrite(paths.evidence, privateEvidence.text);
      report.rawEvidence = { schema: EVIDENCE_SCHEMA, retained: true, file: basename(paths.evidence), sha256: privateEvidence.sha256, complete: privateEvidence.complete };
    }
    const json = `${JSON.stringify(report, null, 2)}\n`;
    const md = recoveryMarkdown(report);
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
