import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import jiti from "jiti";

import {
  createPromptSnapshot,
  getRunSubagentTaskCalls,
  loadBackgroundModule,
  loadDeliveryModule,
  loadToolModule,
  run,
  setRunSubagentTaskMock,
  test,
  waitFor,
} from "./lib/test-helpers.mjs";

const { registerSubagentTool } = await loadToolModule();
const { cancelBackgroundJobs, createBackgroundState, createQueuedJob, notifyBackgroundChange } = await loadBackgroundModule();
const { createDeliveryController } = await loadDeliveryModule();
const loadLocal = jiti(import.meta.url, { moduleCache: false });
const { createSubagentWaitRegistry } = await loadLocal(join(
  import.meta.dirname, "..", "..", "src", "subagents", "wait.ts",
));

const agentRoot = join(tmpdir(), `pi-square-subagent-abort-${process.pid}-${Date.now()}`);
process.env.PI_AGENT_DIR = agentRoot;
mkdirSync(agentRoot, { recursive: true });

const PARENT_SESSION = "parent-session";

function id(n) {
  return `subagent_00000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;
}

function createPiRecorder() {
  const tools = new Map();
  return {
    tools,
    api: {
      registerTool(definition) { tools.set(definition.name, definition); },
      registerMessageRenderer() {},
      registerCommand() {},
      getThinkingLevel() { return "off"; },
    },
  };
}

function createHarness(options = {}) {
  const state = {
    registry: { definitions: [], errors: [], projectDir: null },
    background: createBackgroundState(),
  };
  const pi = createPiRecorder();
  const sent = [];
  let busy = options.busy ?? false;
  const delivery = createDeliveryController({
    pi: { sendMessage(message, opts) { sent.push({ message, opts }); } },
    isIdle: () => !busy,
    notify: () => notifyBackgroundChange(state.background),
  });
  state.background.delivery = delivery;
  const registry = createSubagentWaitRegistry();
  registerSubagentTool(pi.api, state, undefined, registry);
  const abortTool = pi.tools.get("abort_subagent");
  assert.ok(abortTool, "abort_subagent is registered");
  return {
    pi,
    state,
    delivery,
    registry,
    sent,
    abortTool,
    waitTool: pi.tools.get("wait_subagent"),
    setBusy(value) { busy = value; },
    ctx: {
      cwd: "/tmp",
      model: { provider: "test", id: "model" },
      sessionManager: { getSessionId: () => PARENT_SESSION, getBranch: () => [] },
    },
    queue(n, overrides = {}) {
      return createQueuedJob({
        state: state.background,
        id: id(n),
        task: `task-${n}`,
        cwd: "/tmp",
        parentSessionId: PARENT_SESSION,
        promptSnapshot: createPromptSnapshot(),
        ...overrides,
      });
    },
    /** Deterministic terminal transition mirroring the lifecycle's completion
     * path: mutates the job record and enqueues the delivery result. */
    finish(n, status, overrides = {}) {
      const job = state.background.jobs.get(id(n));
      assert.ok(job, `job ${n} exists`);
      job.status = status;
      job.details.phase = status;
      job.details.finalText = overrides.finalText ?? (status === "completed" ? `result-${n}` : "");
      if (status !== "completed") {
        job.details.error = overrides.error ?? `Subagent failed: ${status === "aborted" ? "ABORTED" : "SUBAGENT_FAILED"}\nMessage: ${status}`;
      }
      job.details.endedAt = Date.now();
      delivery.enqueue({ id: job.id, status, details: job.details });
    },
  };
}

function writePersistedRun(publicId) {
  const artifactsDir = join(agentRoot, "state", "subagents", publicId);
  const sessionFile = join(artifactsDir, "session.jsonl");
  mkdirSync(artifactsDir, { recursive: true });
  writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: "native-1", timestamp: new Date(0).toISOString(), cwd: "/tmp" })}\n`, "utf8");
  writeFileSync(join(artifactsDir, "run.json"), JSON.stringify({
    version: 4,
    id: publicId,
    operation: "delegate",
    artifactsDir,
    sessionFile,
    sessionId: "native-1",
    originParentSessionId: PARENT_SESSION,
    lastParentSessionId: PARENT_SESSION,
    promptSnapshot: createPromptSnapshot(),
    phase: "completed",
    agent: { promptVersion: 2, name: "worker", inheritParentSystem: true },
    task: "initial",
    cwd: "/tmp",
    startedAt: 1,
    endedAt: 2,
    finalText: "done",
    retries: 0,
    toolErrors: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
    timeline: [],
  }, null, 2), "utf8");
}

