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
const { createBackgroundState, createQueuedJob, notifyBackgroundChange } = await loadBackgroundModule();
const { createDeliveryController } = await loadDeliveryModule();
const loadLocal = jiti(import.meta.url, { moduleCache: false });
const { createSubagentWaitRegistry } = await loadLocal(join(
  import.meta.dirname, "..", "..", "src", "subagents", "wait.ts",
));

const agentRoot = join(tmpdir(), `pi-square-subagent-wait-${process.pid}-${Date.now()}`);
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
  const waitTool = pi.tools.get("wait_subagent");
  assert.ok(waitTool, "wait_subagent is registered");
  const resumeTool = pi.tools.get("resume_subagent");
  return {
    pi,
    state,
    delivery,
    registry,
    sent,
    waitTool,
    resumeTool,
    setBusy(value) { busy = value; },
    ctx: {
      cwd: "/tmp",
      model: { provider: "test", id: "model" },
      sessionManager: { getSessionId: () => PARENT_SESSION, getBranch: () => [] },
    },
    queue(n, overrides = {}) {
      const job = createQueuedJob({
        state: state.background,
        id: id(n),
        task: `task-${n}`,
        cwd: "/tmp",
        parentSessionId: PARENT_SESSION,
        promptSnapshot: createPromptSnapshot(),
        ...overrides,
      });
      return job;
    },
    /** Deterministic terminal transition: mutates the job record and enqueues
     * the result exactly like the background lifecycle's completion path. */
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

// ─── Registration and schema ─────────────────────────────────────────

test("registerSubagentTool exposes wait_subagent beside delegate and resume", () => {
  const probe = createHarness();
  assert.deepEqual([...probe.pi.tools.keys()], ["wait_subagent", "delegate_subagent", "resume_subagent"]);
  const schema = probe.waitTool.parameters;
  assert.equal(schema.type, "object");
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.anyOf, undefined);
  assert.deepEqual(schema.required, ["ids"]);
  assert.equal(schema.properties.ids.maxItems, 6);
  assert.equal(schema.properties.ids.minItems, 1);
  assert.equal(probe.waitTool.renderCall, undefined, "definitions stay headless before parent decoration");
});

test("ids validation rejects malformed requests before any state change", async () => {
  const probe = createHarness();
  const cases = [
    [{}, /ids must be an array/],
    [{ ids: "not-an-array" }, /ids must be an array/],
    [{ ids: [] }, /ids must be an array/],
    [{ ids: [id(1), id(2), id(3), id(4), id(5), id(6), id(7)] }, /ids must be an array/],
    [{ ids: [42] }, /is not one/],
    [{ ids: ["subagent_bogus"] }, /is not one/],
    [{ ids: [id(1)], mode: "all" }, /Unknown wait_subagent parameter/],
  ];
  for (const [params, pattern] of cases) {
    const result = await probe.waitTool.execute("call", params, undefined, undefined, probe.ctx);
    assert.equal(result.isError, true);
    assert.equal(result.details.error.code, "INVALID_ARGUMENT");
    assert.match(result.content[0].text, pattern);
  }
  assert.equal(probe.delivery.pendingCount(), 0);
  assert.equal(probe.delivery.pendingIds().length, 0, "no claim was made for a rejected request");
});

// ─── Eligibility ─────────────────────────────────────────────────────

test("an unknown ID and a foreign persisted ID both reject with concrete reasons", async () => {
  const probe = createHarness();
  const foreign = "subagent_00000000-0000-4000-8000-00000000abcd";
  writePersistedRun(foreign);

  let result = await probe.waitTool.execute("call", { ids: [id(1)] }, undefined, undefined, probe.ctx);
  assert.equal(result.isError, true);
  assert.equal(result.details.error.code, "SUBAGENT_NOT_FOUND");
  assert.match(result.content[0].text, /not a background subagent of the current session/);

  result = await probe.waitTool.execute("call", { ids: [foreign] }, undefined, undefined, probe.ctx);
  assert.equal(result.isError, true);
  assert.equal(result.details.error.code, "SUBAGENT_NOT_FOUND");
  assert.match(result.content[0].text, /belongs to another parent session/);
});

