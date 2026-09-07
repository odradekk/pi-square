import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, rmSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative as relativePath, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fakeClock, simulatedCacheAdapter } from "./fake-provider.mjs";
import { runExperiment } from "./runner.mjs";
import { cacheProgress } from "../progress.mjs";

/**
 * The provider-cache experiment command (#225, adapters from #248):
 *
 *   npm run experiment:provider-cache [-- --dry-run] [--json] [--quiet] [--adapter <adapter-module.mjs>]
 *
 * Dry-run is the default: the simulated prefix-cache adapter and a fake clock,
 * no credential, no network call. Credentialed execution passes
 * `--adapter <module.mjs>` pointing at an adapter implementing the contract
 * validated by `runner.mjs` (see `adapters/cache-provider.mjs`); the command
 * then verifies every exported adapter's declared `requiredEnv` variable
 * *names* are present (never their values) and runs with a real clock. The
 * canonical cache-provider module exports Sonnet 5, GLM 5.3, and GPT-5.6
 * Luna lanes; they run concurrently while every lane's requests remain
 * sequential. `--real` still refuses rather than silently degrading.
 *
 * Auditability (#297 review finding 5): every report records the exact
 * implementation commit it measured (resolved from git at run time, never
 * guessed), and every run writes its own uniquely named
 * `provider-cache-experiment-<mode>-<run-id>` artifact pair under a
 * git-ignored directory beside this file — a dry run can never overwrite a
 * credentialed report, and two credentialed runs never overwrite each other.
 * The report stays bounded and payload-free. Everything under `tests/` stays
 * outside the npm package.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORT_DIR = join(HERE, "report");
const MAX_ADAPTERS = 3;
const USAGE = "usage: npm run experiment:provider-cache [-- --dry-run] [--json] [--quiet] [--report-dir <dir>] [--adapter <adapter-module.mjs>]";

function parseArgs(argv) {
  const options = { json: false, adapterPath: null, quiet: false, reportDir: null };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--dry-run") continue;
    else if (flag === "--json") options.json = true;
    else if (flag === "--quiet") options.quiet = true;
    else if (flag === "--real") {
      console.error(
        "Credentialed execution is #227, which supplies the credentials and the verdict. This command ships the"
          + " adapter module (#248): run it with --adapter <adapter-module.mjs> from the #227 environment,"
          + " or use --dry-run (the default).",
      );
      process.exit(2);
    } else if (flag === "--adapter") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        console.error("--adapter requires a module path");
        process.exit(2);
      }
      options.adapterPath = value;
      index += 1;
    } else if (flag === "--report-dir") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        console.error(`${USAGE}\n--report-dir requires a directory path`);
        process.exit(2);
      }
      options.reportDir = value;
      index += 1;
    } else {
      console.error(`${USAGE}\nunknown argument: ${flag}`);
      process.exit(2);
    }
  }
  return options;
}

export async function loadAdapters(path) {
  const module = await import(pathToFileURL(path).href);
  const adapters = Array.isArray(module.adapters) ? module.adapters : [module.default ?? module.adapter];
  if (adapters.length > MAX_ADAPTERS) {
    throw new Error(`adapter module ${path} may export at most ${MAX_ADAPTERS} adapters`);
  }
  if (adapters.length === 0 || adapters.some((adapter) => !adapter
    || typeof adapter.send !== "function" || typeof adapter.describePins !== "function")) {
    throw new Error(`adapter module ${path} must export an adapter or a non-empty adapters array (see fake-provider.mjs for the contract)`);
  }
  const ids = adapters.map((adapter) => adapter.id);
  if (ids.some((id) => typeof id !== "string" || id.length === 0) || new Set(ids).size !== ids.length) {
    throw new Error(`adapter module ${path} must export adapters with unique non-empty ids`);
  }
  return adapters;
}

function comparisonRow(report) {
  const rate = (arm) => report.cacheStandard.rates[arm].rate;
  const rows = report.groups.flatMap((group) => [
    group.multiblock.prime, group.multiblock.probe,
    group.single.prime, group.single.probe,
    group.nonce.prime, group.nonce.probe,
  ]);
  return {
    provider: report.adapter.provider,
    model: report.adapter.model,
    integrityOk: report.integrity.ok,
    cacheConclusion: report.conclusion.cache,
    finalConclusion: report.conclusion.final,
    reporting: {
      cacheRead: rows.length > 0 && rows.every((row) => row.cacheReadReported ?? row.cacheReported),
      cacheWrite: rows.length > 0 && rows.every((row) => row.cacheWriteReported),
      cost: rows.length > 0 && rows.every((row) => row.costReported),
    },
    hitRate: { multiblock: rate("multiblock"), single: rate("single"), nonce: rate("nonce") },
    probeInputTokenMedian: report.baselineSummary.armMedians.probeInputTokens,
    probeTtftMsMedian: report.baselineSummary.armMedians.probeTtftMs,
  };
}

function renderMatrix(report, laneTexts) {
  const pct = (value) => value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
  const lines = [
    `Concurrent model comparison — ${report.mode}`,
    `execution: ${report.execution.concurrency} model lanes in parallel; prime/probe requests remain sequential inside each lane`,
    "model                         multiblock  single      nonce       conclusion    integrity",
  ];
  for (const row of report.comparison) {
    const name = `${row.provider}/${row.model}`.slice(0, 29).padEnd(29);
    lines.push(
      `${name} ${pct(row.hitRate.multiblock).padEnd(11)} ${pct(row.hitRate.single).padEnd(11)} `
        + `${pct(row.hitRate.nonce).padEnd(11)} ${row.finalConclusion.padEnd(13)} ${row.integrityOk ? "ok" : "FAILED"}`,
    );
  }
  lines.push("comparison note: token counts and TTFT are reported per model; tokenizer, routing, and price differences prevent a provider-neutral cost ranking");
  for (const [index, text] of laneTexts.entries()) {
    lines.push("", `--- lane ${index + 1} ---`, text);
  }
  return lines.join("\n");
}

/** Runs model lanes concurrently while preserving each lane's causal request order. */
export async function runExperimentMatrix({ adapters, generatedAt = () => new Date().toISOString(), runNonce, onEvent, ...options }) {
  if (!Array.isArray(adapters) || adapters.length === 0) throw new Error("at least one adapter is required");
  if (adapters.length > MAX_ADAPTERS) throw new Error(`at most ${MAX_ADAPTERS} adapters may run concurrently`);
  if (adapters.length === 1) {
    return runExperiment({ adapter: adapters[0], generatedAt, runNonce, onEvent, ...options });
  }
  const stamp = generatedAt();
  const sharedNonce = runNonce ?? randomBytes(16).toString("hex");
  const results = await Promise.all(adapters.map((adapter, lane) => runExperiment({
    adapter,
    generatedAt: () => stamp,
    runNonce: sharedNonce,
    onEvent: onEvent === undefined ? undefined : (event) => onEvent({ ...event, lane, provider: adapter.describePins().provider, model: adapter.describePins().model }),
    ...options,
  })));
  const runs = results.map((result) => result.report);
  const report = {
    schema: "pi-square.context-memory/provider-cache-comparison/1",
    generatedAt: stamp,
    mode: runs.every((run) => run.mode === "dry-run") ? "dry-run" : "credentialed",
    framing: {
      disclaimer: "Measured, best-effort observations for the listed provider/model lanes under one pinned fixture; no statistical significance or provider-neutral superiority is claimed.",
      scope: "one concurrent run per listed provider/model; comparisons remain model-specific",
    },
    execution: {
      concurrency: adapters.length,
      schedule: "model lanes run concurrently; requests within each lane run sequentially",
    },
    implementationCommit: options.implementationCommit ?? "unavailable",
    implementationTree: options.implementationTree ?? "unavailable",
    runs,
    comparison: runs.map(comparisonRow),
    integrity: {
      ok: runs.every((run) => run.integrity.ok),
      failedModels: runs.filter((run) => !run.integrity.ok).map((run) => run.adapter.model),
    },
  };
  const humanText = renderMatrix(report, results.map((result) => result.humanText));
  return {
    report,
    humanText,
    json: JSON.stringify(report, null, 2),
    exitCode: report.integrity.ok ? 0 : 1,
  };
}