/** A full V4 run-record factory for lifecycle mocks: the background
 * lifecycle's abort path reads timeline, operation, and startedAt off the
 * returned details, so a bare phase spread is not enough. */
function completedDetails(input) {
  return {
    version: 4,
    id: input.id,
    operation: "delegate",
    task: input.task,
    cwd: "/tmp",
    startedAt: 1,
    timeline: [],
    phase: "completed",
    finalText: "natural output",
    endedAt: 2,
    durationMs: 1,
  };
}

/** A lifecycle run mock that stays in flight until released, ignoring the
 * abort signal so a cancelling target can be observed deterministically. */
function deferredRun() {
  let release;
  const finished = new Promise((resolve) => { release = resolve; });
  let input;
  return {
    impl(next) {
      input = next;
      return finished.then(() => ({ details: completedDetails(input) }));
    },
    release() { release(); },
  };
}

// ─── Registration and schema ─────────────────────────────────────────

test("registerSubagentTool exposes abort_subagent beside delegate, resume, and wait", () => {
  const probe = createHarness();
  assert.deepEqual([...probe.pi.tools.keys()], [
    "wait_subagent", "delegate_subagent", "resume_subagent", "abort_subagent",
  ]);
  const schema = probe.abortTool.parameters;
  assert.equal(schema.type, "object");
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.anyOf, undefined);
  assert.equal(schema.oneOf, undefined);
  assert.deepEqual(schema.required, ["ids"]);
  assert.equal(schema.properties.ids.maxItems, 6);
  assert.equal(schema.properties.ids.minItems, 1);
  assert.equal(probe.abortTool.renderCall, undefined, "definitions stay headless before parent decoration");
});

test("ids validation rejects malformed requests before any state change", async () => {
  const probe = createHarness();
  probe.queue(1);
  const cases = [
    [{}, /ids must be an array/],
    [{ ids: "not-an-array" }, /ids must be an array/],
    [{ ids: [] }, /ids must be an array/],
    [{ ids: [id(1), id(2), id(3), id(4), id(5), id(6), id(7)] }, /ids must be an array/],
    [{ ids: [42] }, /is not one/],
    [{ ids: ["subagent_bogus"] }, /is not one/],
    [{ ids: [id(1)], reason: "stop" }, /Unknown abort_subagent parameter/],
  ];
  for (const [params, pattern] of cases) {
    const result = await probe.abortTool.execute("call", params, undefined, undefined, probe.ctx);
    assert.equal(result.isError, true);
    assert.equal(result.details.error.code, "INVALID_ARGUMENT");
    assert.match(result.content[0].text, pattern);
  }
  const job = probe.state.background.jobs.get(id(1));
  assert.equal(job.status, "queued", "no abort signal was sent for a rejected request");
  assert.equal(job.abortController.signal.aborted, false);
});

// ─── Ownership and batch atomicity ───────────────────────────────────

test("an unknown ID and a foreign persisted ID both reject with concrete reasons", async () => {
  const probe = createHarness();
  const foreign = "subagent_00000000-0000-4000-8000-00000000abcd";
  writePersistedRun(foreign);

  let result = await probe.abortTool.execute("call", { ids: [id(1)] }, undefined, undefined, probe.ctx);
  assert.equal(result.isError, true);
  assert.equal(result.details.error.code, "SUBAGENT_NOT_FOUND");
  assert.match(result.content[0].text, /not a background subagent of the current session/);

  result = await probe.abortTool.execute("call", { ids: [foreign] }, undefined, undefined, probe.ctx);
  assert.equal(result.isError, true);
  assert.equal(result.details.error.code, "SUBAGENT_NOT_FOUND");
  assert.match(result.content[0].text, /belongs to another parent session/);
});

test("one invalid ID rejects the whole request without aborting its siblings", async () => {
  const probe = createHarness();
  probe.queue(1);
  const result = await probe.abortTool.execute("call", { ids: [id(1), id(2)] }, undefined, undefined, probe.ctx);
  assert.equal(result.isError, true);
  assert.equal(result.details.error.code, "SUBAGENT_NOT_FOUND");
  const sibling = probe.state.background.jobs.get(id(1));
  assert.equal(sibling.status, "queued", "nothing was aborted for the rejected call");
  assert.equal(sibling.abortController.signal.aborted, false);
});