test("terminal aborted, already-confirmed, and sent results are not waitable", async () => {
  const probe = createHarness();
  probe.setBusy(true);
  probe.queue(1);
  probe.finish(1, "aborted");

  let result = await probe.waitTool.execute("call", { ids: [id(1)] }, undefined, undefined, probe.ctx);
  assert.equal(result.details.error.code, "RESULT_UNAVAILABLE");
  assert.match(result.content[0].text, /finished aborted before this wait/);

  probe.queue(2);
  probe.finish(2, "completed");
  probe.delivery.handleTurnEnd();
  assert.equal(probe.sent.length, 1, "the completion was sent for delivery");
  probe.delivery.observeMessage({
    customType: "pi-square.subagent-notification",
    details: probe.sent[0].message.details,
  });
  result = await probe.waitTool.execute("call", { ids: [id(2)] }, undefined, undefined, probe.ctx);
  assert.equal(result.details.error.code, "RESULT_DELIVERED");
  assert.match(result.content[0].text, /no longer pending/);

  probe.queue(3);
  probe.finish(3, "completed");
  probe.delivery.handleTurnEnd();
  result = await probe.waitTool.execute("call", { ids: [id(3)] }, undefined, undefined, probe.ctx);
  assert.equal(result.details.error.code, "RESULT_SENT");
  assert.match(result.content[0].text, /scheduled for automatic delivery/);
});

test("one invalid ID rejects the whole request without claiming its siblings", async () => {
  const probe = createHarness();
  probe.queue(1);
  const result = await probe.waitTool.execute("call", { ids: [id(1), id(2)] }, undefined, undefined, probe.ctx);
  assert.equal(result.isError, true);
  assert.equal(result.details.error.code, "SUBAGENT_NOT_FOUND");
  assert.equal(probe.delivery.isClaimed(id(1)), false, "nothing was claimed for the rejected call");
});

// ─── Immediate and ordered consumption ───────────────────────────────

test("an unsent pending result is claimed and returned immediately", async () => {
  const probe = createHarness({ busy: true });
  probe.queue(1);
  probe.finish(1, "completed", { finalText: "ACK" });

  const result = await probe.waitTool.execute("call", { ids: [id(1)] }, undefined, undefined, probe.ctx);
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /^\[Background subagent completed\]/);
  assert.ok(result.content[0].text.includes("ACK"));
  assert.equal(result.details.version, 1);
  assert.deepEqual(result.details.ids, [id(1)]);
  assert.equal(result.details.consumed, true);
  assert.equal(typeof result.details.waitedMs, "number");
  assert.equal(result.details.results[0].status, "completed");
  assert.equal(result.details.results[0].run.id, id(1));
  assert.equal(probe.delivery.pendingCount(), 0, "the consumed result left the pending set");
  assert.equal(probe.sent.length, 0, "the consumed result was never auto-delivered");
});

test("active runs are claimed and the waiter returns in requested order", async () => {
  const probe = createHarness({ busy: true });
  probe.queue(1);
  probe.queue(2);

  const pending = probe.waitTool.execute("call", { ids: [id(2), id(1)] }, undefined, undefined, probe.ctx);
  await waitFor(() => probe.delivery.isClaimed(id(1)) && probe.delivery.isClaimed(id(2)), "both claims registered");
  assert.equal(probe.delivery.pendingCount(), 0, "claims before completion hold no results yet");

  // Completion order is the reverse of the request order.
  probe.finish(1, "completed");
  probe.finish(2, "failed", { error: "Subagent failed: SUBAGENT_FAILED\nMessage: probe" });
  const result = await pending;

  assert.deepEqual(result.details.ids, [id(2), id(1)]);
  assert.deepEqual(
    result.details.results.map((entry) => `${entry.id}:${entry.status}`),
    [`${id(2)}:failed`, `${id(1)}:completed`],
    "results return in requested-ID order, not completion order",
  );
  assert.equal(result.isError, true, "a failed entry makes the whole result an error");
  assert.match(result.content[0].text, /1\/2 failed · id:/);
  assert.match(result.content[0].text, /2\/2 completed · id:/);
  assert.equal(probe.delivery.pendingCount(), 0, "taken results never auto-deliver");
});

