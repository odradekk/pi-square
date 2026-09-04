import assert from "node:assert/strict";

import {
  createPiStub,
  createPromptSnapshot,
  getRunSubagentTaskCalls,
  loadBackgroundModule,
  loadDeliveryModule,
  run,
  setRunSubagentTaskMock,
  test,
  waitFor,
} from "./lib/test-helpers.mjs";

const {
  cancelBackgroundJobs,
  createBackgroundState,
  createQueuedJob,
  createQueuedResumeJob,
  formatBackgroundIndicator,
  startBackgroundJob,
  startBackgroundResumeJob,
} = await loadBackgroundModule();
const { createDeliveryController } = await loadDeliveryModule();

const ID = "subagent_00000000-0000-4000-8000-000000000021";

function usage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

function details(phase = "running", overrides = {}) {
  return {
    version: 3,
    id: ID,
    mode: "bg",
    artifactsDir: `/tmp/subagents/${ID}`,
    sessionFile: `/tmp/subagents/${ID}/session.jsonl`,
    sessionId: "native-session",
    originParentSessionId: "parent-session",
    lastParentSessionId: "parent-session",
    promptSnapshot: createPromptSnapshot(),
    phase,
    task: "smoke task",
    cwd: "/tmp/subagents",
    startedAt: 10,
    finalText: phase === "done" ? "ACK" : "",
    retries: 0,
    toolErrors: [],
    usage: usage(),
    timeline: [{ kind: "status", text: "partial update" }],
    ...overrides,
  };
}

function observedState() {
  const state = createBackgroundState();
  let changes = 0;
  state.onChange = () => { changes += 1; };
  return { state, changes: () => changes, reset: () => { changes = 0; } };
}

function assertCompletion(pi, status) {
  assert.equal(pi.sent.length, 1);
  assert.equal(pi.sent[0].message.customType, "pi-square.subagent-notification");
  assert.equal(pi.sent[0].message.display, true);
  assert.equal(pi.sent[0].message.details.version, 4);
  assert.equal(pi.sent[0].message.details.resent, false);
  assert.equal(pi.sent[0].message.details.results.length, 1);
  assert.equal(pi.sent[0].message.details.results[0].id, ID);
  assert.equal(pi.sent[0].message.details.results[0].status, status);
  assert.equal(pi.sent[0].message.details.results[0].result.id, ID);
  assert.match(pi.sent[0].message.content, new RegExp(`^\\[Background subagent ${status}\\]`));
  assert.deepEqual(pi.sent[0].options, {
    triggerTurn: true,
    deliverAs: "steer",
  });
}

function queuedJob(observed) {
  return createQueuedJob({
    state: observed.state,
    id: ID,
    task: "smoke task",
    cwd: "/tmp/subagents",
    definition: {
      promptVersion: 2,
      name: "worker",
      model: "gpt-test",
      effort: "low",
      description: "smoke",
      inheritParentSystem: true,
      visible: true,
      source: "agent",
      filePath: "worker.yaml",
      fieldSources: {},
      layers: [],
      tools: [],
      skills: [],
    },
    parentSessionId: "parent-session",
    promptSnapshot: createPromptSnapshot(),
  });
}

test("queue insertion stores the unified public id and emits", () => {
  process.env.PI_AGENT_DIR = "/tmp/subagents-test-agent";
  const observed = observedState();
  const job = queuedJob(observed);
  assert.equal(observed.changes(), 1);
  assert.equal(job.id, ID);
  assert.equal(job.details.id, ID);
  assert.equal(job.details.mode, "bg");
  assert.equal(observed.state.jobs.get(ID), job);
});

test("background indicator uses compact text without emoji presentation glyphs", () => {
  process.env.PI_AGENT_DIR = "/tmp/subagents-test-agent";
  const observed = observedState();
  const job = queuedJob(observed);
  assert.equal(formatBackgroundIndicator(observed.state), "queued 1");
  job.status = "running";
  assert.equal(formatBackgroundIndicator(observed.state), "running 1");
  job.status = "aborted";
  assert.equal(formatBackgroundIndicator(observed.state), "× 1");
  assert.doesNotMatch(formatBackgroundIndicator(observed.state), /[⌛⏳◐◌\uFE0F]/u);
});

test("cancelBackgroundJobs accepts the public id", () => {
  process.env.PI_AGENT_DIR = "/tmp/subagents-test-agent";
  const observed = observedState();
  const job = queuedJob(observed);
  observed.reset();
  const result = cancelBackgroundJobs({ state: observed.state, id: ID, reason: "Stop now." });
  assert.equal(result.canceled[0].id, ID);
  assert.equal(job.status, "aborted");
  assert.equal(job.details.phase, "aborted");
  assert.equal(observed.changes(), 1);
});

test("running cancellation remains resumable and exposes a real cancelling transition", async () => {
  process.env.PI_AGENT_DIR = "/tmp/subagents-test-agent";
  const observed = observedState();
  const job = queuedJob(observed);
  setRunSubagentTaskMock(async (input) => {
    await new Promise((resolve) => input.signal.addEventListener("abort", resolve, { once: true }));
    return { content: "aborted", details: details("aborted", { error: "Canceled from manager." }) };
  });
  const pi = createPiStub();
  startBackgroundJob({ pi: pi.api, state: observed.state, job, ctx: {}, task: "smoke task", parentSessionId: "parent-session" });
  await waitFor(() => job.status === "running", "running background job");
  const canceled = cancelBackgroundJobs({ state: observed.state, id: ID, reason: "Canceled from manager." });
  assert.equal(canceled.canceled[0].status, "cancelling");
  assert.equal(job.details.phase, "cancelling");
  await waitFor(() => job.status === "aborted", "aborted background job");
  assert.equal(job.details.phase, "aborted");
  assert.equal(job.details.id, ID);
  assert.equal(pi.sent.length, 0);
});