test("a job carried from another parent session is foreign and rejected", async () => {
  const probe = createHarness();
  probe.queue(1, { parentSessionId: "earlier-parent-session" });

  const result = await probe.abortTool.execute("call", { ids: [id(1)] }, undefined, undefined, probe.ctx);
  assert.equal(result.isError, true);
  assert.equal(result.details.error.code, "SUBAGENT_NOT_FOUND");
  assert.match(result.content[0].text, /belongs to another parent session/);
  assert.equal(probe.state.background.jobs.get(id(1)).status, "queued");
});

test("an abort without a stable parent session ID fails before any signal", async () => {
  const probe = createHarness();
  probe.queue(1);
  const result = await probe.abortTool.execute("call", { ids: [id(1)] }, undefined, undefined, {
    ...probe.ctx,
    sessionManager: { getSessionId: () => "", getBranch: () => [] },
  });
  assert.equal(result.isError, true);
  assert.equal(result.details.error.code, "PERSISTENCE_FAILED");
  assert.equal(probe.state.background.jobs.get(id(1)).status, "queued");
});

// ─── Active targets: queued, running, cancelling ─────────────────────

test("a queued target is aborted synchronously and the request stays a success", async () => {
  const probe = createHarness({ busy: true });
  probe.queue(1);

  const result = await probe.abortTool.execute("call", { ids: [id(1)] }, undefined, undefined, probe.ctx);
  assert.equal(result.isError, undefined, "a successful abort request is a successful tool call");
  assert.equal(result.details.version, 1);
  assert.deepEqual(result.details.ids, [id(1)]);
  assert.equal(result.details.results[0].before, "queued");
  assert.equal(result.details.results[0].status, "aborted");
  assert.equal(result.details.results[0].abortApplied, true);
  assert.match(result.details.results[0].reason, /aborted through abort_subagent/);
  assert.match(result.content[0].text, /^\[Background subagent abort\]/);
  assert.match(result.content[0].text, /abort: abort applied/);
  assert.match(result.content[0].text, /outcome: aborted/);
  assert.match(result.content[0].text, /Aborted:/);

  const job = probe.state.background.jobs.get(id(1));
  assert.equal(job.status, "aborted");
  assert.equal(job.abortController.signal.aborted, true);
  // An ordinary aborted run never notifies the parent and holds no result.
  assert.equal(probe.delivery.pendingCount(), 0);
  assert.equal(probe.sent.length, 0);
});

test("a running target passes through cancelling and the tool waits for aborted", async () => {
  const deferred = deferredRun();
  setRunSubagentTaskMock(deferred.impl);
  const probe = createHarness({ busy: true });
  const delegate = probe.pi.tools.get("delegate_subagent");
  const queued = await delegate.execute("call", { task: "work" }, undefined, undefined, probe.ctx);
  const publicId = queued.details.id;
  await waitFor(() => probe.state.background.jobs.get(publicId)?.status === "running", "job running");

  let settled = false;
  const pending = probe.abortTool.execute("abort", { ids: [publicId] }, undefined, undefined, probe.ctx)
    .then((value) => { settled = true; return value; });
  await waitFor(() => probe.state.background.jobs.get(publicId)?.status === "cancelling", "abort moved the run to cancelling");
  assert.equal(probe.state.background.jobs.get(publicId).abortController.signal.aborted, true);
  // The held run cannot reach a terminal state before release(), so the tool
  // is provably still waiting while the target is only cancelling.
  assert.equal(settled, false, "the tool is still waiting while the target is only cancelling");
  deferred.release();
  const result = await pending;
  assert.equal(result.isError, undefined);
  assert.equal(result.details.results[0].before, "running");
  assert.equal(result.details.results[0].status, "aborted");
  assert.equal(result.details.results[0].abortApplied, true);
  assert.equal(probe.state.background.jobs.get(publicId).status, "aborted");
  assert.equal(probe.sent.length, 0, "the aborted run never enters automatic delivery");
});