test("repeated IDs deduplicate while preserving first-occurrence order", async () => {
  const probe = createHarness({ busy: true });
  probe.queue(1);
  probe.queue(2);
  probe.finish(1, "completed");
  probe.finish(2, "completed");

  const result = await probe.waitTool.execute(
    "call",
    { ids: [id(2), id(1), id(2), id(1)] },
    undefined,
    undefined,
    probe.ctx,
  );
  assert.deepEqual(result.details.ids, [id(2), id(1)]);
  assert.deepEqual(result.details.results.map((entry) => entry.id), [id(2), id(1)]);
});

test("an aborted run claimed before abort reaches its waiter", async () => {
  const probe = createHarness({ busy: true });
  probe.queue(1);

  const pending = probe.waitTool.execute("call", { ids: [id(1)] }, undefined, undefined, probe.ctx);
  await waitFor(() => probe.delivery.isClaimed(id(1)), "claim registered");
  probe.finish(1, "aborted", { error: "Subagent failed: ABORTED\nMessage: canceled" });
  const result = await pending;

  assert.equal(result.isError, true);
  assert.equal(result.details.results[0].status, "aborted");
  assert.match(result.content[0].text, /^\[Background subagent aborted\]/);
  assert.match(result.content[0].text, /Aborted:/);
  assert.equal(probe.delivery.pendingCount(), 0);
});

// ─── Overlapping waits and capacity ──────────────────────────────────

test("an overlapping wait on the same ID is rejected", async () => {
  const probe = createHarness({ busy: true });
  probe.queue(1);

  const first = probe.waitTool.execute("call-a", { ids: [id(1)] }, undefined, undefined, probe.ctx);
  await waitFor(() => probe.delivery.isClaimed(id(1)), "first claim registered");

  const second = await probe.waitTool.execute("call-b", { ids: [id(1)] }, undefined, undefined, probe.ctx);
  assert.equal(second.isError, true);
  assert.equal(second.details.error.code, "RESULT_CLAIMED");
  assert.match(second.content[0].text, /already claimed by another wait_subagent call/);

  probe.finish(1, "completed");
  const result = await first;
  assert.equal(result.isError, undefined, "the first waiter still consumes the result");
});

test("a claim past the reservation bound fails atomically with WAIT_CAPACITY", async () => {
  const probe = createHarness({ busy: true });
  // Fill the reservation bound through the controller seam directly; the
  // bound it enforces is the same one the wait tool lives under.
  for (let index = 0; index < 50; index += 1) {
    const filled = probe.delivery.claim([`filler-${index}`]);
    assert.equal(filled.ok, true);
  }
  probe.queue(1);

  const result = await probe.waitTool.execute("call", { ids: [id(1)] }, undefined, undefined, probe.ctx);
  assert.equal(result.isError, true);
  assert.equal(result.details.error.code, "WAIT_CAPACITY");
  assert.match(result.content[0].text, /reservation bound of 50/);
  assert.equal(probe.delivery.isClaimed(id(1)), false, "the rejected claim reserved nothing");
});

// ─── Interruption and session termination ────────────────────────────

