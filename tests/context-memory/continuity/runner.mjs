import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, appendFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MARKER, SEVERE_CLASSES, RESERVE_TOKENS, host } from "../qualification/harness.mjs";
import {
  SCENARIOS,
  PRIMARY_ARM_VARIANTS,
  QUALIFICATION_CONFIG,
  MODEL_WINDOW,
  buildScript,
  SEED_BLOCKS,
  SEED_BLOCK_COUNT,
  renderedMemoryTokens,
} from "./scenarios.mjs";
import { scoreRun, evaluateGates } from "./oracles.mjs";

/**
 * The continuity qualification runner (#224).
 *
 * It plans the fixed 16-run matrix of #215's release gate — the primary
 * provider/model in early/middle/late critical-evidence variants and the
 * secondary provider/model in one canonical variant per scenario — pins the
 * exact execution environment, drives every run through one adapter seam,
 * applies the deterministic oracle, and emits the bounded report plus the
 * append-only attempts log that makes favorable rerun selection detectable.
 *
 * The adapter seam is the whole provider boundary. The dry-run adapter in
 * `fake-model.mjs` drives the production controller with a scripted model and
 * no credentials. #227 supplies a real adapter module with the same contract:
 * `{ declaration: { id, requiredEnv, arms }, createSession({ script, run }) }`
 * where a session is `{ runTurn(turn) → evidence, stats(), close() }`. The
 * contract binds adapters to send only `turn.user` text to the provider —
 * never scripted answers or oracle patterns — so qualification cannot be
 * coached.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");
export const DEFAULT_MATRIX_SALT = "pi-square.context-memory/continuity/1";
const FAILURE_LIST_CAP = 64;
export const REPORT_SCHEMA = "pi-square.context-memory/continuity-qualification/1";

// ─── Run matrix and seeds ──────────────────────────────────────────

/** The fixed 16-run matrix: 12 primary variant runs plus 4 secondary canonical runs. */
export function planRuns({ salt = DEFAULT_MATRIX_SALT } = {}) {
  const runs = [];
  for (const scenario of SCENARIOS) {
    for (const variant of PRIMARY_ARM_VARIANTS) {
      runs.push({ scenario: scenario.id, variant, arm: "primary" });
    }
    runs.push({ scenario: scenario.id, variant: "canonical", arm: "secondary" });
  }
  return runs.map((run) => ({ ...run, seed: deriveSeed(run, salt) }));
}

export function deriveSeed(run, salt = DEFAULT_MATRIX_SALT) {
  return createHash("sha256")
    .update(`${salt}|${run.scenario}|${run.variant}|${run.arm}`)
    .digest("hex")
    .slice(0, 16);
}

export function runLabel(run) {
  return `${run.scenario}/${run.variant}/${run.arm}`;
}

/**
 * The #215 impact-based rerun rules, as a deterministic selection over the
 * same matrix: model-visible or algorithm changes rerun everything, Pi or
 * provider compatibility and defect fixes rerun their affected scope, pure UI
 * or documentation changes rerun nothing. Unknown kinds and unspecified scope
 * fail safe toward more rerunning, never less.
 */
export function selectRerunScope({ kind, scenarios = [], arms = [] }) {
  const all = planRuns();
  if (kind === "ui" || kind === "documentation") {
    return { scope: "none", runs: [], reason: "pure UI or documentation changes rerun no real-model runs" };
  }
  if (kind === "pi-compat" || kind === "provider") {
    if (arms.length === 0) {
      return { scope: "full", runs: all, reason: "a compatibility change without named arms fails safe to the full matrix" };
    }
    return {
      scope: "affected",
      runs: all.filter((run) => arms.includes(run.arm)),
      reason: `Pi/provider compatibility change reruns every run of the affected arms: ${arms.join(", ")}`,
    };
  }
  if (kind === "defect") {
    if (scenarios.length === 0) {
      return { scope: "full", runs: all, reason: "a defect fix without named scenarios fails safe to the full matrix" };
    }
    return {
      scope: "affected",
      runs: all.filter((run) => scenarios.includes(run.scenario)),
      reason: `defect fix reruns every variant and arm of the affected scenarios: ${scenarios.join(", ")}`,
    };
  }
  return { scope: "full", runs: all, reason: `model-visible or algorithm change (kind ${kind}) reruns the full matrix` };
}