test("a cancelling target is a valid active target and the tool waits for aborted", async () => {
  const deferred = deferredRun();
  setRunSubagentTaskMock(deferred.impl);
  const probe = createHarness({ busy: true });
  const delegate = probe.pi.tools.get("delegate_subagent");
  const queued = await delegate.execute("call", { task: "work" }, undefined, undefined, probe.ctx);
  const publicId = queued.details.id;
  await waitFor(() => probe.state.background.jobs.get(publicId)?.status === "running", "job running");

  // The manager Cancel seam moves the run to cancelling while it stays in flight.
  cancelBackgroundJobs({ pi: probe.pi.api, state: probe.state.background, id: publicId });
  assert.equal(probe.state.background.jobs.get(publicId).status, "cancelling");

  const pending = probe.abortTool.execute("abort", { ids: [publicId] }, undefined, undefined, probe.ctx);
  deferred.release();
  const result = await pending;
  assert.equal(result.isError, undefined);
  assert.equal(result.details.results[0].before, "cancelling");
  assert.equal(result.details.results[0].status, "aborted");
  // The earlier cancellation already fired this run's abort signal, so this
  // request applied no new signal through the seam and reports that truth.
  assert.equal(result.details.results[0].abortApplied, false);
  assert.match(result.content[0].text, /already cancelling, no new signal/);
});

test("once abort linearizes, it wins a simultaneous natural-completion race", async () => {
  // The run finishes naturally, but only after the abort signal fired.
  setRunSubagentTaskMock((input) => new Promise((resolve) => {
    input.signal.addEventListener("abort", () => {
      resolve({ details: completedDetails(input) });
    }, { once: true });
  }));
  const probe = createHarness({ busy: true });
  const delegate = probe.pi.tools.get("delegate_subagent");
  const queued = await delegate.execute("call", { task: "work" }, undefined, undefined, probe.ctx);
  const publicId = queued.details.id;
  await waitFor(() => probe.state.background.jobs.get(publicId)?.status === "running", "job running");

  const result = await probe.abortTool.execute("abort", { ids: [publicId] }, undefined, undefined, probe.ctx);
  assert.equal(result.isError, undefined);
  assert.equal(result.details.results[0].status, "aborted", "abort wins the natural-completion race");
  assert.equal(probe.state.background.jobs.get(publicId).status, "aborted");
  assert.equal(probe.delivery.pendingCount(), 0, "the overwritten natural result never delivers");
  assert.equal(probe.sent.length, 0);
  assert.equal(getRunSubagentTaskCalls().length, 1);
});

// ─── Already-terminal targets: truthful reporting ────────────────────

test("an already-completed target is reported without repeating its result", async () => {
  const probe = createHarness({ busy: true });
  probe.queue(1);
  probe.finish(1, "completed", { finalText: "SECRET-COMPLETED-RESULT" });

  const result = await probe.abortTool.execute("call", { ids: [id(1)] }, undefined, undefined, probe.ctx);
  assert.equal(result.isError, undefined, "reporting a terminal target is not a tool failure");
  assert.equal(result.details.results[0].before, "completed");
  assert.equal(result.details.results[0].status, "completed");
  assert.equal(result.details.results[0].abortApplied, false);
  assert.equal(result.details.results[0].result, undefined, "no result text enters the abort projection");
  assert.doesNotMatch(result.content[0].text, /SECRET-COMPLETED-RESULT/, "the successful result is not repeated");
  assert.match(result.content[0].text, /state before: completed/);
  assert.match(result.content[0].text, /abort: already completed before the request/);
  assert.match(result.content[0].text, /outcome: completed/);
  // The pending completion stays pending: abort is not a second result-consumption path.
  assert.equal(probe.delivery.isPending(id(1)), true);
});

test("an already-failed target is reported with its complete bounded error", async () => {
  const probe = createHarness({ busy: true });
  probe.queue(1);
  probe.finish(1, "failed", { error: "Subagent failed: SUBAGENT_FAILED\nMessage: probe failure detail" });

  const result = await probe.abortTool.execute("call", { ids: [id(1)] }, undefined, undefined, probe.ctx);
  assert.equal(result.isError, undefined, "an already-failed target is a report, not a tool failure");
  assert.equal(result.details.results[0].before, "failed");
  assert.equal(result.details.results[0].status, "failed");
  assert.equal(result.details.results[0].abortApplied, false);
  assert.match(result.details.results[0].error, /probe failure detail/);
  assert.match(result.content[0].text, /Error:/);
  assert.match(result.content[0].text, /probe failure detail/);
});