test("interrupting a wait releases claims without aborting children", async () => {
  const probe = createHarness({ busy: true });
  probe.queue(1);
  probe.queue(2);
  const controller = new AbortController();

  const pending = probe.waitTool.execute("call", { ids: [id(1), id(2)] }, controller.signal, undefined, probe.ctx);
  await waitFor(() => probe.delivery.isClaimed(id(1)), "claims registered");

  controller.abort();
  const result = await pending;
  assert.equal(result.isError, true);
  assert.equal(result.details.error.code, "ABORTED");
  assert.match(result.content[0].text, /released without stopping the selected children/);
  assert.equal(probe.delivery.isClaimed(id(1)), false);
  assert.equal(probe.delivery.isClaimed(id(2)), false);

  const jobOne = probe.state.background.jobs.get(id(1));
  const jobTwo = probe.state.background.jobs.get(id(2));
  assert.equal(jobOne.status, "queued", "the children were not aborted");
  assert.equal(jobOne.abortController.signal.aborted, false);
  assert.equal(jobTwo.status, "queued");

  // A released completed result returns to automatic delivery; an aborted one does not.
  probe.finish(1, "completed");
  probe.finish(2, "aborted", { error: "Subagent failed: ABORTED\nMessage: stopped" });
  probe.delivery.handleTurnEnd();
  assert.equal(probe.sent.length, 1);
  assert.deepEqual(probe.sent[0].message.details.results.map((entry) => entry.id), [id(1)]);
});

test("a pre-aborted signal never claims anything", async () => {
  const probe = createHarness({ busy: true });
  probe.queue(1);
  const controller = new AbortController();
  controller.abort();

  const result = await probe.waitTool.execute("call", { ids: [id(1)] }, controller.signal, undefined, probe.ctx);
  assert.equal(result.isError, true);
  assert.equal(result.details.error.code, "ABORTED");
  assert.equal(probe.delivery.isClaimed(id(1)), false);
});

test("session replacement terminates outstanding waits and clears claims", async () => {
  const probe = createHarness({ busy: true });
  probe.queue(1);

  const pending = probe.waitTool.execute("call", { ids: [id(1)] }, undefined, undefined, probe.ctx);
  await waitFor(() => probe.delivery.isClaimed(id(1)), "claim registered");

  probe.registry.terminateAll("session replaced");
  probe.delivery.reset();
  const result = await pending;
  assert.equal(result.isError, true);
  assert.equal(result.details.error.code, "ABORTED");
  assert.match(result.content[0].text, /terminated by the parent session/);
  assert.equal(probe.delivery.isClaimed(id(1)), false);
  assert.equal(probe.delivery.pendingCount(), 0);
});

// ─── Parent-session isolation ────────────────────────────────────────

test("a job carried from another parent session is foreign and rejected", async () => {
  const probe = createHarness({ busy: true });
  probe.queue(1, { parentSessionId: "earlier-parent-session" });

  const result = await probe.waitTool.execute("call", { ids: [id(1)] }, undefined, undefined, probe.ctx);
  assert.equal(result.isError, true);
  assert.equal(result.details.error.code, "SUBAGENT_NOT_FOUND");
  assert.match(result.content[0].text, /belongs to another parent session/);
  assert.equal(probe.delivery.isClaimed(id(1)), false);
});

test("after a session replacement the previous session's jobs are not waitable", async () => {
  const probe = createHarness({ busy: true });
  probe.queue(1); // queued under PARENT_SESSION

  // The session lifecycle on replacement: outstanding waits terminate, the
  // pending set and claims clear, and the background jobs keep running.
  probe.registry.terminateAll("session replaced");
  probe.delivery.reset();

  const replaced = await probe.waitTool.execute("call", { ids: [id(1)] }, undefined, undefined, {
    ...probe.ctx,
    sessionManager: { getSessionId: () => "new-parent-session", getBranch: () => [] },
  });
  assert.equal(replaced.isError, true);
  assert.equal(replaced.details.error.code, "SUBAGENT_NOT_FOUND");
  assert.match(replaced.content[0].text, /belongs to another parent session/);
});

test("a wait without a stable parent session ID fails before claiming", async () => {
  const probe = createHarness({ busy: true });
  probe.queue(1);
  const result = await probe.waitTool.execute("call", { ids: [id(1)] }, undefined, undefined, {
    ...probe.ctx,
    sessionManager: { getSessionId: () => "", getBranch: () => [] },
  });
  assert.equal(result.isError, true);
  assert.equal(result.details.error.code, "PERSISTENCE_FAILED");
  assert.equal(probe.delivery.isClaimed(id(1)), false);
});

