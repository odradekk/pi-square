---
status: accepted
---

# Background-only subagent lifecycle, V4 run artifacts, and V5 notifications

> Status note: since #303 the compact subagent status row this ADR referenced
> is retired. Subagent observability now publishes through the session-scoped
> vertical child roster (`src/subagents/roster.ts`) above the editor — a
> read-only projection of the background job store with no durable state, no
> retention exemption, and no delivery interaction — and `undelivered`
> visibility lives solely in the `/subagent` manager. Where this ADR says the
> status row, read the roster. Since #304 the roster is also keyboard-selectable
> from an exactly empty native editor, and Enter opens the selected child in a
> centered, capturing, read-only transcript overlay (`src/subagents/viewer.ts`)
> built on Pi 0.84.2 public components and the roster-grade allowlisted tool
> projection (no raw arguments or result payloads ever render). Pi's native
> assistant grouping stays intact before the shared operational display renders
> its tool rows with the shared marker motion, outer-entry elapsed time, muted
> structural target, and fixed terminal outcome; tool results update pending calls
> in place. Unsupported parts
> remain visible afterward through fixed fallbacks, and arbitrary provider
> and artifact diagnostics remain outside the overlay in favor of closed
> lifecycle/error-code states; viewing is
> observational only and never touches the lifecycle, delivery, ownership, or
> persistence contracts this ADR records. Since #305 the overlay pages the
> child's complete persisted history on demand (`src/subagents/child-history.ts`):
> bounded byte pages read tail-first from the validated native session file
> through the same artifact identity boundary as resume — which requires a
> directly named regular file and rejects symlinks even inside the artifacts
> directory — byte-level stitching of only newline-terminated records in both
> paging directions (an unterminated final line stays the running child's
> incomplete append, and a record larger than one page stitches forward too),
> per-read verification that pre-open path, opened descriptor, and post-open
> path retain one regular-file dev/ino identity, minimal native-envelope
> validation (non-empty `type`
> and `id`, unique within the loaded window), independent older/newer bounded
> retryable page errors that keep validated pages visible even when a page
> projects no transcript rows, a hard 480-item and 64-parsed-page in-memory
> window whose oversized pages keep a window into their own parse with
> far-end trimming that stays reachable in both directions and whose
> metadata-only pages compact without displacing the current visible anchor,
> stable native-entry-identity plus entry-local-ordinal positioning, and
> cross-page result consumption that survives either adjacent page's reload —
> with no second transcript store, cache, index, sidecar, lock, journal, or
> artifact version beside the native session file. Since #306 the overlay is
> live while the child runs: the one-time child execution boundary derives
> ordered bounded view events (assistant deltas as ordered text/thinking parts,
> message completion, tool start/update/end, tool-result completion, and run
> lifecycle) after its own run-state bookkeeping and hashes native call IDs
> before they enter the feed. An unobserved child retains no events. For an
> open observer, publication only enqueues into the session generation's hard-
> bounded ordered FIFO; omission markers count inside the same cap. Ordinary
> updates drain one per scheduler tick. Before a queued structural boundary,
> superseded no-op tool updates are discarded and cumulative assistant deltas
> reduce to their newest state; the remaining ordered prefix drains through
> the newest boundary while a 25 ms total flush budget remains, and a slow
> observer yields the remainder. The default two-stage scheduler gives the
> child a continuation turn before viewer work and never invokes a subscriber
> inside the child's event dispatch. A real 25 ms
> JavaScript watchdog interrupts and evicts a throwing or blocked subscriber;
> scheduler failure never falls back inline. Parent-session replacement
> installs a new feed generation, and a running child keeps its publisher
> captured to the old generation, so late events cannot enter the replacement.
> The open overlay renders a bounded live tail below persisted history through
> the same sanitized assistant and roster-grade tool projections, coalesces
> ordinary repaint requests through one controller-owned timer (~110 ms), and
> repaints structural events at their first flush. Immediately before Pi 0.84.2
> persists each completed message, the event captures the native session JSONL
> size; persisted projections carry their exact line-start byte offsets. A live
> completion reconciles only against the same bounded content hash and native
> timestamp whose line begins exactly at that pre-append floor. Pi persists
> each message-end before emitting the next, so equal occurrences remain exact across delayed
> delivery and demand paging without a lifetime consumed-occurrence ledger. A
> missing floor or byte offset fails closed and leaves the bounded live row or
> omission marker visible.
> Live and persisted tool rows share the same non-reversible hash of the full
> native call ID. Overflow sheds oldest-first, keeps unknown drops visibly
> sticky, and clears a terminal-tool fingerprint only after its result appears.
> A child that terminalizes while open stays open with final lifecycle and
> content. Observer and renderer failures remain bounded presentation failures
> and never touch the lifecycle, delivery, ownership, or persistence contracts
> this ADR records.
> Since #307 the overlay also carries cross-child navigation and per-child
> reading state: while it is open, Up/Down move a roster candidate anchored on
> the open child and Enter re-points the same overlay handle at the candidate
> in place — no stacking, no return to main — while Escape cancels a changed
> candidate before it ever closes. Transcript scrolling (PageUp/PageDown/Home/
> End, plus the mouse wheel in fullscreen TUI mode where the alt screen defers
> wheel events to the focused overlay) stays separate from roster navigation;
> the first open follows the tail, upward scrolling suspends following with a
> one-row footer new-output state that End clears while resuming follow; the
> footer also names an off-screen candidate's role and unique short ID while a
> candidate is tentative; each child independently retains its loaded history
> view, scroll position, follow state, and tool-expansion state across direct
> switches (retained only while the overlay session is open); and Pi's
> effective expand-tools shortcut toggles only the open overlay's tool
> rendering, never the background main transcript. Every view-state transition
> stays observational only — no lifecycle, delivery, ownership, claim, wait,
> abort, resume, or persistence effect.
> The remaining lifecycle/delivery qualification of the parent viewer
> specification (#302) remains in later slices (#308–#309).

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
persisted run records, the `/subagent` manager, the roster (the former status
row, retired by #303), inspection,
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
- Queued and running targets receive this request's abort signal through the
  same `cancelBackgroundJobs` seam the `/subagent` manager's Cancel action
  uses, and the tool waits until every active target has actually reached the
  `aborted` terminal state. A target that was already cancelling keeps the
  signal of its earlier cancellation — the seam's cancelling branch sends no
  new signal — so the request truthfully reports that it applied none and only
  waits for that stop to complete. Once a signal has linearized against an
  active job, abort wins a simultaneous natural-completion race — the
  lifecycle's aborted check resolves a natural completion as `aborted` — while
  a target that was already terminal before the request keeps its real state.
- Already-terminal targets are valid targets and are only reported:
  `completed` without repeating its successful result, `failed` with its
  complete established bounded error, and `aborted` with its abort reason.
  Aborting is not a second result-consumption path.
- A successful abort request is a successful tool call even though its active
  targets end `aborted`. Tool-level error marks a request that was rejected —
  validation, ownership, or infrastructure failure — or one whose
  terminal-state observation could not complete: an interrupted tool wait, or
  one ended by a session replacement or shutdown, has not observed every
  target's final state and reports that failure truthfully without fabricating
  complete details. Abort signals already sent are never retracted; the
  targets keep stopping on their own.
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
  cancellation seam and the same lifecycle and safety rules, and the manager
  lists and cancels only the current parent session's active jobs — the live
  job record is re-checked for session ownership at action time, never trusted
  from the rendered snapshot.
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
   flows through the roster (the former status row, retired by #303), the
   manager, and the completion delivery.

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