/**
 * Git environment variables that redirect every git subprocess away from
 * the repository this file lives in (#297 review round 3). They are stripped
 * from every provenance query: a stray `GIT_DIR`/`GIT_WORK_TREE` in the
 * environment must not be able to point the recorded commit, tree, or
 * cleanliness at some other repository.
 */
const GIT_REDIRECT_VARS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CEILING_DIRECTORIES",
];

/**
 * The implementation this process is running from (#297 review finding 5,
 * round 3): the exact commit, its tree digest, and whether the repository
 * carries changes that make the digest unverifiable. A commit that cannot
 * be resolved, a repository root that is not this checkout, or a dirty
 * index or worktree leaves the recorded commit unable to authorize the
 * run's evidence — credentialed runs refuse to start in that state instead
 * of recording evidence no revision can reproduce.
 */
export function resolveImplementation({ env = process.env, exec = execSync } = {}) {
  const cleanEnv = { ...env };
  for (const name of Object.keys(cleanEnv)) {
    if (GIT_REDIRECT_VARS.includes(name) || name === "GIT_CONFIG_PARAMETERS" || name.startsWith("GIT_CONFIG_")) {
      delete cleanEnv[name];
    }
  }
  const git = (args) => exec(`git ${args}`, { cwd: HERE, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: cleanEnv }).trim();
  try {
    const commit = git("rev-parse HEAD");
    const tree = git("rev-parse HEAD^{tree}");
    const root = git("rev-parse --show-toplevel");
    const status = git("status --porcelain --untracked-files=all");
    if (!/^[0-9a-f]{7,40}$/.test(commit) || !/^[0-9a-f]{40}$/.test(tree)) {
      return { commit: null, tree: null, dirty: true };
    }
    // The resolved repository root must actually contain this checkout; a
    // redirect that survived the scrub, or an unexpected worktree layout,
    // makes the provenance untrustworthy.
    const relative = relativePath(resolvePath(root), HERE);
    if (relative.startsWith("..") || isAbsolute(relative)) {
      return { commit: null, tree: null, dirty: true };
    }
    return { commit, tree, dirty: status.length > 0 };
  } catch {
    return { commit: null, tree: null, dirty: true };
  }
}

