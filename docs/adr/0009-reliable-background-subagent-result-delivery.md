---
status: accepted
---

# Reliable background subagent result delivery

> Status note: ADR-0016 supersedes the portions of this decision that named
> the terminal vocabulary (`done`/`error`) for delivered results and defined
> the V4 notification payload with its single-result V3 notification
> compatibility. The reliable-delivery mechanics themselves — the pending set,
> safe timing, confirmation, resend, batching, budgets, and bounds — remain in
> force. ADR-0016 additionally extends this pending set with the atomic
> claim/take/release result-ownership operations of `wait_subagent`: claimed
> results are excluded from automatic delivery and eviction under a
> 50-reservation bound with a single-consumer guarantee, while every adapter
> that never claims — Shadow Minds included — keeps exactly the automatic
> semantics recorded here.

Background subagent results were sent with one fire-and-forget
`pi.sendMessage` for each finished run, clipped to 1600 characters. Two defects
follow from that design, both reproduced against a live Pi 0.84.2 session:

- **Truncation.** A probe that returned 6022 characters reached the parent as
  1597 characters plus `...`; about 73 percent of the result was destroyed. The
  foreground path never had this limit, so the same run returned complete
  through `delegate` and incomplete through a background run.
- **Loss.** Ten background results were delivered in the reproduction, but each
  one consumed a full parent turn, because Pi drains one queued steering
  message per turn boundary (`steeringMode` defaults to `one-at-a-time`). While
  results wait in that queue, `restoreQueuedMessagesToEditor({abort:true})`
  (the ESC path) calls `clearAllQueues()`, which discards queued custom
  messages. They are not restored to the editor, they never appeared in the
  pending-message indicator, and the extension receives no abort event, no
  queue event, and no send failure. A discarded result was unrecoverable.

## Decision

### pi-square owns the pending set

`src/subagents/delivery.ts` owns every finished `done` or `error` run until the
parent confirms it. The background lifecycle no longer calls `sendMessage`; it
hands the run to the controller.

### Delivery happens only at a safe moment

- A running parent receives results at the next `turn_end`, as one message.
- A parent that settled naturally receives them at once, which starts one turn.
- A parent whose run ended through a user interruption (a message with
  `stopReason: "aborted"`) receives nothing until it starts its next turn.

### Confirmation, not hope

A result counts as delivered only when Pi injects the carrying message into the
parent transcript, observed through `message_start` and matched by run ID. A
result that is still unconfirmed when the parent settles was discarded, because
Pi drains its queues before a run settles; it is delivered again and marked
`(resent)`. Re-delivery has no attempt limit and is throttled by the turn
boundary itself. A `sendMessage` that throws leaves the result pending.

### One delivery carries several results

Up to six results are coalesced into one message; the surplus follows at the
next safe moment. A burst of background completions therefore costs one parent
turn instead of one turn for each result. The payload described here as V4
with single-result V3 compatibility is superseded by the V5 notification of
ADR-0016, which carries the current terminal vocabulary and no legacy
parsing.

### Budgets

Each result text is bounded at 24,000 characters, and a failure text uses the
same bound. An oversized text keeps its head (70 percent) and its tail (30
percent) with a visible `[omitted N characters]` marker, because a subagent
report states its conclusion at the end. The task line stays at 300 characters;
it identifies the run and is not the result.

### Bounds and visibility

The pending set holds at most 50 results and drops the oldest beyond that. A
finished job whose result is still pending is exempt from the 20-job
compaction, because compaction would otherwise destroy the only copy. The
native subagent status shows `undelivered N`, and the `/subagent` manager marks
the individual runs. Deleting a run's history removes it from the pending set.

### Session scope

The pending set is memory-only and is cleared on session start and shutdown.
Nothing is persisted, and no result is delivered across parent sessions.

## Consequences

- A background result now survives an interrupted turn, a discarded queue, and
  a failed send inside the session that started the run.
- The parent context can receive up to six results in one message, each up to
  24,000 characters. The former implicit protection (a hard 1600-character
  clip) is gone by intent; the explicit budget and the batch bound replace it.
- Delivery timing is pi-square's responsibility now. A defect in the timing
  rules delays results rather than losing them, because the pending set is only
  cleared by confirmation, by explicit removal, or by the session ending.
- Two limits are deliberate. A run cancelled by the user still sends no
  notification, and a result that is pending when the session ends is dropped
  rather than delivered to the next session.
