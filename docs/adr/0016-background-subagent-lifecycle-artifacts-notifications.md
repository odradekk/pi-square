---
status: accepted
---

# Background-only subagent lifecycle, V4 run artifacts, and V5 notifications

pi-square completes the subagent contract change begun with the
`delegate_subagent`/`resume_subagent` rename: delegation is background-only,
every surface speaks one lifecycle, and the persisted and delivered protocols
are explicit current contracts with no compatibility surface for the retired
foreground protocol.

This ADR governs the background-only execution model, the lifecycle
vocabulary, the run-artifact and prompt-snapshot persistence contracts, and
the background completion notification contract. It supersedes:

- **ADR-0004's `delegate`/`resume` naming decision.** The two tools are
  `delegate_subagent` and `resume_subagent`; the bare names are retired
  completely, with no aliases, migration wrappers, or retired-name
  diagnostics. ADR-0004's reasoning about splitting resume's `id` field into
  its own schema remains in force and is why the two tools stay separate.
  ADR-0004's `fg`/`bg` execution-mode vocabulary is retired with them:
  background is the only execution mode and is no longer a selectable or
  persisted dimension.
- **ADR-0009's lifecycle and delivery-notification portions:** the
  `done`/`error` terminal vocabulary used in delivered results, the V4
  notification payload, and its single-result V3 notification compatibility.
  ADR-0009's reliable-delivery mechanics — the memory-only session-scoped
  pending set, safe delivery timing, transcript confirmation, resend,
  batching, budgets, and bounds — remain in force, extended by the atomic
  result-ownership operations this ADR adds below (the single automatic
  consumer becomes one automatic consumer plus explicitly claiming waiters;
  adapters that never claim, such as Shadow Minds, keep their exact previous
  semantics). The V4 run-artifact break below is this ADR's own decision;
  ADR-0009 governed delivery, not run persistence.

## Decision

### One lifecycle vocabulary

Active background states are `queued`, `running`, and `cancelling`. Terminal
states are `completed`, `failed`, and `aborted`. The background job store,
persisted run records, the `/subagent` manager, the status row, inspection,
retention, resume eligibility, and the calm operational display all interpret
this one vocabulary. The immediate `delegate_subagent`/`resume_subagent`
result is a detached snapshot of the queued record; the display renders it as
the queued lifecycle with the short run ID, and it never reads as a completed
run.

The shared child-session executor keeps its own native outcome contract
(`completed`/`aborted`/`timeout`/`error`), which Shadow Minds also consumes.
The subagent boundary maps those outcomes into the domain states; the executor
itself is unchanged.

### V4 run artifacts

`run.json` advances to version 4. The persisted record carries `operation:
"delegate" | "resume"` instead of an execution `mode`; background execution is
the only mode and is not persisted as a dimension. Only V4 artifacts are
current: they are listed, inspected, rendered, retained, and resumable. A V3
directory left on disk by an earlier version is neither read, listed,
rendered, migrated, nor resumed — it fails the ordinary shape validation and
disappears from every surface, but is never deleted or rewritten by pi-square.

Resume eligibility follows the effective activity lease, not the persisted
phase: an inactive `completed`, `failed`, `aborted`, or stale active record
with no live lease remains resumable under its frozen prompt, model, effort,
tools, skills, cwd, and native history.

### Prompt snapshot V3

The prompt snapshot advances to version 3 and its manifest to contract
version 3. Call-specific policy provenance and `callPolicyHash` are gone from
the schema and the compiler, because the model-callable call-specific SYSTEM
input no longer exists. Definition-owned policy, the inherited parent system
core, governance, instructions, output, context, and field/file provenance
remain.

### V5 notifications

Background completion notifications advance to version 5 and use the current
terminal vocabulary (`completed`/`failed`) in every result entry. Generation,
confirmation, and rendering handle V5 only; the single-result legacy
notification shape and its parsing and rendering compatibility paths are
removed. A V4 notification persisted by an earlier session therefore renders
through the bounded content fallback rather than as a structured run, and
confirms nothing.