// ─── Bounded wait details ────────────────────────────────────────────

test("wait details carry a bounded projection, never the full run record", async () => {
  const probe = createHarness({ busy: true });
  probe.queue(1);
  const oversizedText = `HEAD-EVIDENCE-${"x".repeat(20_000)}-TAIL-EVIDENCE`;
  const oversizedTask = "t".repeat(2_000);
  probe.finish(1, "completed", { finalText: oversizedText });
  // The stored pending entry references the same details object, so the
  // oversized task reaches the projection path exactly like a real run's.
  probe.state.background.jobs.get(id(1)).details.task = oversizedTask;

  const result = await probe.waitTool.execute("call", { ids: [id(1)] }, undefined, undefined, probe.ctx);
  assert.equal(result.isError, undefined);
  const summary = result.details.results[0].run;
  assert.ok(summary.result.length <= 4_100, `evidence stays inside the wait budget: ${summary.result.length}`);
  assert.match(summary.result, /HEAD-EVIDENCE/, "the head survives the clip");
  assert.match(summary.result, /TAIL-EVIDENCE/, "the conclusion survives the clip");
  assert.match(summary.result, /\[omitted /, "the clip is visible");
  assert.ok(summary.task.length <= 300, "the task line is clipped");
  assert.equal(summary.promptSnapshot, undefined, "the prompt snapshot never enters wait details");
  assert.equal(summary.artifactsDir, undefined, "artifact paths never enter wait details");
  assert.equal(summary.timeline, undefined, "the timeline never enters wait details");
  // The model-facing content keeps the established 24,000-character budget,
  // so it stays far larger than the bounded evidence projection.
  assert.ok(result.content[0].text.length > summary.result.length);
});

test("an oversized agent name and model string never enter the wait details", async () => {
  const probe = createHarness({ busy: true });
  probe.queue(1);
  probe.finish(1, "completed", { finalText: "bounded output" });
  const job = probe.state.background.jobs.get(id(1));
  // Neither field has a length limit at its source: the definition name has a
  // format check only, and the model is an arbitrary override string.
  job.details.agent = { promptVersion: 2, name: `A-${"a".repeat(6_000)}`, inheritParentSystem: true };
  job.details.model = `M-${"m".repeat(6_000)}`;

  const result = await probe.waitTool.execute("call", { ids: [id(1)] }, undefined, undefined, probe.ctx);
  assert.equal(result.isError, undefined);
  const summary = result.details.results[0].run;
  assert.equal(summary.agent, undefined, "the agent name is omitted from the projection");
  assert.equal(summary.model, undefined, "the model string is omitted from the projection");

  // Every string in the structured details is bounded: none carries any
  // meaningful slice of the oversized values.
  const serialized = JSON.stringify(result.details);
  assert.ok(!serialized.includes("a".repeat(64)), "no unbounded agent-name slice leaks into details");
  assert.ok(!serialized.includes("m".repeat(64)), "no unbounded model slice leaks into details");
  for (const [field, value] of Object.entries(summary)) {
    if (typeof value === "string") {
      assert.ok(value.length <= 4_100, `the ${field} string stays inside the wait budgets: ${value.length}`);
    }
  }
});

// ─── History deletion while waiting (manager delete-history path) ────

test("deleting a claimed run's history ends the wait deterministically without touching a later claim", async () => {
  const probe = createHarness({ busy: true });
  probe.queue(1);
  probe.queue(2);

  const pending = probe.waitTool.execute("call", { ids: [id(1), id(2)] }, undefined, undefined, probe.ctx);
  await waitFor(() => probe.delivery.isClaimed(id(1)) && probe.delivery.isClaimed(id(2)), "claims registered");

  // The manager delete-history action on a claimed active run: the persisted
  // history goes and delivery.remove ends the reservation for the identity.
  probe.delivery.remove(id(1));

  const result = await pending;
  assert.equal(result.isError, true);
  assert.equal(result.details.error.code, "SESSION_HISTORY_UNAVAILABLE");
  assert.match(result.content[0].text, /deleted while waiting/);
  assert.equal(probe.delivery.isClaimed(id(2)), false, "the sibling claim was released, not left hanging");
  assert.equal(probe.state.background.jobs.get(id(2)).status, "queued", "the sibling child was untouched");

  // A later waiter may claim the freed identity; the old handle cannot
  // consume or release the new owner's result.
  probe.finish(2, "completed");
  probe.queue(1);
  const second = probe.waitTool.execute("call-2", { ids: [id(1)] }, undefined, undefined, probe.ctx);
  await waitFor(() => probe.delivery.isClaimed(id(1)), "second claim registered");
  probe.finish(1, "completed");
  const secondResult = await second;
  assert.equal(secondResult.isError, undefined, "the new owner consumes its own result");
  // The released sibling's completed result rejoined the automatic schedule
  // and stays pending for its delivery; the re-claimed identity was consumed.
  assert.equal(probe.delivery.isPending(id(2)), true);
  assert.equal(probe.delivery.isPending(id(1)), false);
});

// ─── Resume blocking ─────────────────────────────────────────────────

test("resume rejects a pending result and a claimed result with distinct errors", async () => {
  const probe = createHarness({ busy: true });
  writePersistedRun(id(1));

  // Pending, unclaimed: the unconsumed result blocks resume.
  probe.state.background.jobs.set(id(1), {
    ...createQueuedJob({
      state: probe.state.background,
      id: id(1),
      task: "task",
      cwd: "/tmp",
      parentSessionId: PARENT_SESSION,
      promptSnapshot: createPromptSnapshot(),
    }),
  });
  probe.finish(1, "completed");
  let result = await probe.resumeTool.execute("resume-1", { id: id(1), task: "again" }, undefined, undefined, probe.ctx);
  assert.equal(result.isError, true);
  assert.equal(result.details.error.code, "RESULT_PENDING");
  assert.match(result.content[0].text, /undelivered result/);
  assert.match(result.content[0].text, /wait_subagent/);

  // Claimed by a waiter: another distinct, actionable error.
  probe.queue(1);
  const pending = probe.waitTool.execute("call", { ids: [id(1)] }, undefined, undefined, probe.ctx);
  await waitFor(() => probe.delivery.isClaimed(id(1)), "claim registered");
  result = await probe.resumeTool.execute("resume-2", { id: id(1), task: "again" }, undefined, undefined, probe.ctx);
  assert.equal(result.isError, true);
  assert.equal(result.details.error.code, "RESULT_CLAIMED");
  assert.match(result.content[0].text, /claimed by an active wait_subagent call/);
  assert.match(result.content[0].text, /Let the wait consume the result/);

  probe.finish(1, "completed");
  await pending;
});

// ─── Live lifecycle path ─────────────────────────────────────────────

test("a wait over the real background lifecycle consumes the delivered result", async () => {
  setRunSubagentTaskMock(async (input) => ({
    details: { ...input, phase: "completed", finalText: "lifecycle output", endedAt: 2, durationMs: 1 },
  }));
  const probe = createHarness({ busy: true });
  const delegate = probe.pi.tools.get("delegate_subagent");
  const queued = await delegate.execute("call", { task: "work" }, undefined, undefined, probe.ctx);
  const publicId = queued.details.id;

  const result = await probe.waitTool.execute("call", { ids: [publicId] }, undefined, undefined, probe.ctx);
  assert.equal(result.isError, undefined);
  assert.equal(result.details.results[0].status, "completed");
  assert.ok(result.content[0].text.includes("lifecycle output"));
  assert.equal(getRunSubagentTaskCalls().length, 1);
  assert.equal(probe.delivery.pendingCount(), 0);
});

await run();
rmSync(agentRoot, { recursive: true, force: true });