test("pre-aborted jobs never invoke the child", async () => {
  process.env.PI_AGENT_DIR = "/tmp/subagents-test-agent";
  const observed = observedState();
  const job = queuedJob(observed);
  observed.reset();
  job.status = "aborted";
  job.abortController.abort();
  setRunSubagentTaskMock(async () => { throw new Error("must not execute"); });

  const pi = createPiStub();
  startBackgroundJob({ pi: pi.api, state: observed.state, job, ctx: {}, task: "smoke task", parentSessionId: "parent-session" });
  await waitFor(() => job.details.errorInfo?.code === "ABORTED", "pre-aborted cleanup");
  assert.equal(getRunSubagentTaskCalls().length, 0);
  assert.equal(observed.changes(), 1);
  assert.equal(pi.sent.length, 0);
});

test("running, partial, and final transitions preserve one id", async () => {
  process.env.PI_AGENT_DIR = "/tmp/subagents-test-agent";
  const observed = observedState();
  const job = queuedJob(observed);
  observed.reset();
  const pi = createPiStub();
  setRunSubagentTaskMock(async (input) => {
    input.onUpdate(details("running"));
    return { details: details("done", { endedAt: 20, durationMs: 10 }) };
  });

  const contextMessages = [{ role: "user", text: "parent context" }];
  startBackgroundJob({ pi: pi.api, state: observed.state, job, ctx: {}, task: "smoke task", parentSessionId: "parent-session", contextMessages });
  await waitFor(() => job.status === "done", "done background job");
  // running, partial, final, and one change for the pending delivery set.
  assert.equal(observed.changes(), 4);
  assert.equal(getRunSubagentTaskCalls()[0].id, ID);
  assert.deepEqual(getRunSubagentTaskCalls()[0].contextMessages, contextMessages);
  assert.equal(job.details.id, ID);
  assertCompletion(pi, "done");
});

test("manager resumes use the cancellable background lifecycle and frozen snapshot", async () => {
  process.env.PI_AGENT_DIR = "/tmp/subagents-test-agent";
  const observed = observedState();
  const persisted = details("done", { finalText: "first", promptSnapshot: createPromptSnapshot() });
  const job = createQueuedResumeJob({
    state: observed.state,
    details: persisted,
    task: "continue",
    parentSessionId: "parent-session",
  });
  const pi = createPiStub();
  setRunSubagentTaskMock(async (input) => {
    assert.equal(input.id, ID);
    assert.equal(input.task, "continue");
    input.onUpdate(details("running", { mode: "resume", promptSnapshot: persisted.promptSnapshot }));
    return { details: details("done", { mode: "resume", finalText: "continued", promptSnapshot: persisted.promptSnapshot }) };
  });

  startBackgroundResumeJob({ pi: pi.api, state: observed.state, job, ctx: {}, task: "continue", parentSessionId: "parent-session" });
  await waitFor(() => job.status === "done", "done background resume");
  assert.equal(job.details.mode, "resume");
  assert.equal(job.details.promptSnapshot, persisted.promptSnapshot);
  assertCompletion(pi, "done");
});

test("thrown background failures become structured run failures", async () => {
  process.env.PI_AGENT_DIR = "/tmp/subagents-test-agent";
  const observed = observedState();
  const job = queuedJob(observed);
  observed.reset();
  const pi = createPiStub();
  setRunSubagentTaskMock(async () => { throw new Error("synthetic failure"); });

  startBackgroundJob({ pi: pi.api, state: observed.state, job, ctx: {}, task: "smoke task", parentSessionId: "parent-session" });
  await waitFor(() => job.status === "error", "error background job");
  assert.equal(job.details.errorInfo.code, "SUBAGENT_FAILED");
  assert.match(job.details.error, /synthetic failure/);
  assertCompletion(pi, "error");
});

test("undelivered results survive job compaction and stay visible in the indicator", async () => {
  process.env.PI_AGENT_DIR = "/tmp/subagents-test-agent";
  const observed = observedState();
  const pi = createPiStub();
  // A parent that never becomes idle keeps every completion pending, which is
  // the state that job compaction must not destroy.
  observed.state.delivery = createDeliveryController({ pi: pi.api, isIdle: () => false });
  setRunSubagentTaskMock(async () => ({ content: "ACK", details: details("done", { endedAt: 20, durationMs: 10 }) }));

  const total = 22;
  for (let index = 0; index < total; index += 1) {
    const id = `subagent_00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
    const job = createQueuedJob({
      state: observed.state,
      id,
      task: "smoke task",
      cwd: "/tmp/subagents",
      parentSessionId: "parent-session",
      promptSnapshot: createPromptSnapshot(),
    });
    startBackgroundJob({ pi: pi.api, state: observed.state, job, ctx: {}, task: "smoke task", parentSessionId: "parent-session" });
  }

  await waitFor(
    () => observed.state.delivery.pendingCount() === total,
    "every completion registered as pending",
  );
  assert.equal(pi.sent.length, 0, "a busy parent receives nothing before a turn boundary");
  assert.equal(observed.state.jobs.size, total, "compaction never drops an undelivered result");
  assert.match(formatBackgroundIndicator(observed.state), /undelivered 22/);

  observed.state.delivery.handleTurnEnd();
  assert.equal(pi.sent.length, 1, "the burst costs one parent turn, not 22");
  assert.equal(pi.sent[0].message.details.results.length, 6);
});

await run();
