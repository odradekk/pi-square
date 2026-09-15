import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTask } from "./task.mjs";
import { referenceCliSource } from "./reference-fixture.mjs";

const flags = ["namespace-random-001", "profile-random-002", "policy-random-003", "routing-random-004", "checkpoint-random-005", "recovery-random-006", "audit-random-007", "delivery-random-008"];
const task = createTask({ flags });
const stageNames = ["Data ingestion and normalization", "Data validation", "Deduplication and conflict handling", "Partition routing", "Incremental processing and checkpoints", "Failure recovery", "Audit and consistency checks", "Integrated delivery"];
assert.deepEqual(task.flags, flags);
assert.equal(new Set(task.flags).size, 8);
assert.equal(task.openingPrompt.includes(flags[0]), false);
assert.equal(Object.values(task.setupFiles).some((text) => flags.some((flag) => text.includes(flag))), false);
for (let stage = 1; stage <= 8; stage += 1) {
  const prompt = task.prompt(stage);
  assert.match(prompt, /Implement/);
  for (const flag of flags) assert.equal(prompt.includes(flag), false, `stage ${stage} prompt leaked a flag`);
  for (const name of stageNames.slice(stage)) assert.equal(prompt.includes(name), false, `stage ${stage} prompt revealed future work`);
}
assert.throws(() => task.prompt(0), /stage/);
assert.throws(() => createTask({ flags: ["too-short"] }), /eight/);

const root = mkdtempSync(join(tmpdir(), "pi-square-progressive-"));
const cli = join(root, "cli.mjs");
writeFileSync(cli, referenceCliSource(flags));

function execute(input, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli], { stdio: ["pipe", "pipe", "pipe"] }); let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject); child.once("close", (exitCode) => resolve({ stdout, stderr, exitCode }));
    signal?.addEventListener("abort", () => child.kill(), { once: true }); child.stdin.end(JSON.stringify(input));
  });
}
for (let stage = 1; stage <= 8; stage += 1) assert.deepEqual(await task.verify(stage, execute), { ok: true, failures: [] }, `cumulative stage ${stage}`);

const reordered = await task.verify(1, async (input) => {
  const result = await execute(input); if (result.exitCode !== 0) return result;
  const reverse = (value) => Array.isArray(value) ? value.map(reverse) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reverse(child)])) : value;
  return { ...result, stdout: JSON.stringify(reverse(JSON.parse(result.stdout))) };
});
assert.equal(reordered.ok, true, "JSON object key order is not part of the contract");

const seen = [];
const failed = await task.verify(3, async (input) => { seen.push(input); return { stdout: JSON.stringify({ forged: flags[0] }), stderr: flags.join(" "), exitCode: 0 }; });
assert.equal(failed.ok, false);
assert.deepEqual(failed.failures.map((failure) => failure.behavior), ["normalization", "validation", "deduplication"]);
assert.equal(JSON.stringify(failed).includes(flags[0]), false, "untrusted output never enters diagnostics");
assert.equal(seen.length, 3);
assert.equal(JSON.stringify(seen).includes(flags[0]), false, "verifier never supplies flags to the CLI");

const wrongNamespace = await task.verify(2, async (input) => input.command === "normalize"
  ? execute(input)
  : { stdout: JSON.stringify({ namespace: "guessed", valid: true, errors: [] }), stderr: "", exitCode: 0 });
assert.deepEqual(wrongNamespace.failures, [{ stage: 2, case: 1, behavior: "validation", sourceStage: 1, fieldPath: "output.namespace", expected: "project constant from the named source stage" }]);
assert.equal(JSON.stringify(wrongNamespace).includes(flags[0]), false, "wrong flag diagnostics mask expected values");

const extraRouteRecord = await task.verify(4, async (input) => {
  const result = await execute(input);
  if (input.command !== "route" || result.exitCode !== 0) return result;
  const output = JSON.parse(result.stdout);
  output.partitions.primary.push({ id: "extra" });
  return { ...result, stdout: JSON.stringify(output) };
});
assert.deepEqual(extraRouteRecord.failures.at(-1), { stage: 4, case: 1, behavior: "routing", sourceStage: null,
  fieldPath: "output.partitions.primary", expectedLength: 2, actualLength: 3, firstExtraIndex: 2 });
for (const flag of flags) assert.equal(JSON.stringify(extraRouteRecord.failures).includes(flag), false, "array-size diagnostics never disclose flags or element values");

const malformedObject = await task.verify(8, async () => ({ stdout: "null", stderr: "", exitCode: 0 }));
for (const flag of flags) assert.equal(JSON.stringify(malformedObject).includes(flag), false, "a wrong-shaped answer must not disclose an entire expected object containing flags");

const controller = new AbortController(); controller.abort();
await assert.rejects(task.verify(1, async () => { const error = new Error("stopped"); error.name = "AbortError"; throw error; }, controller.signal), /stopped/);
await assert.rejects(task.verify(1, async () => { const error = new Error("sandbox unavailable"); error.name = "SandboxError"; throw error; }), /sandbox unavailable/);
rmSync(root, { recursive: true, force: true });
console.log("context-memory progressive task: ok");
