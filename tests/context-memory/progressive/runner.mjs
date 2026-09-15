import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { safeErrorDiagnostic } from "../qualification/diagnostics.mjs";
import { requireThinkingConfiguration } from "../thinking.mjs";
import { CONFIG, runProgressiveSession } from "./session.mjs";
import { createEvidence, digest } from "./evidence.mjs";
import { createTask } from "./task.mjs";
import { createProgressiveReport, reportMarkdown } from "./qualify.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");
const FREEZE_SCHEMA = "pi-square.context-memory/progressive-freeze/1";
const REPORT_SCHEMA = "pi-square.context-memory/progressive-report/1";
export const MODEL_PIN = Object.freeze({ provider: "cpa", id: "deepseek-v4.1-flash", thinkingLevel: "max" });
const MODEL_IDS = [MODEL_PIN.id, "glm-5.3-flash"];
function modelPin(id = MODEL_PIN.id) {
  if (!MODEL_IDS.includes(id)) throw new Error("unsupported progressive model");
  return { ...MODEL_PIN, id };
}
const safe = error => safeErrorDiagnostic(error, { repoRoot: ROOT });

function packageVersion(path) { return JSON.parse(readFileSync(path, "utf8")).version; }
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().filter(key => !/^(?:auth|authorization|credentials?|password|secret|apiKey|accessToken|refreshToken)$/i.test(key) && typeof value[key] !== "function").map(key => [key, stable(value[key])]));
  return value;
}
function same(left, right) { return JSON.stringify(stable(left)) === JSON.stringify(stable(right)); }
function sameDesign(left, right) {
  const select = value => ({ commit: value?.commit, tree: value?.tree, progressiveDigest: value?.progressiveDigest, node: value?.node, packageVersion: value?.packageVersion, piVersion: value?.piVersion,
    model: { provider: value?.model?.provider, id: value?.model?.id }, config: value?.config, thinkingRequested: value?.thinking?.requested });
  return same(select(left), select(right));
}
function git(args) {
  const result = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed`);
  return result.stdout.trim();
}

export function taskDigest() {
  const names = readdirSync(HERE).filter(name => (name.endsWith(".mjs") || name === "README.md") && lstatSync(join(HERE, name)).isFile()).sort();
  const hash = createHash("sha256");
  for (const name of names) hash.update(name).update("\0").update(readFileSync(join(HERE, name))).update("\0");
  return hash.digest("hex");
}
export function createAttempt({ taskFactory = createTask } = {}) {
  const task = taskFactory();
  return { id: randomUUID(), flags: [...task.flags], seedDigest: digest(task.flags.join("\0")), task };
}
export async function resolveRuntime({ runtime, modelId } = {}) {
  const pin = modelPin(modelId);
  const modelRuntime = runtime ?? await ModelRuntime.create({ allowModelNetwork: false, refreshOnCreate: false });
  const configured = modelRuntime.getModel(pin.provider, pin.id);
  if (!configured || configured.provider !== pin.provider || configured.id !== pin.id) throw new Error("required progressive model is unavailable");
  requireThinkingConfiguration(configured, CONFIG.thinkingLevel);
  if (!await modelRuntime.getAuth(configured)) throw new Error("required progressive model authentication is unavailable");
  return { modelRuntime, model: { ...configured, contextWindow: CONFIG.contextWindow } };
}
export function environmentPins({ model, modelId = model?.id } = {}) {
  if (git(["status", "--porcelain=v1", "--untracked-files=all"]) !== "") throw new Error("real progressive runs require a clean checkout");
  const pin = modelPin(modelId);
  if (model && (model.provider !== pin.provider || model.id !== pin.id)) throw new Error("progressive model does not match selected model");
  const effectiveModel = stable(model ?? pin);
  return {
    commit: git(["rev-parse", "HEAD"]), tree: git(["rev-parse", "HEAD^{tree}"]), progressiveDigest: taskDigest(),
    node: process.version, packageVersion: packageVersion(join(ROOT, "package.json")),
    piVersion: packageVersion(join(ROOT, "node_modules/@earendil-works/pi-coding-agent/package.json")),
    model: { provider: pin.provider, id: pin.id, api: effectiveModel.api ?? null },
    modelConfigurationSha256: digest(effectiveModel),
    thinking: { requested: CONFIG.thinkingLevel, generationValue: effectiveModel.thinkingLevelMap?.[CONFIG.thinkingLevel] ?? null, mapping: effectiveModel.thinkingLevelMap ?? null },
    config: CONFIG,
  };
}
function createPrivateDirectory(path) {
  mkdirSync(path, { mode: 0o700 });
  if (realpathSync(path) !== resolve(path) || !lstatSync(path).isDirectory()) throw new Error("attempt path must be a new real directory");
}
function writeSeed(directory, attempt) {
  const fd = openSync(join(directory, "seed.json"), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, `${JSON.stringify({ id: attempt.id, flags: attempt.flags })}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  const dir = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(dir); } finally { closeSync(dir); }
}
function writeExclusivePrivate(path, text) {
  const parent = dirname(resolve(path));
  if (realpathSync(parent) !== parent || !lstatSync(parent).isDirectory()) throw new Error("output parent must be a real directory without symlinks");
  const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
  const dir = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(dir); } finally { closeSync(dir); }
}
function failedArm(arm, error) { return { arm, status: "infrastructure-error", stages: [], recall: null, coverage: null, metrics: null, evidence: null, diagnostic: safe(error) }; }

