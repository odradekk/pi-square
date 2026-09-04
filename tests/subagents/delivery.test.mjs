import assert from "node:assert/strict";
import { join, resolve } from "node:path";

import jiti from "jiti";

import { run, test } from "./lib/test-helpers.mjs";

const packageRoot = resolve(import.meta.dirname, "..", "..");
const load = jiti(import.meta.url, { moduleCache: false });
const {
  budgetResultText,
  createDeliveryController,
  MAX_BATCH_RESULTS,
  MAX_PENDING_RESULTS,
  MAX_RESULT_CHARS,
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
  const controller = createDeliveryController({
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
    controller,
    sent,
    changes: () => changes,
    setIdle(value) { isIdle = value; },
    last() { return sent[sent.length - 1]; },
    confirmLast() {
      const message = sent[sent.length - 1].message;
      controller.observeMessage({
        role: "custom",
        customType: message.customType,
        details: message.details,
      });
    },
  };
}

function enqueue(controller, id, overrides = {}) {
  controller.enqueue({
    id,
    status: overrides.status ?? "completed",
    details: runDetails(id, overrides.details ?? {}),
  });
}

// ─── Content budget (the truncation defect) ──────────────────────────

test("a long result reaches the parent complete", () => {
  const long = Array.from({ length: 120 }, (_, index) => `LINE-${String(index + 1).padStart(3, "0")} ${"A".repeat(40)}`)
    .concat("TAIL-MARKER-ALPHA-9Z7Q")
    .join("\n");
  assert.ok(long.length > 6000, "the reproduced result is far above the former 1600-character clip");

  const probe = harness();
  enqueue(probe.controller, "run-long", { details: { finalText: long } });

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
  enqueue(probe.controller, "run-oversized", { details: { finalText: oversized } });
  assert.ok(probe.last().message.content.includes(budgeted));
});

test("a failure text uses the same budget as a result text", () => {
  const failure = "E".repeat(30_000);
  const probe = harness();
  enqueue(probe.controller, "run-failed", {
    status: "failed",
    details: { phase: "failed", finalText: "", error: failure },
  });

  const content = probe.last().message.content;
  assert.match(content, /^\[Background subagent failed\]/);
  assert.match(content, /\[omitted 6000 characters\]/, "the former 800-character error clip is gone");
});

// ─── Delivery timing and coalescing (the loss defect) ────────────────

test("a busy parent receives results at the next turn boundary", () => {
  const probe = harness({ idle: false });
  enqueue(probe.controller, "run-busy");
  assert.equal(probe.sent.length, 0, "no result is pushed into a running turn");
  assert.equal(probe.controller.pendingCount(), 1);

  probe.controller.handleTurnEnd();
  assert.equal(probe.sent.length, 1);
  assert.deepEqual(probe.last().options, { triggerTurn: true, deliverAs: "steer" });
});

test("results are coalesced into one delivery and the surplus follows at the next one", () => {
  const probe = harness({ idle: false });
  for (let index = 0; index < MAX_BATCH_RESULTS + 1; index += 1) enqueue(probe.controller, `run-${index}`);

  probe.controller.handleTurnEnd();
  assert.equal(probe.sent.length, 1, "one message carries the whole burst");
  assert.equal(probe.last().message.details.version, 5);
  assert.equal(probe.last().message.details.results.length, MAX_BATCH_RESULTS);
  assert.match(probe.last().message.content, new RegExp(`^\\[Background subagents: ${MAX_BATCH_RESULTS} results\\]`));
  assert.match(probe.last().message.content, /--- 1\/6 completed · id: run-0/);

  probe.controller.handleTurnEnd();
  assert.equal(probe.sent.length, 2, "the surplus result is not lost");
  assert.deepEqual(probe.last().message.details.results.map((result) => result.id), ["run-6"]);
});

test("a confirmed result is never delivered again", () => {
  const probe = harness();
  enqueue(probe.controller, "run-confirmed");
  assert.equal(probe.sent.length, 1, "an idle parent receives the result at once");

  probe.confirmLast();
  assert.equal(probe.controller.pendingCount(), 0);

  probe.controller.handleAgentSettled();
  probe.controller.handleTurnEnd();
  assert.equal(probe.sent.length, 1, "a delivered result is never repeated");
});

test("a result the parent never received is delivered again after the parent settles", () => {
  const probe = harness({ idle: false });
  enqueue(probe.controller, "run-lost");
  probe.controller.handleTurnEnd();
  assert.equal(probe.sent.length, 1);
  assert.equal(probe.last().message.details.resent, false);

  // No confirmation arrives: this is exactly what an interrupted turn does to a
  // queued message, because Pi clears its queues without telling the extension.
  probe.controller.handleAgentSettled();
  assert.equal(probe.sent.length, 2, "the discarded result is delivered again");
  assert.equal(probe.last().message.details.resent, true);
  assert.match(probe.last().message.content, /^\[Background subagent completed\] \(resent\)/);
  assert.deepEqual(probe.last().message.details.results.map((result) => result.id), ["run-lost"]);

  probe.confirmLast();
  probe.controller.handleAgentSettled();
  assert.equal(probe.sent.length, 2, "confirmation stops the re-delivery");
});

test("an interrupted turn holds results in Pi's turn-end-before-agent-end order", () => {
  const probe = harness({ idle: false });
  enqueue(probe.controller, "run-interrupted");
  probe.controller.handleTurnEnd({ stopReason: "aborted" });
  probe.controller.handleAgentEnd([{ stopReason: "aborted" }]);
  probe.controller.handleAgentSettled();
  assert.equal(probe.sent.length, 0, "an aborted turn never re-queues a steering message");
  assert.equal(probe.controller.pendingCount(), 1);

  probe.setIdle(true);
  enqueue(probe.controller, "run-after-interrupt");
  assert.equal(probe.sent.length, 0, "the parent keeps its silence while interrupted");

  probe.controller.handleAgentStart();
  probe.controller.handleTurnEnd({ stopReason: "endTurn" });
  assert.equal(probe.sent.length, 1);
  assert.deepEqual(
    probe.last().message.details.results.map((result) => result.id),
    ["run-interrupted", "run-after-interrupt"],
  );
});

test("a natural settle delivers without waiting for the next turn", () => {
  const probe = harness({ idle: false });
  enqueue(probe.controller, "run-settled");
  probe.controller.handleAgentEnd([{ stopReason: "endTurn" }]);
  probe.controller.handleAgentSettled();
  assert.equal(probe.sent.length, 1);
});

// ─── Bounds, removal, and failure handling ───────────────────────────

test("the pending set stays bounded", () => {
  const probe = harness({ idle: false });
  for (let index = 0; index < MAX_PENDING_RESULTS + 5; index += 1) enqueue(probe.controller, `run-${index}`);

  assert.equal(probe.controller.pendingCount(), MAX_PENDING_RESULTS);
  assert.equal(probe.controller.isPending("run-0"), false, "the oldest results leave first");
  assert.equal(probe.controller.isPending(`run-${MAX_PENDING_RESULTS + 4}`), true);
});

test("deleting a run drops its pending result", () => {
  const probe = harness({ idle: false });
  enqueue(probe.controller, "run-deleted");
  probe.controller.remove("run-deleted");
  probe.controller.handleTurnEnd();
  assert.equal(probe.sent.length, 0);
  assert.equal(probe.controller.pendingCount(), 0);
});

test("a send that never reaches Pi keeps the result pending", () => {
  let fail = true;
  const probe = harness({
    idle: false,
    send() {
      if (fail) throw new Error("extension runtime inactive");
    },
  });
  enqueue(probe.controller, "run-send-failure");

  probe.controller.handleTurnEnd();
  assert.equal(probe.controller.pendingCount(), 1, "a failed send never discards the result");

  fail = false;
  probe.controller.handleTurnEnd();
  assert.equal(probe.sent.length, 1);
  assert.equal(probe.last().message.details.resent, true);
});

test("a session reset clears every pending result", () => {
  const probe = harness({ idle: false });
  enqueue(probe.controller, "run-reset");
  probe.controller.reset();
  assert.equal(probe.controller.pendingCount(), 0);
  probe.controller.handleTurnEnd();
  assert.equal(probe.sent.length, 0);
});

// ─── Confirmation payloads ───────────────────────────────────────────

test("confirmation reads V5 payloads and ignores foreign messages", () => {
  assert.deepEqual(
    notificationResultIds({
      customType: SUBAGENT_NOTIFICATION_TYPE,
      details: { version: 5, results: [{ id: "a" }, { id: "b" }] },
    }),
    ["a", "b"],
  );
  assert.deepEqual(
    notificationResultIds({
      customType: SUBAGENT_NOTIFICATION_TYPE,
      details: { version: 5, results: [{ id: "skipped" }, { id: "" }] },
    }),
    ["skipped"],
  );
  assert.deepEqual(notificationResultIds({ customType: "other", details: { version: 5, results: [{ id: "a" }] } }), []);
  assert.deepEqual(notificationResultIds(undefined), []);
});

await run();