test("an already-aborted target is reported with its abort reason", async () => {
  const probe = createHarness({ busy: true });
  probe.queue(1);
  probe.finish(1, "aborted", { error: "Subagent failed: ABORTED\nMessage: earlier stop" });

  const result = await probe.abortTool.execute("call", { ids: [id(1)] }, undefined, undefined, probe.ctx);
  assert.equal(result.isError, undefined);
  assert.equal(result.details.results[0].before, "aborted");
  assert.equal(result.details.results[0].status, "aborted");
  assert.equal(result.details.results[0].abortApplied, false);
  assert.match(result.details.results[0].reason, /earlier stop/);
});

test("a mixed batch reports every target in requested first-occurrence order", async () => {
  const probe = createHarness({ busy: true });
  probe.queue(1);
  probe.queue(2);
  probe.queue(3);
  probe.finish(1, "completed");
  probe.finish(3, "failed", { error: "Subagent failed: SUBAGENT_FAILED\nMessage: nope" });

  const result = await probe.abortTool.execute(
    "call",
    { ids: [id(2), id(1), id(3), id(2), id(1)] },
    undefined,
    undefined,
    probe.ctx,
  );
  assert.deepEqual(result.details.ids, [id(2), id(1), id(3)], "repeated IDs deduplicate in first-occurrence order");
  assert.deepEqual(
    result.details.results.map((entry) => `${entry.id}:${entry.before}:${entry.status}:${entry.abortApplied}`),
    [
      `${id(2)}:queued:aborted:true`,
      `${id(1)}:completed:completed:false`,
      `${id(3)}:failed:failed:false`,
    ],
    "entries return in requested-ID order with truthful pre-request and terminal states",
  );
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /^\[Background subagent abort: 3 targets\]/);
});

// ─── Interruption and session termination ────────────────────────────

test("interrupting the abort tool's own wait does not retract the sent signals", async () => {
  const deferred = deferredRun();
  setRunSubagentTaskMock(deferred.impl);
  const probe = createHarness({ busy: true });
  const delegate = probe.pi.tools.get("delegate_subagent");
  const queued = await delegate.execute("call", { task: "work" }, undefined, undefined, probe.ctx);
  const publicId = queued.details.id;
  await waitFor(() => probe.state.background.jobs.get(publicId)?.status === "running", "job running");

  const controller = new AbortController();
  const pending = probe.abortTool.execute("abort", { ids: [publicId] }, controller.signal, undefined, probe.ctx);
  await waitFor(() => probe.state.background.jobs.get(publicId)?.status === "cancelling", "abort signal sent");
  controller.abort();

  const result = await pending;
  assert.equal(result.isError, true);
  assert.equal(result.details.error.code, "ABORTED");
  // The error states the incomplete terminal-state observation, matching the
  // documented tool-error boundary for interrupted waits.
  assert.match(result.content[0].text, /final states were not observed/);
  assert.match(result.content[0].text, /stays in effect/);
  const job = probe.state.background.jobs.get(publicId);
  assert.equal(job.abortController.signal.aborted, true, "the abort signal is not retracted");
  assert.equal(job.status, "cancelling", "the target keeps stopping on its own");

  deferred.release();
  await waitFor(() => probe.state.background.jobs.get(publicId)?.status === "aborted", "the target reaches aborted");
  assert.equal(probe.sent.length, 0, "the ordinary aborted run still never notifies");
});

test("a pre-aborted signal still sends the requested aborts and reports the interruption", async () => {
  const probe = createHarness({ busy: true });
  probe.queue(1);
  const controller = new AbortController();
  controller.abort();

  const result = await probe.abortTool.execute("call", { ids: [id(1)] }, controller.signal, undefined, probe.ctx);
  assert.equal(result.isError, true);
  assert.equal(result.details.error.code, "ABORTED");
  assert.match(result.content[0].text, /final states were not observed/);
  assert.match(result.content[0].text, /stays in effect/);
  assert.equal(probe.state.background.jobs.get(id(1)).status, "aborted", "the abort was applied");
});

