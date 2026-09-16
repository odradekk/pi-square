import assert from "node:assert/strict";
import { join, resolve } from "node:path";

import jiti from "jiti";

import { run, test } from "./lib/test-helpers.mjs";

const packageRoot = resolve(import.meta.dirname, "..", "..");
const load = jiti(import.meta.url, { moduleCache: false });
const {
  budgetResultText,
  createSubagentDeliveryCore,
  keepReleasedResult,
  MAX_BATCH_RESULTS,
  MAX_PENDING_RESULTS,
  MAX_RESULT_CHARS,
  MAX_WAIT_RESERVATIONS,
  notificationResultIds,
  SUBAGENT_NOTIFICATION_TYPE,
} = await load(join(packageRoot, "src", "subagents", "delivery.ts"));

function runDetails(id, overrides = {}) {
  return {
    version: 4,
    id,
    operation: "delegate",
    artifactsDir: `/tmp/subagents/${id}`,
    sessionFile: `/tmp/subagents/${id}/session.jsonl`,
    sessionId: "native-session",
    originParentSessionId: "parent-session",
    lastParentSessionId: "parent-session",
    phase: "completed",
    agent: { promptVersion: 2, name: "explorer", inheritParentSystem: true },
    task: "probe task",
    cwd: "/tmp/subagents",
    startedAt: 10,
    finalText: "ACK",
    retries: 0,
    toolErrors: [],
    toolWarnings: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
    timeline: [],
    ...overrides,
  };
}

function harness({ idle = true, send } = {}) {
  const sent = [];
  let isIdle = idle;
  let changes = 0;
  const core = createSubagentDeliveryCore({
    pi: {
      sendMessage(message, options) {
        if (send) send(message, options);
        sent.push({ message, options });
      },
    },
    isIdle: () => isIdle,
    notify: () => { changes += 1; },
  });
  return {
    core,
    sent,
    changes: () => changes,
    setIdle(value) { isIdle = value; },
    last() { return sent[sent.length - 1]; },
  };
}

function enqueue(core, id, overrides = {}) {
  core.enqueue({
    id,
    value: { id, status: overrides.status ?? "completed", details: runDetails(id, overrides.details ?? {}) },
  });
}

// ─── Content budget (the truncation defect) ──────────────────────────