export async function runPair({ directory, attempt = createAttempt(), modelRuntime, model, sessionRunner = runProgressiveSession, signal, onEvent = () => {} }) {
  createPrivateDirectory(directory);
  writeSeed(directory, attempt);
  const journal = createEvidence(join(directory, "journal"));
  journal.append("attempt-start", { id: attempt.id, seedDigest: attempt.seedDigest, taskDigest: taskDigest() });
  const invoke = arm => Promise.resolve().then(() => {
    journal.append("arm-start", { arm }); onEvent({ arm, kind: "arm-start" });
    return sessionRunner({ directory: join(directory, arm), arm, task: createTask({ flags: attempt.flags }), model, modelRuntime, signal,
      onEvent(event) { journal.append("session-event", event); onEvent(event); } });
  });
  const settled = await Promise.allSettled([invoke("memory"), invoke("native")]);
  const arms = Object.fromEntries(["memory", "native"].map((arm, index) => [arm, settled[index].status === "fulfilled" ? settled[index].value : failedArm(arm, settled[index].reason)]));
  let journalEvidence = null, problem = null;
  try { journal.append("attempt-end", { statuses: Object.fromEntries(Object.entries(arms).map(([arm, value]) => [arm, value.status])) }); journalEvidence = journal.close(); }
  catch (error) { problem = safe(error); try { journal.close(); } catch { /* the first safe diagnostic is retained */ } }
  return { id: attempt.id, seedDigest: attempt.seedDigest, taskDigest: taskDigest(), arms, journal: journalEvidence, problem };
}
export async function runFormal({ directory, excludedSeedDigests = [], ...options }) {
  createPrivateDirectory(directory);
  const pairs = [];
  for (let index = 0; index < 3; index += 1) {
    let attempt;
    do { attempt = createAttempt(); } while (excludedSeedDigests.includes(attempt.seedDigest) || pairs.some(pair => pair.seedDigest === attempt.seedDigest));
    try { pairs.push(await runPair({ ...options, directory: join(directory, `pair-${index + 1}`), attempt })); }
    catch (error) { pairs.push({ id: attempt.id, seedDigest: attempt.seedDigest, taskDigest: taskDigest(), journal: null, problem: safe(error), arms: { memory: failedArm("memory", error), native: failedArm("native", error) } }); }
  }
  return pairs;
}
function validatePilotReport(report) {
  const pair = report?.pairs?.[0];
  const pins = report?.pins;
  if (report?.schema !== REPORT_SCHEMA || report.kind !== "pilot" || !Array.isArray(report.pairs) || report.pairs.length !== 1
    || typeof pair?.id !== "string" || !/^[a-f0-9]{64}$/.test(pair?.seedDigest ?? "") || pair?.taskDigest !== pins?.progressiveDigest
    || !pair?.arms?.memory || !pair?.arms?.native || typeof pair.arms.memory.status !== "string" || typeof pair.arms.native.status !== "string"
    || report.totals?.pairs !== 1 || report.totals?.arms !== 2 || typeof report.totals?.result !== "string"
    || !/^[a-f0-9]{40}$/.test(pins?.commit ?? "") || !/^[a-f0-9]{40}$/.test(pins?.tree ?? "") || !/^[a-f0-9]{64}$/.test(pins?.progressiveDigest ?? "")
    || !/^[a-f0-9]{64}$/.test(pins?.modelConfigurationSha256 ?? "") || typeof pins?.piVersion !== "string" || pins?.model?.provider !== MODEL_PIN.provider || !MODEL_IDS.includes(pins?.model?.id)
    || pins?.thinking?.requested !== CONFIG.thinkingLevel || pins?.thinking?.generationValue == null || !pins?.thinking?.mapping) {
    throw new Error("pilot report is not a complete one-pair progressive pilot report");
  }
  return report;
}
export function freezePilot({ pilotReport, pins, path }) {
  const report = validatePilotReport(pilotReport);
  if (!sameDesign(report.pins, pins)) throw new Error("pilot report pins do not match the current checkout");
  const manifest = { schema: FREEZE_SCHEMA, pilot: { id: report.pairs[0].id, seedDigest: report.pairs[0].seedDigest, taskDigest: report.pairs[0].taskDigest }, pins: report.pins, frozenAt: new Date().toISOString() };
  writeExclusivePrivate(path, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}
export function requireFreeze(path, pins, { allowUnresolvedModel = false } = {}) {
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  if (manifest?.schema !== FREEZE_SCHEMA || typeof manifest.pilot?.id !== "string" || typeof manifest.pilot?.seedDigest !== "string" || manifest.pilot?.taskDigest !== pins.progressiveDigest || !(allowUnresolvedModel ? sameDesign(manifest.pins, pins) : same(manifest.pins, pins))) throw new Error("freeze manifest does not match the current progressive design");
  return manifest;
}
function writePublic(directory, report) {
  writeExclusivePrivate(join(directory, "public-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  writeExclusivePrivate(join(directory, "public-report.md"), reportMarkdown(report));
}
async function cli() {
  const args = process.argv.slice(2);
  const modelOption = args.indexOf("--model");
  const modelId = modelPin(modelOption < 0 ? undefined : args[modelOption + 1]).id;
  if (modelOption >= 0) {
    if (!args[modelOption + 1]) throw new Error("--model requires an exact model ID");
    args.splice(modelOption, 2);
  }
  if (args[0] === "--freeze-pilot") {
    if (!args[1] || args[2] !== "--output" || !args[3] || args.length !== 4) throw new Error("usage: runner.mjs --freeze-pilot <pilot-report.json> --output <manifest.json>");
    const report = JSON.parse(readFileSync(args[1], "utf8"));
    freezePilot({ pilotReport: report, pins: environmentPins({ modelId }), path: args[3] }); return;
  }
  if (args[0] !== "--real" || !["--pilot", "--formal"].includes(args[1]) || (args[1] === "--formal" && (args[2] !== "--freeze-pilot" || !args[3] || args.length !== 4)) || (args[1] === "--pilot" && args.length !== 2)) throw new Error("usage: runner.mjs [--model deepseek-v4.1-flash|glm-5.3-flash] --real --pilot | --real --formal --freeze-pilot <manifest>");
  const preliminaryPins = environmentPins({ modelId });
  const frozen = args[1] === "--formal" ? requireFreeze(args[3], preliminaryPins, { allowUnresolvedModel: true }) : null;
  const resolved = await resolveRuntime({ modelId });
  const pins = environmentPins({ model: resolved.model, modelId });
  if (frozen) requireFreeze(args[3], pins);
  const outputRoot = join(HERE, "private-runs");
  mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
  const output = join(outputRoot, `${args[1].slice(2)}-${Date.now()}-${randomUUID()}`);
  createPrivateDirectory(output);
  const onEvent = event => {
    if (["arm-start", "stage-start", "flag-issued", "memory-applied", "recall"].includes(event.kind)) {
      process.stderr.write(`${event.arm}: ${event.kind}${event.stage ? ` stage ${event.stage}` : ""}\n`);
    }
  };
  process.stderr.write(`Private experiment directory: ${output}\n`);
  const controller = new AbortController();
  const terminate = () => controller.abort(new Error("terminated"));
  process.once("SIGINT", terminate); process.once("SIGTERM", terminate);
  try {
    const pairs = args[1] === "--pilot" ? [await runPair({ directory: join(output, "pair-1"), ...resolved, signal: controller.signal, onEvent })] : await runFormal({ directory: join(output, "formal"), ...resolved, signal: controller.signal, onEvent, excludedSeedDigests: [frozen.pilot.seedDigest] });
    const report = createProgressiveReport({ kind: args[1].slice(2), pairs, manifest: frozen, pins });
    writePublic(output, report); process.stdout.write(`${relative(ROOT, join(output, "public-report.json"))}\n`);
  } finally { process.removeListener("SIGINT", terminate); process.removeListener("SIGTERM", terminate); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await cli();