test("session replacement terminates the abort wait while the aborts stand", async () => {
  const deferred = deferredRun();
  setRunSubagentTaskMock(deferred.impl);
  const probe = createHarness({ busy: true });
  const delegate = probe.pi.tools.get("delegate_subagent");
  const queued = await delegate.execute("call", { task: "work" }, undefined, undefined, probe.ctx);
  const publicId = queued.details.id;
  await waitFor(() => probe.state.background.jobs.get(publicId)?.status === "running", "job running");

  const pending = probe.abortTool.execute("abort", { ids: [publicId] }, undefined, undefined, probe.ctx);
  await waitFor(() => probe.state.background.jobs.get(publicId)?.status === "cancelling", "abort signal sent");
  probe.registry.terminateAll("session replaced");

  const result = await pending;
  assert.equal(result.isError, true);
  assert.equal(result.details.error.code, "ABORTED");
  assert.match(result.content[0].text, /terminated by the parent session/);
  assert.match(result.content[0].text, /final states were not observed/);
  assert.equal(probe.state.background.jobs.get(publicId).abortController.signal.aborted, true);

  deferred.release();
  await waitFor(() => probe.state.background.jobs.get(publicId)?.status === "aborted", "the abort completes on its own");
});

// ─── Claim ownership and aborted-result delivery ─────────────────────

test("abort does not steal a wait_subagent claim: the waiter receives the aborted outcome", async () => {
  const probe = createHarness({ busy: true });
  probe.queue(1);

  const waiting = probe.waitTool.execute("wait", { ids: [id(1)] }, undefined, undefined, probe.ctx);
  await waitFor(() => probe.delivery.isClaimed(id(1)), "claim registered");

  const abortResult = await probe.abortTool.execute("abort", { ids: [id(1)] }, undefined, undefined, probe.ctx);
  assert.equal(abortResult.isError, undefined);
  assert.equal(abortResult.details.results[0].status, "aborted");

  const waitResult = await waiting;
  assert.equal(waitResult.isError, true, "the aborted entry marks the wait result as an error");
  assert.equal(waitResult.details.results[0].status, "aborted", "the waiter owns and receives the aborted outcome");
  assert.match(waitResult.content[0].text, /^\[Background subagent aborted\]/);
  assert.equal(probe.delivery.pendingCount(), 0, "the waiter consumed the aborted result");
  assert.equal(probe.sent.length, 0, "the aborted result was never auto-delivered");
});

test("an aborted result enters the store only while a waiter owns the ID", async () => {
  const probe = createHarness({ busy: true });
  probe.queue(1);
  probe.queue(2);

  // Claim only the first run; the second is aborted unclaimed.
  const waiting = probe.waitTool.execute("wait", { ids: [id(1)] }, undefined, undefined, probe.ctx);
  await waitFor(() => probe.delivery.isClaimed(id(1)), "claim registered");

  await probe.abortTool.execute("abort", { ids: [id(1), id(2)] }, undefined, undefined, probe.ctx);
  const waitResult = await waiting;

  assert.equal(waitResult.details.results[0].status, "aborted");
  assert.equal(probe.delivery.pendingCount(), 0, "the claimed aborted result was consumed by its waiter");
  assert.equal(probe.delivery.pendingIds().includes(id(2)), false, "the unclaimed aborted result never entered the store");
  assert.equal(probe.sent.length, 0);
});

// ─── Bounded abort details ───────────────────────────────────────────

