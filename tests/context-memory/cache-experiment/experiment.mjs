import { execFileSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  piSessionCachePrompts,
  renderPiSessionMatrix,
  runPiSessionMatrix,
} from "./session-sequence.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, "../../..");
const DEFAULT_REPORT_DIR = join(HERE, "report");
const MODEL_PINS = Object.freeze([
  ["ccr-claude", "claude-sonnet-5"],
  ["cpa", "glm-5.3"],
  ["cpa", "gpt-5.6-luna"],
]);
const USAGE = "usage: npm run experiment:provider-cache [-- --json] [--quiet] [--report-dir <dir>]";

class CacheExperimentError extends Error {}

function parseArgs(argv) {
  const options = { json: false, quiet: false, reportDir: DEFAULT_REPORT_DIR };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") options.json = true;
    else if (argument === "--quiet") options.quiet = true;
    else if (argument === "--report-dir") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new CacheExperimentError("--report-dir requires a directory path");
      options.reportDir = resolve(value);
      index += 1;
    } else if (argument === "--help") {
      console.log(USAGE);
      process.exit(0);
    } else {
      throw new CacheExperimentError(`${USAGE}\nunknown argument: ${argument}`);
    }
  }
  return options;
}

function git(...args) {
  return execFileSync("git", args, {
    cwd: PACKAGE_ROOT,
    encoding: "utf8",
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function provenance() {
  return {
    commit: git("rev-parse", "HEAD"),
    tree: git("rev-parse", "HEAD^{tree}"),
    dirty: git("status", "--porcelain").length > 0,
  };
}

function claimPair(directory, stem, humanText, jsonText) {
  mkdirSync(directory, { recursive: true });
  for (let suffix = 0; suffix < 100; suffix += 1) {
    const candidate = suffix === 0 ? stem : `${stem}-${suffix}`;
    const textPath = join(directory, `${candidate}.txt`);
    const jsonPath = join(directory, `${candidate}.json`);
    let textFd;
    let jsonFd;
    let failure;
    try {
      textFd = openSync(textPath, "wx", 0o600);
      jsonFd = openSync(jsonPath, "wx", 0o600);
      writeFileSync(textFd, `${humanText}\n`, "utf8");
      writeFileSync(jsonFd, `${jsonText}\n`, "utf8");
    } catch (error) {
      failure = error;
    } finally {
      if (textFd !== undefined) closeSync(textFd);
      if (jsonFd !== undefined) closeSync(jsonFd);
    }
    if (failure === undefined) return { textPath, jsonPath };
    if (textFd !== undefined) rmSync(textPath, { force: true });
    if (jsonFd !== undefined) rmSync(jsonPath, { force: true });
    if (failure?.code !== "EEXIST") throw failure;
  }
  throw new Error("could not claim a unique report artifact pair");
}

export async function runRealPiCacheExperiment({
  runtime,
  generatedAt = new Date().toISOString(),
  implementation = provenance(),
} = {}) {
  const modelRuntime = runtime ?? await ModelRuntime.create({ allowModelNetwork: false, refreshOnCreate: false });
  const models = MODEL_PINS.map(([provider, modelId]) => {
    const model = modelRuntime.getModel(provider, modelId);
    if (!model) throw new CacheExperimentError(`Pi model configuration does not define ${provider}/${modelId}`);
    return model;
  });
  const report = await runPiSessionMatrix({
    packageRoot: PACKAGE_ROOT,
    modelRuntime,
    models,
    prompts: piSessionCachePrompts(),
  });
  report.generatedAt = generatedAt;
  report.implementation = implementation;
  return report;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const implementation = provenance();
  if (implementation.dirty) {
    throw new CacheExperimentError("credentialed cache evidence requires a clean working tree tied to one exact commit");
  }
  const report = await runRealPiCacheExperiment({ implementation });
  const humanText = renderPiSessionMatrix(report);
  const jsonText = JSON.stringify(report, null, 2);
  const runId = report.generatedAt.replaceAll(":", "-").replaceAll(".", "-");
  const artifacts = claimPair(options.reportDir, `pi-session-cache-${runId}`, humanText, jsonText);
  if (!options.quiet) console.log(options.json ? jsonText : humanText);
  if (!options.quiet) console.log(`reports: ${artifacts.textPath} ${artifacts.jsonPath}`);
  process.exitCode = report.integrity.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const detail = error instanceof CacheExperimentError
      ? error.message
      : "Pi session or provider request failed; no report was written";
    console.error(`provider-cache experiment failed: ${detail}`);
    process.exitCode = 1;
  });
}