### Explicit result ownership (`wait_subagent`)

The confirmed-delivery core gains atomic claim, take, and release operations,
and the parent gains `wait_subagent` as the ordered, bounded consumer of
claimed terminal results (#277). The core owns what is genuinely shared —
synchronization with the automatic flush, the sent-state check, capacity, and
the single-consumer guarantee — while the Subagent adapter owns job
eligibility, terminal-state mapping, result formatting, and the
aborted-result policy.

- `wait_subagent` accepts a strict `ids` array of one to six public IDs,
  deduplicates repeated IDs in first-occurrence order, and validates the
  complete request before any state change: one malformed, unknown, foreign,
  ineligible, already-claimed, or already-sent ID rejects the whole call.
- Only runs of the current parent session are waitable — the boundary is the
  parent session identity, so background jobs an earlier parent session left
  in the process are as foreign as persisted records on disk. Current-session
  queued, running, and cancelling jobs can be claimed before completion; an
  unsent pending completed or failed result can be claimed and returned
  immediately. A result already sent to Pi but not yet transcript-confirmed
  cannot be withdrawn into a wait; a confirmed result and a run that finished
  aborted before being claimed hold nothing to wait for.
- Claimed results stay in the pending store but are excluded from automatic
  delivery and from pending-set eviction. Claims are all-or-nothing, at most
  one waiter owns one ID, and at most 50 reservations are held at once —
  including reservations of active IDs whose results do not exist yet. The
  pending set's 50-result bound stays total: claimed entries count toward it
  but are never evicted, so an incoming unclaimed result is the one dropped
  when every older entry is claimed. Deleting a run's history ends its
  reservation as well; every claim operation is owner-checked, so the
  previous holder wakes and ends deterministically and a stale handle can
  never take or release a later waiter's claim on the same ID.
- The waiter returns only after every claimed run reaches `completed`,
  `failed`, or `aborted`, takes the complete claimed set atomically, and
  returns every entry in requested-ID order. Output reuses the background
  delivery formatter and its budgets with no `(resent)` marker; a failed or
  aborted entry makes the tool result an error without discarding completed
  siblings. The versioned wait details state the ordered IDs, each terminal
  state, and the explicit pending-result consumption, and each entry is an
  explicitly bounded projection: format-bounded identifiers (the public ID,
  the operation, the terminal status), a 300-character task line, and
  4,000-character head/tail-clipped result or error evidence. Every string in
  the projection is bounded by one of those rules — the agent name and the
  model string are omitted precisely because neither has a source-side
  length limit, and the full run record with its prompt snapshot, session
  paths, and unbounded texts never enters.
- Interrupting the wait releases its claims without aborting any child.
  Released completed and failed results rejoin the automatic delivery
  schedule; released aborted results are removed from delivery storage, and
  an aborted outcome enters the store at all only while a waiter already owns
  the ID, so an ordinary aborted run still never notifies the parent.
- Session replacement, reload, and shutdown terminate every outstanding wait
  and clear the memory-only claims together with the pending set.
- While a result is pending or claimed, `resume_subagent` and the `/subagent`
  manager both reject a resume with distinct recovery-oriented errors
  (`RESULT_PENDING`, `RESULT_CLAIMED`), because a new run under the same
  public ID would overwrite unseen output.

### Explicit abort (`abort_subagent`)

The parent gains `abort_subagent` as the wait-aware way to stop selected
background runs (#278), completing the four-tool background-only contract.

- `abort_subagent` accepts the same strict `ids` array as `wait_subagent`
  (one to six public IDs, deduplicated in first-occurrence order) and
  validates the complete selection before any abort signal: one malformed,
  unknown, or foreign ID rejects the whole call and nothing is aborted. Only
  runs of the current parent session are abortable.
- Queued, running, and cancelling targets receive an abort signal through the
  same `cancelBackgroundJobs` seam the `/subagent` manager's Cancel action
  uses, and the tool waits until every active target has actually reached the
  `aborted` terminal state. Once a signal has linearized against an active
  job, abort wins a simultaneous natural-completion race — the lifecycle's
  aborted check resolves a natural completion as `aborted` — while a target
  that was already terminal before the request keeps its real state.
- Already-terminal targets are valid targets and are only reported:
  `completed` without repeating its successful result, `failed` with its
  complete established bounded error, and `aborted` with its abort reason.
  Aborting is not a second result-consumption path.
- A successful abort request is a successful tool call even though its active
  targets end `aborted`; tool-level error is reserved for request validation,
  ownership conflicts, and infrastructure failures. Interrupting the tool's
  own wait — or a session termination ending it — never retracts abort
  signals already sent; the targets keep stopping on their own.
- Abort never claims or consumes a result. A run claimed by `wait_subagent`
  stays owned by that waiter, which receives the aborted terminal outcome
  through the established claimed-aborted delivery policy, and an ordinary
  aborted run still never enters the automatic completion delivery.
- The versioned V1 abort details preserve request order and record each
  target's state before the request, its terminal state, whether an abort
  signal was applied, and its bounded failure or abort reason, under the same
  bounded projection discipline as the wait details.
- The `/subagent` manager keeps its Resume, Fresh, and Cancel interaction and
  adds no Wait action; manager Cancel and `abort_subagent` share the
  cancellation seam and the same lifecycle and safety rules.
- The display follows the calm operational grammar: the selected count while
  stopping, a completed lifecycle for a successful request with truthful
  per-target outcome counts, one ordered expanded row per target, and one
  quiet evidence section for each failed or aborted target.

## Why now

The background-only rename left the domain carrying its retired vocabulary:
`mode` fields with a dead `fg` value, `done`/`error` terminal phases, a
notification version pinned to the batch shape introduced by ADR-0009, and
display code that inferred "queued" from a running record of a background run
kind. Every one of those was a compatibility path for a protocol the tool
surface had already abandoned, and each made the lifecycle harder to state
truthfully — the immediate tool result literally reported `phase: "running"`
while presenting as queued.

Publishing explicit versions lets the artifact and notification contracts
carry exactly the current shape: no union types, no legacy parsing, no
defensive spellings for values that can no longer occur.

## Trade-offs accepted

1. **A hard artifact break.** Records written by the previous release become
   invisible to the manager and unresumable. This is deliberate: migrating
   them would require inventing foreground semantics the current surface no
   longer has. The directories stay on disk so a user can inspect or delete
   them manually, and a fresh delegation replaces the lost continuity.
2. **Undelivered V4 notifications confirm nothing after upgrade.** The
   pending set is memory-only by design (ADR-0009), so at most the current
   session's unconfirmed results are affected at the moment of upgrade.
3. **The immediate tool result is a snapshot, not a live view.** The caller
   observes the queued record as it was at return time; execution progress
   flows through the status row, the manager, and the completion delivery.

## Precedents

- **ADR-0002** established the retirement mechanic this ADR reuses for the
  bare `delegate`/`resume` names and the foreground protocol.
- **ADR-0009** remains authoritative for the reliable-delivery core this ADR
  builds on; only its lifecycle and delivery-notification portions are
  superseded here.
- **ADR-0015** recorded the same explicit-supersession style over ADR-0004's
  GitHub-tool portion.

## Completion

With the explicit abort recorded above, the parent specification (#274) is
complete: delegation and resume queue background-only, waiting is explicit and
ownership-transferring, aborting is explicit and wait-aware, and the four
parent-only tools — `delegate_subagent`, `resume_subagent`, `wait_subagent`,
and `abort_subagent` — form one contract over one lifecycle vocabulary.
