import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { fileURLToPath } from "node:url";
import jiti from "jiti";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const load = jiti(import.meta.url, { moduleCache: false });
const backgroundModule = await load(join(packageRoot, "src", "subagents", "background.ts"));
const statusModule = await load(join(packageRoot, "src", "subagents", "status.ts"));
const {
  SUBAGENT_STATUS_KEY,
  createNativeSubagentStatusController,
  renderNativeSubagentStatus,
} = statusModule;
const { createBackgroundState } = backgroundModule;
const tests = [];

function test(name, fn) { tests.push({ name, fn }); }

function plainTheme() {
  return {
    fg(_color, text) { return String(text); },
    bg(_color, text) { return String(text); },
    bold(text) { return String(text); },
  };
}

function ansiTheme() {
  return {
    fg(_color, text) { return `\u001b[36m${String(text)}\u001b[39m`; },
    bg(_color, text) { return String(text); },
    bold(text) { return String(text); },
  };
}

function job(id, status, createdAt, name, timeline = []) {
  return {
    id,
    status,
    createdAt,
    updatedAt: createdAt,
    abortController: new AbortController(),
    details: {
      startedAt: createdAt,
      agent: { name },
      timeline,
    },
  };
}

function toolTimeline(call, result = "SECRET TOOL RESULT") {
  return [
    { kind: "tool", phase: "start", text: call },
    { kind: "tool", phase: "end", text: result },
  ];
}

test("native status prioritizes active jobs and exposes no tool results", () => {
  const jobs = [
    job("subagent_11111111-1111-4111-8111-111111111111", "queued", 1, "crawler", toolTimeline("search docs")),
    job("subagent_22222222-2222-4222-8222-222222222222", "running", 2, "explorer", toolTimeline("rg token in src")),
    job("subagent_33333333-3333-4333-8333-333333333333", "cancelling", 3, "oracle", toolTimeline("read Authorization: Bearer exposed-token")),
    job("subagent_44444444-4444-4444-8444-444444444444", "completed", 0, "generalist", toolTimeline("write output")),
  ];

  const rendered = renderNativeSubagentStatus(plainTheme(), jobs);
  assert.match(rendered, /^subagents 3 │ oracle 33333333 × cancelling · /);
  assert.match(rendered, /explorer 22222222 ● running · rg token in src/);
  assert.match(rendered, /│ \+1$/);
  assert.doesNotMatch(rendered, /crawler|generalist|SECRET TOOL RESULT|exposed-token/);
  assert.match(rendered, /Authorization: \[REDACTED\]/);
  assert.equal(renderNativeSubagentStatus(plainTheme(), [{ ...jobs[0], status: "completed" }]), undefined);
});

test("native status keeps undelivered results visible without any active job", () => {
  const jobs = [
    job("subagent_55555555-5555-4555-8555-555555555555", "completed", 0, "explorer", toolTimeline("read file")),
  ];

  assert.equal(renderNativeSubagentStatus(plainTheme(), jobs), undefined);
  assert.match(renderNativeSubagentStatus(plainTheme(), jobs, 3), /^undelivered 3$/);
  assert.match(
    renderNativeSubagentStatus(plainTheme(), [{ ...jobs[0], status: "running" }], 2),
    /^subagents 1 │ .* │ undelivered 2$/,
  );
});

test("native status bounds unicode-safe visible output and strips controls", () => {
  const longCall = `read ${"界".repeat(100)}\npassword=private-value`;
  const jobs = [
    job("subagent_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "running", 1, "explorer\u001b[31m", toolTimeline(longCall)),
    job("subagent_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "running", 2, "oracle", toolTimeline(longCall)),
  ];

  const rendered = renderNativeSubagentStatus(ansiTheme(), jobs);
  const plain = stripVTControlCharacters(rendered);
  assert.ok(Array.from(plain).length <= 180);
  assert.doesNotMatch(plain, /\r|\n|\t|\u001b/);
  assert.doesNotMatch(plain, /private-value/);
  assert.match(plain, /界+\.\.\./);
});

test("controller follows background changes and clears the native status", () => {
  const state = createBackgroundState();
  const calls = [];
  const ctx = {
    hasUI: true,
    ui: {
      theme: plainTheme(),
      setStatus(key, value) { calls.push({ key, value }); },
    },
  };
  const controller = createNativeSubagentStatusController(state);

  controller.start(ctx);
  assert.deepEqual(calls.at(-1), { key: SUBAGENT_STATUS_KEY, value: undefined });
  const running = job(
    "subagent_cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    "running",
    1,
    "generalist",
    toolTimeline("edit src/index.ts"),
  );
  state.jobs.set(running.id, running);
  for (const listener of state.listeners) listener();
  assert.match(calls.at(-1).value, /generalist cccccccc ● running · edit src\/index\.ts/);

  running.status = "done";
  for (const listener of state.listeners) listener();
  assert.deepEqual(calls.at(-1), { key: SUBAGENT_STATUS_KEY, value: undefined });
  controller.stop();
  assert.equal(state.listeners.size, 0);
  assert.deepEqual(calls.at(-1), { key: SUBAGENT_STATUS_KEY, value: undefined });
});

test("controller does not subscribe to motion (static markers)", () => {
  const state = createBackgroundState();
  const calls = [];
  const controller = createNativeSubagentStatusController(state);
  controller.start({
    hasUI: true,
    ui: { theme: plainTheme(), setStatus(_key, value) { calls.push(value); } },
  });
  const running = job(
    "subagent_ffffffff-ffff-4fff-8fff-ffffffffffff",
    "running",
    1,
    "explorer",
    toolTimeline("rg display in src"),
  );
  state.jobs.set(running.id, running);
  for (const listener of state.listeners) listener();
  assert.match(calls.at(-1), /● running/);
  running.status = "done";
  for (const listener of state.listeners) listener();
  assert.deepEqual(calls.at(-1), undefined);
  controller.stop();
});

test("controller never touches UI for non-interactive sessions", () => {
  const state = createBackgroundState();
  const controller = createNativeSubagentStatusController(state);
  controller.start({ hasUI: false });
  assert.equal(state.listeners.size, 0);
  controller.refresh();
  controller.stop();
});

test("running status uses accent tone and operational bullet marker", () => {
  const calls = [];
  const trackingTheme = {
    fg(color, text) { calls.push({ color, text: String(text) }); return String(text); },
    bg(_c, t) { return String(t); },
    bold(t) { return String(t); },
  };
  const jobs = [
    job("subagent_accent000-0000-4000-8000-accent00000000", "running", 1, "explorer", toolTimeline("rg data")),
  ];
  renderNativeSubagentStatus(trackingTheme, jobs);
  const runningCall = calls.find((c) => c.text === "● running");
  assert.ok(runningCall, "bullet running marker present");
  assert.equal(runningCall.color, "accent", "running marker uses accent tone");
});

test("cancelling status outranks running in the status text", () => {
  const jobs = [
    job("subagent_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "running", 1, "explorer", toolTimeline("rg data")),
    job("subagent_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "cancelling", 2, "oracle", toolTimeline("read file")),
  ];
  const rendered = renderNativeSubagentStatus(plainTheme(), jobs);
  const cancellingPos = rendered.indexOf("oracle");
  const runningPos = rendered.indexOf("explorer");
  assert.ok(cancellingPos < runningPos, "cancelling job appears before running job");
  assert.match(rendered, /× cancelling/);
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`PASS: ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL: ${name} — ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  }
}
console.log(`\n${tests.length} tests, ${failed} failed`);
if (failed > 0) process.exit(1);