/** A unique, filesystem-safe run id for one experiment run's artifact pair. */
function runIdOf(generatedAt) {
  return generatedAt.replace(/[:.]/g, "-");
}

/**
 * The final line of every published text artifact: a run is complete iff its
 * txt file ends with this sentinel (#297 review round 3). A crashed or
 * killed process can leave the claimed pair half-written; readers and
 * archival tooling recognize the boundary without trusting file presence.
 */
export const REPORT_COMPLETE_SENTINEL = "report complete";

/**
 * Atomically claims one shared basename for this run's artifact pair
 * (#297 review finding 6, round 3): both files are created exclusively
 * under the same name, so a partial artifact from a crashed run or two
 * concurrent runs can never mismatch or overwrite each other — the loser
 * retries on the next suffix instead. Only `EEXIST` (the name is taken)
 * moves to the next suffix; every other failure — permissions, no space, a
 * removed directory — releases any partial claim and propagates, because
 * retrying a different suffix cannot fix the filesystem and an unbounded
 * retry would hang the run.
 */
export function claimArtifactPair(reportDir, mode, runId) {
  for (let suffix = 1; ; suffix += 1) {
    const base = join(reportDir, `provider-cache-experiment-${mode}-${runId}${suffix > 1 ? `-${suffix}` : ""}`);
    const jsonPath = `${base}.json`;
    const txtPath = `${base}.txt`;
    try {
      closeSync(openSync(jsonPath, "wx"));
    } catch (error) {
      if (error?.code === "EEXIST") continue; // someone holds this basename; next suffix
      throw error;
    }
    try {
      closeSync(openSync(txtPath, "wx"));
    } catch (error) {
      rmSync(jsonPath, { force: true }); // release the partial claim
      if (error?.code === "EEXIST") continue;
      throw error;
    }
    return { jsonPath, txtPath };
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  let adapters;
  let clock;
  if (options.adapterPath !== null) {
    try {
      adapters = await loadAdapters(options.adapterPath);
    } catch (error) {
      console.error(error.message);
      process.exit(2);
    }
    const required = [...new Set(adapters.flatMap((adapter) => adapter.requiredEnv ?? []))];
    const missing = required.filter((name) => !process.env[name]);
    if (missing.length > 0) {
      console.error(`the adapter requires environment variables that are not set: ${missing.join(", ")}`);
      console.error("the command never prints credential values; set them and re-run");
      process.exit(2);
    }
    // `mono()` drives every interval measurement (TTL, TTFT); the wall
    // clock only timestamps. A host clock adjustment can never affect the
    // TTL evidence (#297 review round 3).
    clock = {
      now: Date.now,
      mono: () => performance.now(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    };
  } else {
    clock = fakeClock();
    adapters = [simulatedCacheAdapter({ clock, ttlMs: 300_000 })];
  }
  // Live per-request progress on stderr for the credentialed run; the dry run
  // is instantaneous, and --quiet turns it off entirely.
  const onEvent = options.quiet || options.adapterPath === null ? undefined : cacheProgress();
  const implementation = resolveImplementation();
  if (options.adapterPath !== null && (implementation.commit === null || implementation.dirty)) {
    // #297 review finding 5: a credentialed run must be reproducible from
    // the recorded commit; an unresolvable commit or a dirty repository
    // refuses to run rather than record unverifiable evidence.
    if (implementation.commit === null) {
      console.error("credentialed runs require a resolvable implementation commit (git rev-parse HEAD failed)");
    } else {
      console.error(`credentialed runs require a clean repository (commit ${implementation.commit} has local changes)`);
    }
    process.exit(2);
  }
  // #297 review round 3: the report self-check receives the present
  // credential values, so a provider error body that echoes one still fails
  // the run's integrity instead of reaching the artifact.
  const secretValues = [...new Set(adapters.flatMap((adapter) => adapter.requiredEnv ?? []))]
    .map((name) => process.env[name])
    .filter((value) => typeof value === "string" && value.length >= 3);
  const { json, humanText, exitCode, report } = await runExperimentMatrix({
    adapters,
    clock,
    onEvent,
    secretValues,
    implementationCommit: implementation.commit ?? "unavailable",
    implementationTree: implementation.tree ?? "unavailable",
  });

  const reportDir = options.reportDir ?? REPORT_DIR;
  mkdirSync(reportDir, { recursive: true });
  const runId = runIdOf(report.generatedAt);
  const { jsonPath, txtPath } = claimArtifactPair(reportDir, report.mode, runId);
  // The json publishes first; the txt closes with the completion sentinel so
  // a half-written pair is recognizable as crashed, never mistaken for a
  // finished run.
  writeFileSync(jsonPath, json.endsWith("\n") ? json : `${json}\n`);
  writeFileSync(txtPath, `${humanText}\n${REPORT_COMPLETE_SENTINEL}\n`);
  console.log(humanText);
  console.log(`report: ${jsonPath}`);
  console.log(`implementation commit: ${report.pins?.implementationCommit ?? report.implementationCommit}`);
  if (options.json) console.log(json);
  process.exitCode = exitCode;
}

// The CLI runs only when executed directly; tests import the helpers instead.
if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  await main();
}