// ─── Environment pinning ───────────────────────────────────────────

function gitOutput(args) {
  const result = spawnSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

function digestOf(paths) {
  const hash = createHash("sha256");
  for (const path of [...paths].sort()) {
    hash.update(path);
    hash.update("\0");
    hash.update(readFileSync(path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function continuityFiles(extension) {
  return readdirSync(HERE)
    .filter((name) => name.endsWith(extension))
    .map((name) => join(HERE, name));
}

/**
 * Pin everything #224 requires before any run executes: implementation
 * commit and digest, Pi/package/config identity, per-arm provider/model with
 * thinking and sampling settings, fixture and rubric digests, and the
 * complete supported seed list. The pins digest folds these into one value
 * the attempts log and the human rubric can cite.
 */
export function pinEnvironment({ adapterDeclaration, salt = DEFAULT_MATRIX_SALT } = {}) {
  const implementationDir = join(REPO_ROOT, "src", "context-memory");
  const implementationFiles = readdirSync(implementationDir)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => join(implementationDir, name));
  const fixtureFiles = [...continuityFiles(".mjs"), join(HERE, "rubric.md")].filter((path) => existsSync(path));
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));

  const pins = {
    implementation: {
      commit: gitOutput(["rev-parse", "HEAD"]),
      digest: digestOf(implementationFiles),
      dirty: gitOutput(["status", "--porcelain", "--", "src/context-memory", "tests/context-memory/continuity"]) !== "",
    },
    package: { name: pkg.name, version: pkg.version },
    pi: {
      package: pkg.peerDependencies?.["@earendil-works/pi-coding-agent"] ?? null,
      running: host.resolveHostVersion(),
    },
    config: {
      contextMemory: QUALIFICATION_CONFIG,
      modelWindow: MODEL_WINDOW,
      reserveTokens: RESERVE_TOKENS,
    },
    arms: adapterDeclaration?.arms ?? null,
    adapter: adapterDeclaration?.id ?? null,
    fixtures: {
      digest: digestOf(fixtureFiles),
      rubricDigest: createHash("sha256").update(readFileSync(join(HERE, "rubric.md"))).digest("hex"),
      scenarios: SCENARIOS.map((scenario) => scenario.id),
      // #261 disclosure: the schedule policy is pinned before any scored run,
      // not chosen after one. The seed renders at exactly half the Memory
      // budget, so every run must observe one append then two rebuilds.
      schedulePolicy: {
        seededBlocks: SEED_BLOCK_COUNT,
        seededRenderedTokens: renderedMemoryTokens(SEED_BLOCKS),
        requiredSchedule: "one append onto the seeded Memory, then two suffix rebuilds, in every run",
        reason: "seeded half-budget Memory makes the append-versus-rebuild decision fixture-controlled, not model-prose-controlled",
      },
    },
    seeds: planRuns({ salt }).map((run) => ({ ...run })),
    seedRule: `sha256("${salt}|scenario|variant|arm") truncated to 16 hex characters; the matrix is deterministic and involves no random sampling`,
    matrixSalt: salt,
  };
  pins.pinsDigest = createHash("sha256").update(JSON.stringify(pins)).digest("hex");
  return pins;
}

// ─── Execution ─────────────────────────────────────────────────────

function normalizeAdapter(adapter) {
  const declaration = adapter?.declaration;
  if (!declaration || typeof declaration.id !== "string" || !declaration.arms) {
    throw new Error("an adapter must declare { id, arms } (see fake-model.mjs for the contract)");
  }
  if (typeof adapter.createSession !== "function") {
    throw new Error("an adapter must expose createSession({ script, run }) (see fake-model.mjs for the contract)");
  }
  for (const arm of ["primary", "secondary"]) {
    const declared = declaration.arms[arm];
    if (!declared || !declared.provider || !declared.model || !declared.thinking || !declared.sampling) {
      throw new Error(`adapter arm ${arm} must declare provider, model, thinking, and sampling settings`);
    }
  }
  return { declaration, requiredEnv: adapter.requiredEnv ?? declaration.requiredEnv ?? [], createSession: adapter.createSession };
}

/** Execute and score exactly one planned run through the adapter seam. */
export async function executeRun({ adapter, run }) {
  const scenario = SCENARIOS.find((entry) => entry.id === run.scenario);
  if (!scenario) throw new Error(`unknown scenario ${run.scenario}`);
  const script = buildScript(scenario, run.variant);
  const session = adapter.createSession({ script, run });
  const evidence = [];
  let adapterError = null;
  try {
    for (const turn of script.turns) {
      evidence.push(await session.runTurn(turn));
    }
  } catch (error) {
    // An adapter that crashes mid-run is a failed run, never a silent skip:
    // the error becomes one bounded evidence record the scorer reports.
    adapterError = error instanceof Error ? error.message : String(error);
  } finally {
    await session.close?.();
  }
  if (adapterError !== null) {
    evidence.push({
      turn: "adapter",
      kind: "work",
      advisory: false,
      assistantText: "",
      assistantChars: 0,
      requestChars: 0,
      toolCalls: [],
      sourceReads: [],
      compression: null,
      memoryPurity: null,
      error: `adapter failure: ${adapterError}`,
    });
  }
  const stats = session.stats?.() ?? {};
  for (const event of stats.compressions ?? []) {
    if (event.turnIndex === null || event.turnIndex === undefined) {
      event.turnIndex = evidence.findIndex((record) => record.turn === event.turn);
    }
  }
  const purityObservations = evidence.filter((record) => record.memoryPurity !== null);
  const combinedStats = {
    ...stats,
    memoryPurity: purityObservations.length === 0
      ? undefined
      : purityObservations.every((record) => record.memoryPurity === true),
  };
  const score = scoreRun({ run, evidence, oracle: script.oracle, stats: combinedStats });
  return { score, evidence };
}

// ─── Report assembly ───────────────────────────────────────────────

/** The report must never contain Memory or answer bodies, or credentials. */
function findReportLeaks(json) {
  const leaks = [];
  if (json.includes(MARKER)) leaks.push("the fixture content marker");
  const repeated = json.match(/(.)\1{63}/);
  if (repeated) leaks.push("a 64+ character repeated run (fixture padding)");
  return leaks;
}

/** Remove any leaked fixture content before the artifact is written. */
function maskLeaks(json) {
  return json
    .split(MARKER)
    .join("‹redacted›")
    .replace(/(.{1})(\1{63,})/g, (match, char) => `${char}<×${match.length}>`);
}

function runSummary(score) {
  return {
    run: runLabel(score.run),
    scenario: score.run.scenario,
    variant: score.run.variant,
    arm: score.run.arm,
    seed: score.run.seed,
    turns: score.turns,
    severe: score.severe,
    severeTotal: score.severeTotal,
    criticalRecall: score.critical.total === 0 ? 1 : score.critical.matched / score.critical.total,
    continuityRecall: score.continuity.total === 0 ? 1 : score.continuity.matched / score.continuity.total,
    finalTask: score.finalTask,
    schedule: score.schedule,
    hardCheckFailures: score.hardCheckFailures.map((failure) => failure.id),
    ok: score.ok,
  };
}

export function buildReport({ mode, adapterId, pins, runScores, evidences }) {
  const { gates, result } = evaluateGates(runScores);
  const severeClasses = Object.fromEntries(SEVERE_CLASSES.map((klass) => [
    klass,
    runScores.reduce((sum, score) => sum + score.severe[klass], 0),
  ]));
  const allFailures = runScores.flatMap((score) =>
    score.failures.map((failure) => ({ run: runLabel(score.run), ...failure })));

  const report = {
    schema: REPORT_SCHEMA,
    generatedAt: new Date().toISOString(),
    mode,
    adapter: adapterId,
    result,
    releaseRelevant: mode === "real",
    resultNote: mode === "dry-run"
      ? "dry-run proves the qualification machinery only; it never authorizes a release (#227 executes the real gate)"
      : "real-mode execution; the release verdict additionally requires the fixed human review of rubric.md",
    gates,
    zeroTolerance: {
      failures: allFailures.length,
      waivers: 0,
      retries: 0,
      severeFailures: gates.severeFailures.total,
    },
    pins,
    severeClasses,
    runs: runScores.map(runSummary),
    failures: allFailures.slice(0, FAILURE_LIST_CAP),
    failuresTruncated: allFailures.length > FAILURE_LIST_CAP,
    totals: {
      runs: runScores.length,
      turns: runScores.reduce((sum, score) => sum + score.turns, 0),
      failed: runScores.filter((score) => !score.ok).length,
    },
    economics: {
      note: "informational only; compression and cost numbers never enter the verdict",
      simulated: mode === "dry-run",
      perRun: runScores.map((score, index) => ({
        run: runLabel(score.run),
        requestChars: evidences[index].reduce((sum, record) => sum + (record.requestChars ?? 0), 0),
        assistantChars: evidences[index].reduce((sum, record) => sum + record.assistantChars, 0),
      })),
    },
    humanReview: {
      rubric: "tests/context-memory/continuity/rubric.md",
      digest: pins.fixtures.rubricDigest,
      noLlmJudge: true,
      secondHumanForAmbiguousSevere: true,
      escalation: "ambiguous severe classifications escalate to a second human reviewer and stay blocked until resolved",
    },
  };
  return report;
}

function reportMarkdown(report) {
  const lines = [];
  lines.push(`# Context Memory continuity qualification (#224) — ${report.mode}`);
  lines.push("");
  lines.push(`result: **${report.result.toUpperCase()}** — ${report.totals.runs} runs, ${report.totals.turns} turns, ${report.totals.failed} failed runs, 0 waivers, 0 retries`);
  lines.push("");
  lines.push(`adapter: ${report.adapter} · mode ${report.mode}${report.releaseRelevant ? "" : " (not release-relevant)"}`);
  lines.push(`pins: implementation \`${short(report.pins.implementation.commit)}\` digest \`${short(report.pins.implementation.digest)}\`${report.pins.implementation.dirty ? " (dirty)" : ""} · package ${report.pins.package.name}@${report.pins.package.version} · pi ${report.pins.pi.running} (supported ${report.pins.pi.supported}) · fixtures digest \`${short(report.pins.fixtures.digest)}\` · pins digest \`${short(report.pins.pinsDigest)}\``);
  lines.push("");
  lines.push("## Gates");
  lines.push("");
  lines.push(`- severe failures: ${report.gates.severeFailures.total} (${SEVERE_CLASSES.map((klass) => `${klass} ${report.severeClasses[klass]}`).join(", ")})`);
  lines.push(`- critical recall: ${pct(report.gates.criticalRecall)} (required 100%)`);
  lines.push(`- continuity recall overall: ${pct(report.gates.continuityRecallOverall)} (required ≥ 85%)`);
  lines.push(`- continuity recall per scenario: ${Object.entries(report.gates.continuityRecallPerScenario).map(([scenario, value]) => `${scenario} ${pct(value)}`).join(", ")} (each required ≥ 75%)`);
  lines.push(`- canonical final tasks: ${report.gates.canonicalFinalTasks.passed}/${report.gates.canonicalFinalTasks.total}`);
  lines.push(`- compression schedules complete: ${report.gates.scheduleComplete.valid}/${report.gates.scheduleComplete.total}`);
  lines.push(`- hard-check failures: ${report.gates.hardChecks.failed}`);
  lines.push("");
  lines.push("## Runs");
  lines.push("");
  lines.push("| run | arm | turns | appends | rebuilds | critical | continuity | final | ok |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const run of report.runs) {
    lines.push(`| ${run.run} | ${run.arm} | ${run.turns} | ${run.schedule.appends} | ${run.schedule.rebuilds} | ${pct(run.criticalRecall)} | ${pct(run.continuityRecall)} | ${run.finalTask ? "yes" : "no"} | ${run.ok ? "yes" : "no"} |`);
  }
  lines.push("");
  if (report.failures.length === 0) {
    lines.push("failures: none");
  } else {
    lines.push("## Failures");
    lines.push("");
    for (const failure of report.failures) {
      lines.push(`- [${failure.run}] ${failure.id} (${failure.class}): ${failure.message}`);
    }
    if (report.failuresTruncated) lines.push(`- … failure list capped at ${FAILURE_LIST_CAP}; see the JSON report`);
  }
  lines.push(`human review: ${report.humanReview.rubric} (digest \`${short(report.humanReview.digest)}\`) — no LLM judge; ambiguous severe cases require a second human`);
  lines.push("");
  return lines.join("\n");
}

function short(value) {
  return value === null || value === undefined ? "unknown" : String(value).slice(0, 12);
}

function pct(value) {
  return `${Math.round(value * 10_000) / 100}%`;
}

// ─── The qualification entry point ─────────────────────────────────

/**
 * Execute the complete matrix through one adapter and write the bounded
 * report. Every execution appends one line to `attempts.jsonl` — the audit
 * trail that makes favorable rerun selection visible: re-running the same
 * pins cannot silently replace an earlier failed verdict.
 */
export async function runQualification({ adapter, reportDir, salt = DEFAULT_MATRIX_SALT, mode = "dry-run" }) {
  const normalized = normalizeAdapter(adapter);
  const runs = planRuns({ salt });
  const pins = pinEnvironment({ adapterDeclaration: normalized.declaration, salt });
  const runScores = [];
  const evidences = [];
  for (const run of runs) {
    const { score, evidence } = await executeRun({ adapter: normalized, run });
    runScores.push(score);
    evidences.push(evidence);
  }

  let report = buildReport({ mode, adapterId: normalized.declaration.id, pins, runScores, evidences });

  // Privacy self-check: the emitted artifact itself must stay body-free.
  let json = JSON.stringify(report, null, 2);
  const leaks = findReportLeaks(json);
  if (leaks.length > 0) {
    report = {
      ...report,
      result: "fail",
      zeroTolerance: { ...report.zeroTolerance, failures: report.zeroTolerance.failures + 1 },
      failures: [
        ...report.failures,
        { run: "qualification-report", id: "report-privacy", class: "fabrication", message: `the report contained ${leaks.join("; ")}` },
      ],
    };
    json = maskLeaks(JSON.stringify(report, null, 2));
  }
  if (reportDir) {
    mkdirSync(reportDir, { recursive: true });
    // The markdown derives from the same report; whatever the self-check
    // caught, both artifacts leave masked.
    const markdown = maskLeaks(reportMarkdown(report));
    writeFileSync(join(reportDir, "continuity-qualification.json"), `${json}\n`);
    writeFileSync(join(reportDir, "continuity-qualification.md"), `${markdown}\n`);
    appendFileSync(join(reportDir, "attempts.jsonl"), `${JSON.stringify({
      generatedAt: report.generatedAt,
      pinsDigest: pins.pinsDigest,
      mode,
      adapter: normalized.declaration.id,
      result: report.result,
      severeFailures: report.zeroTolerance.severeFailures,
      runs: report.totals.runs,
    })}\n`);
  }

  return { report, json, markdown: maskLeaks(reportMarkdown(report)) };
}