test("abort details carry a bounded projection, never the full run record", async () => {
  const probe = createHarness({ busy: true });
  probe.queue(1);
  probe.queue(2);
  const oversizedError = `HEAD-FAILURE-${"x".repeat(20_000)}-TAIL-FAILURE`;
  const oversizedTask = "t".repeat(2_000);
  probe.finish(1, "failed", { error: oversizedError });
  probe.state.background.jobs.get(id(1)).details.task = oversizedTask;
  probe.state.background.jobs.get(id(1)).details.agent = {
    promptVersion: 2,
    name: `A-${"a".repeat(6_000)}`,
    inheritParentSystem: true,
  };
  probe.state.background.jobs.get(id(1)).details.model = `M-${"m".repeat(6_000)}`;

  const result = await probe.abortTool.execute("call", { ids: [id(1), id(2)] }, undefined, undefined, probe.ctx);
  assert.equal(result.isError, undefined);
  const failed = result.details.results[0];
  assert.ok(failed.error.length <= 4_100, `failure evidence stays inside the abort budget: ${failed.error.length}`);
  assert.match(failed.error, /HEAD-FAILURE/, "the head survives the clip");
  assert.match(failed.error, /TAIL-FAILURE/, "the tail survives the clip");
  assert.match(failed.error, /\[omitted /, "the clip is visible");
  assert.ok(failed.task.length <= 300, "the task line is clipped");
  assert.equal(failed.promptSnapshot, undefined, "the prompt snapshot never enters abort details");
  assert.equal(failed.artifactsDir, undefined, "artifact paths never enter abort details");
  assert.equal(failed.timeline, undefined, "the timeline never enters abort details");

  const serialized = JSON.stringify(result.details);
  assert.ok(!serialized.includes("a".repeat(64)), "no unbounded agent-name slice leaks into details");
  assert.ok(!serialized.includes("m".repeat(64)), "no unbounded model slice leaks into details");
  for (const entry of result.details.results) {
    for (const value of Object.values(entry)) {
      if (typeof value === "string") {
        assert.ok(value.length <= 4_100, `every details string stays inside the abort budgets: ${value.length}`);
      }
    }
  }
  // The model-facing content keeps the established delivery budget, so it can
  // stay larger than the bounded projection.
  assert.ok(result.content[0].text.length >= failed.error.length);
});

// ─── Model-facing error budget vs bounded details projection ─────────

test("a 4K-24K failed error keeps the full 24,000-character budget in content", async () => {
  const probe = createHarness({ busy: true });
  probe.queue(1);
  // ~10K total: markers at the head, beyond the 4K projection window, and the tail.
  const errorText = [
    "BUDGET-HEAD-4T1M",
    "h".repeat(5_000),
    "BUDGET-MID-7K2Q",
    "m".repeat(4_000),
    "BUDGET-TAIL-9X5N",
  ].join("");
  probe.finish(1, "failed", { error: errorText });

  const result = await probe.abortTool.execute("call", { ids: [id(1)] }, undefined, undefined, probe.ctx);
  assert.equal(result.isError, undefined);
  const summary = result.details.results[0];
  assert.ok(summary.error.length <= 4_100, "details keep the 4,000-character projection");
  assert.match(summary.error, /\[omitted /, "the projection clip is visible");
  assert.doesNotMatch(summary.error, /BUDGET-MID-7K2Q/, "the mid error sits outside the 4K projection window");

  const content = result.content[0].text;
  assert.ok(content.length > summary.error.length, "content is not derived from the details projection");
  assert.match(content, /BUDGET-HEAD-4T1M/, "the head survives");
  assert.match(content, /BUDGET-MID-7K2Q/, "content keeps error text far beyond the 4K projection window");
  assert.match(content, /BUDGET-TAIL-9X5N/, "the tail survives");
  assert.doesNotMatch(content, /\[omitted /, "a 10K error fits the 24K budget with no omission");
});

test("an over-24K failed error keeps head and tail under the delivery budget in content", async () => {
  const probe = createHarness({ busy: true });
  probe.queue(1);
  // ~30K total: the late marker sits beyond both the 4K projection window and
  // inside the 24K budget's tail retention.
  const errorText = [
    "BUDGET-HEAD-4T1M",
    "h".repeat(27_000),
    "BUDGET-LATE-3R8W",
    "l".repeat(1_500),
    "BUDGET-TAIL-9X5N",
  ].join("");
  probe.finish(1, "failed", { error: errorText });

  const result = await probe.abortTool.execute("call", { ids: [id(1)] }, undefined, undefined, probe.ctx);
  assert.equal(result.isError, undefined);
  const summary = result.details.results[0];
  assert.ok(summary.error.length <= 4_100, "details stay at the 4,000-character projection");
  assert.doesNotMatch(summary.error, /BUDGET-LATE-3R8W/);

  const content = result.content[0].text;
  assert.match(content, /BUDGET-HEAD-4T1M/, "the 24K head retention keeps the head");
  assert.match(content, /BUDGET-LATE-3R8W/, "the 24K tail retention keeps text far beyond the 4K projection");
  assert.match(content, /BUDGET-TAIL-9X5N/, "the conclusion survives");
  assert.match(content, /\[omitted \d+ characters\]/, "the 24K budget clip is visible");
  assert.ok(content.length < errorText.length + 500, "content stays inside the established delivery budget");
});

await run();
rmSync(agentRoot, { recursive: true, force: true });