test("a long result reaches the parent complete", () => {
  const long = Array.from({ length: 120 }, (_, index) => `LINE-${String(index + 1).padStart(3, "0")} ${"A".repeat(40)}`)
    .concat("TAIL-MARKER-ALPHA-9Z7Q")
    .join("\n");
  assert.ok(long.length > 6000, "the reproduced result is far above the former 1600-character clip");

  const probe = harness();
  enqueue(probe.core, "run-long", { details: { finalText: long } });

  const content = probe.last().message.content;
  assert.ok(content.includes(long), "the whole result text reaches the parent");
  assert.doesNotMatch(content, /\[omitted/, "a result inside the budget carries no omission marker");
});

test("an oversized result keeps its head and its tail with a visible omission count", () => {
  const oversized = `HEAD-MARKER${"x".repeat(40_000)}TAIL-MARKER`;
  const budgeted = budgetResultText(oversized);
  const head = Math.floor(MAX_RESULT_CHARS * 0.7);
  const tail = MAX_RESULT_CHARS - head;

  assert.ok(budgeted.startsWith("HEAD-MARKER"), "the head survives");
  assert.ok(budgeted.endsWith("TAIL-MARKER"), "the conclusion at the tail survives");
  assert.match(budgeted, new RegExp(`\\[omitted ${oversized.length - head - tail} characters\\]`));

  const probe = harness();
  enqueue(probe.core, "run-oversized", { details: { finalText: oversized } });
  assert.ok(probe.last().message.content.includes(budgeted));
});

test("a failure text uses the same budget as a result text", () => {
  const failure = "E".repeat(30_000);
  const probe = harness();
  enqueue(probe.core, "run-failed", {
    status: "failed",
    details: { phase: "failed", finalText: "", error: failure },
  });

  const content = probe.last().message.content;
  assert.match(content, /^\[Background subagent failed\]/);
  assert.match(content, /\[omitted 6000 characters\]/, "the former 800-character error clip is gone");
});

// ─── V5 notification payload (policy rendering) ──────────────────────

test("a burst renders as one V5 steering notification per batch", () => {
  const probe = harness({ idle: false });
  for (let index = 0; index < MAX_BATCH_RESULTS + 1; index += 1) enqueue(probe.core, `run-${index}`);

  probe.core.handleTurnEnd();
  assert.equal(probe.sent.length, 1);
  const message = probe.last().message;
  assert.equal(message.customType, SUBAGENT_NOTIFICATION_TYPE);
  assert.equal(message.details.version, 5);
  assert.equal(message.details.results.length, MAX_BATCH_RESULTS);
  assert.deepEqual(
    message.details.results.map((result) => [result.id, result.status, result.result.id]),
    Array.from({ length: MAX_BATCH_RESULTS }, (_, index) => [`run-${index}`, "completed", `run-${index}`]),
    "every entry carries the run identity, the deliverable status, and its V4 run record",
  );
  assert.match(message.content, new RegExp(`^\\[Background subagents: ${MAX_BATCH_RESULTS} results\\]`));
  assert.match(message.content, /--- 1\/6 completed · id: run-0/);
  assert.deepEqual(probe.last().options, { triggerTurn: true, deliverAs: "steer" });
});
test("a re-delivered result is marked as resent in the notification payload", () => {
  const probe = harness({ idle: false });
  enqueue(probe.core, "run-lost");
  probe.core.handleTurnEnd();
  probe.core.handleAgentSettled();
  assert.equal(probe.sent.length, 2, "the discarded result is delivered again");
  assert.equal(probe.last().message.details.resent, true);
  assert.match(probe.last().message.content, /^\[Background subagent completed\] \(resent\)/);
  assert.deepEqual(probe.last().message.details.results.map((result) => result.id), ["run-lost"]);
});

// ─── Confirmation payloads ───────────────────────────────────────────

function v5Payload(entries) {
  return { version: 5, deliveryId: "delivery-9", resent: false, results: entries };
}

function v5Entry(id, overrides = {}) {
  return {
    id,
    status: "completed",
    result: runDetails(id, { id }),
    ...overrides,
  };
}

test("confirmation reads fully valid V5 entries", () => {
  assert.deepEqual(
    notificationResultIds({
      customType: SUBAGENT_NOTIFICATION_TYPE,
      details: v5Payload([
        v5Entry("run-a", { status: "completed" }),
        v5Entry("run-b", { status: "failed" }),
      ]),
    }),
    ["run-a", "run-b"],
  );
});

test("a malformed V5 entry confirms nothing", () => {
  const malformed = [
    v5Entry("no-status", { status: undefined }),
    v5Entry("retired-status", { status: "aborted" }),
    v5Entry("missing-result", { result: undefined }),
    v5Entry("non-v4-result", { result: { ...runDetails("non-v4-result"), version: 3 } }),
    { ...v5Entry("mismatched-id"), id: "other-run" },
    { ...v5Entry("run-blank"), id: "" },
    "not an entry",
  ];
  const ids = notificationResultIds({
    customType: SUBAGENT_NOTIFICATION_TYPE,
    details: v5Payload([...malformed, v5Entry("run-valid")]),
  });
  assert.deepEqual(ids, ["run-valid"], "only the complete entry confirms");
});

test("confirmation ignores foreign messages and non-V5 payloads", () => {
  assert.deepEqual(
    notificationResultIds({ customType: "other", details: v5Payload([v5Entry("run-a")]) }),
    [],
  );
  assert.deepEqual(
    notificationResultIds({ customType: SUBAGENT_NOTIFICATION_TYPE, details: { results: [v5Entry("run-a")] } }),
    [],
    "a payload without the V5 version marker confirms nothing",
  );
  assert.deepEqual(
    notificationResultIds({ customType: SUBAGENT_NOTIFICATION_TYPE, details: undefined }),
    [],
  );
  assert.deepEqual(notificationResultIds(undefined), []);
});

// ─── Subagent policy: aborted admission and release routing ──────────

test("an aborted result is stored only while a waiter owns the claim", () => {
  const probe = harness({ idle: true });
  const details = runDetails("run-aborted", { phase: "aborted", finalText: "", error: "Subagent failed: ABORTED\n..." });

  // Unclaimed: the ordinary policy — aborted runs notify nobody.
  enqueue(probe.core, "run-aborted", { status: "aborted", details });
  assert.equal(probe.core.pendingCount(), 0);
  assert.equal(probe.sent.length, 0);

  // Claimed first: the aborted outcome enters the store for the waiter only.
  const claim = probe.core.claim(["run-aborted"]);
  assert.equal(claim.ok, true);
  probe.core.enqueue({ id: "run-aborted", value: { id: "run-aborted", status: "aborted", details } });
  assert.equal(probe.core.pendingCount(), 1, "the claimed aborted result is stored");
  assert.equal(probe.sent.length, 0, "it never enters automatic delivery");
  const taken = claim.claim.take();
  assert.equal(taken[0].status, "aborted");
  assert.equal(taken[0].details.id, "run-aborted");
});

test("release routing keeps deliverable results and drops aborted ones", () => {
  assert.equal(keepReleasedResult({ id: "a", status: "completed", details: runDetails("a") }), true);
  assert.equal(keepReleasedResult({ id: "b", status: "failed", details: runDetails("b") }), true);
  assert.equal(keepReleasedResult({ id: "c", status: "aborted", details: runDetails("c") }), false);

  const probe = harness({ idle: false });
  enqueue(probe.core, "run-done");
  enqueue(probe.core, "run-failed", { status: "failed", details: { phase: "failed", finalText: "", error: "boom" } });

  const claim = probe.core.claim(["run-done", "run-failed"]);
  assert.equal(claim.ok, true);
  claim.claim.release(keepReleasedResult);

  assert.equal(probe.core.isPending("run-done"), true);
  assert.equal(probe.core.isPending("run-failed"), true);
  probe.core.handleTurnEnd();
  assert.equal(probe.sent.length, 1, "released deliverable results rejoin the automatic schedule");

  // An aborted stored result leaves delivery storage entirely on release.
  const abortedDetails = runDetails("run-stopped", { phase: "aborted", finalText: "", error: "canceled" });
  const abortedClaim = probe.core.claim(["run-stopped"]);
  probe.core.enqueue({ id: "run-stopped", value: { id: "run-stopped", status: "aborted", details: abortedDetails } });
  assert.equal(probe.core.isPending("run-stopped"), true);
  abortedClaim.claim.release(keepReleasedResult);
  assert.equal(probe.core.isPending("run-stopped"), false);
});

test("the wait reservation bound matches the documented contract", () => {
  assert.equal(MAX_WAIT_RESERVATIONS, 50);
  assert.equal(MAX_PENDING_RESULTS, 50);
});

await run();
