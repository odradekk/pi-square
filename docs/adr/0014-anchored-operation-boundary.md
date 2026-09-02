---
status: accepted
---

# One per-target operation boundary for anchored editing

ADR-0005 and ADR-0007 describe the anchored-edit feature whose persistence,
read, replace, and write paths grew separately: replace entered Pi's
per-file mutation queue and then took a cross-process lock, the child write
took the lock outside Pi's queue, the parent write joined no anchored lock at
all, and anchored reads joined none of them. A maintainability audit
(odradekk/pi-square#264) demonstrated reachable defects behind that
fragmentation — cross-owner snapshot-cache leaks, a replace preparation that
persisted its candidate before the filesystem write, a bounded-wait lock
order that could refuse a healthy same-process contender, age-based lock
reclaim of live holders, directory-wide temporary-file sweeping, a
two-schemas-under-one-version store, and read-modify-write served sets. This
record supersedes the affected decisions.

## Decision

### One per-target operation boundary

`src/anchored-edit/operations.ts` owns target resolution, in-process queue
participation, cross-process exclusion, disk observation or mutation, and the
matching owner-scoped store transaction for parent and writable-child reads,
replaces, and writes. Tool registration never touches lock files, queue
ordering, filesystem mechanics, cache ownership, or database transactions
directly. The invariant stated in one place and tested there: model-visible
anchors correspond to exact file bytes, belong to one physical store and
owner, and are published only for a completed operation.

### Lock order and contention classification

Pi's per-file mutation queue is the outer in-process serializer and the
anchored cross-process lock is the inner serializer for **every** mutation.
`replace` enters the queue explicitly; parent and child writes are still
constructed from Pi's public write factory, but the anchored write operation
is injected through the factory's supported filesystem-operation seam
(`WriteOperations.writeFile`), so the lock is acquired *inside* the native
queue. This deliberately reopens ADR-0007's accepted same-process lock-order
inversion: the audit showed that bounded waiting converts the internal
circular wait into a false user-facing refusal (or a timeout
misclassification), while one queue-then-lock order cannot deadlock — the
queue is entered first by everyone, so no writer holds the lock while
waiting for the queue.

Anchored reads hold the same target exclusion from reading file bytes
through committing the matching snapshot and served hashes; a read that
cannot enter the boundary returns `[E_FILE_LOCKED]` instead of unanchored
content presented as anchored evidence.

`[E_FILE_LOCKED]` means failure to enter the operation boundary (bounded
wait exhausted or cancelled): an aborted lock wait resolves as classified
contention, never an unclassified throw, and the cancelled operation changes
nothing. The executing tool call's AbortSignal reaches the replace and read
lock waits directly, and the child write composition runs the public factory
execution inside an AsyncLocalStorage signal context (its declared
exception). The parent write has no execution wrapper — the seam authorized
by this record is only the injected filesystem operation — and the
`WriteOperations` seam carries no signal parameter, so the parent write
performs one immediate lock attempt (a zero-wait boundary): a busy target
classifies as `E_FILE_LOCKED` at once with the file untouched, no
cancellable wait exists to outlive an abort, and cancellation
responsiveness stays the factory's own abort checks.
`[E_RANGE_STALE]` is reserved for validation
performed after the lock is acquired against a file that no longer matches
the served range; it keeps returning the current range with fresh anchors
and serving those rows for the immediate retry. The child `requireServed`
gate is unchanged.

### Replace: pure preparation, version-bound authorization, atomic publication

Replace preparation resolves and validates the range and computes the
replacement without changing persistent or cached state. Authorization is
bound to the content version: every served row records the checksum of the
exact content it was served for, and a replace may verify a range only
against rows recorded for the file's current version. Rows recorded for any
other version authorize nothing — for every owner, parent included — so an
external modification (or a mutation whose publication failed, or a process
that died at that boundary) invalidates the previous authorization until a
fresh read republishes current rows. Validation failures carry the observed
content out of preparation (`ReplaceValidationError`) so the coordinator
publishes the refusal's feedback rows version-bound from inside the
boundary: the model's immediate retry with the fresh anchors verifies, while
the older version stays unusable.

The filesystem commit is the irreversible point. After it, the candidate
snapshot and the diff's served rows are published in one repository
transaction while the lock is still held. A post-commit publication failure
never reports that the file was not changed: the result keeps the truthful
mutation success, suppresses fresh anchors, emits a bounded
`[E_STATE_UNAVAILABLE]` warning directing a fresh read, and — through the
version binding above — leaves the pre-mutation state unable to authorize
another replace until a new read republishes current rows. The anchored
write operations hold the same discipline with one stronger mechanism: the
write's state publication is a single `publishWrite` transaction that
clears the previous served rows and installs the written content version's
rows (only when the agent-only auto-read setting serves fresh anchors), so
any post-commit failure rolls the whole transaction back — the previous
version's rows survive untouched, are stale against the written bytes, and
refuse every old anchor (unchanged rows included) until a fresh read. A
store failure after the write is therefore reported as a unified bounded
`[E_STATE_UNAVAILABLE]` note on the truthful success, never as a failed
write and never as a state that still authorizes old anchors. Auto-read-
off, unchanged, and empty writes publish the same clearing transaction with
no new rows: the write-state clearing contract holds for every successful
write, and only a failed publication leaves the stale barrier.

### One owner-aware store schema

The anchor store (schema version 8) has exactly one owner-aware layout; the
owner identity is required by the type and the repository API, so the former
ownerless current-version shape is unrepresentable. One ref-counted physical
connection is cached per store path, and callers receive typed owner views.
Snapshot caches are scoped by physical store, owner, and canonical target;
store eviction, owner deletion, quarantine, and shutdown invalidate only the
state they own and never close a connection with an active borrower. Served
hashes are row-level, version-bound, and merge conflict-free: each
publication merges the rows for exactly one content version and drops other
versions' rows for the path in the same transaction. Owner deletion, multi-path
pruning, and the post-commit publication are explicit transactions. Path
pruning returns absence only for genuine missing-path errors — permission
and resource failures preserve rows and surface bounded diagnostics. A database that
*claims* the current version must also carry the current layout: strict
shape validation (exact table columns and primary keys for `snapshots` and
`served`) treats a version-8 file with deviating tables as an incompatible
layout, so no current-version database is ever probed
statement-by-statement into a missing-column failure. Every incompatible
non-empty layout, including the former ownerless current-version shape, is
quarantined whole with its sidecars and rebuilt fresh; there is no data
migration.

### Lock ownership, publication, and marker-guarded removal

Lock creation publishes a complete owner record (random token, pid, host,
and a strictly-digits process start time where the platform provides it)
atomically by writing an exclusive temporary file and hard-linking it into
place, so no observer ever sees a partial lock; publication failure outside
the held case (EEXIST) propagates — there is no writable fallback that could
expose a partial lock name. A record is attributable only when it satisfies
the complete schema; malformed, pre-token, and non-numeric-start-time
records are unverifiable ownership and fail closed (a garbage start time is
never misread as a start-time mismatch proving pid reuse).

Removal never renames the canonical lock path away after a mere check.
Every remover first publishes a short-lived per-target removal marker
(`<lock>.rm`, the same atomic record protocol) naming the remover process.
While a marker is held, no other remover can act (its marker publish fails)
and no successor can install (the canonical path is still occupied), so the
remover's re-verified single rename-take necessarily grabs exactly the file
it verified — a dead owner's record, or its own acquisition. A stale
verifier that arrives after a successor installed re-reads the canonical
record under its marker, finds a different token, and walks away having
touched nothing: the canonical lock path is never emptied behind a live
successor, so no third writer can slip in and no restore window exists. A
taken file whose identity or token mismatches (defense-in-depth against a
non-protocol actor) is restored with a no-clobber link within the shared
budget, never destroyed. A marker whose holder died is reclaimed through a per-dead-token
claim: a reclaimer must first win an exclusive claim file named after the
dead marker's unique token (one link winner), and only the claim winner
ever takes the marker path — so two stale reclaimers of the same dead
marker can never race a check-then-rename on the marker, and a live marker
installed by another reclaimer is never displaced. If a fresh remover wins
the empty path in the claimant's take-to-publish gap, the claimant backs
off: exactly one holder exists at every instant. A live marker makes the
removal attempt busy and the caller's bounded loop retries; a release
retries busy within its bounded release budget and records an explicit safe
failure on exhaustion (the lock file remains and is reclaimed once the
process is gone). All removal and marker waits share the calling acquire's
deadline and cancellation and end in the classified `[E_FILE_LOCKED]`
outcome.

A lock held by a confirmed-live or unverifiable owner (foreign host, reused
pid, malformed record) is never reclaimed because time elapsed; a crashed
local owner is reclaimed only after a positive determination that the
recorded process is gone: the recorded start time differs from the current
one for that pid (a reused pid proves the original died), or the operating
system confirms the pid is dead. An unreadable start time falls back to the
liveness probe; an ambiguous read is never proof of death. The operation key
is the canonical target path; for an already-existing file with multiple
hard links it is the file's stable identity, so hard-link aliases inside one
workspace lock area coordinate. Different initiating workspaces keep
separate lock areas by construction.

### Parent write seam and structured results

The contributor rule that parent built-in overrides never wrap Pi `write`
execution is narrowed exactly as #264 authorizes: arbitrary execution
wrappers remain forbidden, and an anchored write may inject the minimal
supported filesystem operation needed to join the same queue-then-lock
protocol. The availability gate lives inside that injected operation, not in
an execution wrapper: when the complete anchored surface is unavailable at
operation time (another extension owns the `read` or `write` built-in, or
the anchor store could not be initialized), the injected operation performs
Pi's plain filesystem write with no anchored lock, store mutation, or
recorded outcome, so a half-activated anchored write (locked, store-writing,
but not observable as ours) cannot exist. Because the `WriteOperations`
seam carries no AbortSignal, the parent write's lock wait is bounded and
classifies as `E_FILE_LOCKED`, while cancellation responsiveness stays the
factory's own abort checks — the signal context is used only by the child
write composition, a declared exception. Result, error, and renderer
semantics stay the factory's own. Display decoration stays independent of
execution. The parent write result keeps Pi's factory
wording, and the auto-read appendix is presented by the tool-result
observer from the outcome the injected operation already published — the
observer no longer participates in the state transaction. `replace` returns
structured diff and warning details from its executor; the model result and
operational display consume that structure directly, and the test-only
renderer and its `Warnings:`-parsing round-trip are deleted. Range
resolution returns one discriminated success-or-failure result;
normalization, duplicate-boundary correction, and application consume the
already-resolved range without re-resolving.

### Removed and unchanged

The workspace-confinement mode is removed from the anchored-edit runtime
API, diagnostics, and tests; Pi's native absolute, home-relative,
cwd-relative, parent-relative, and symlink path authority is preserved
everywhere. The session-directory store placement, ephemeral
workspace-keyed fallback, parent owner, child partitioning, partition
bounds, corruption recovery, and busy retry behavior are unchanged.
`replace` remains the only range-editing path with no persistent undo or
revert state. The store's undo-free quarantine-and-rebuild policy from #187
now simply covers one more incompatible layout.

## Superseded decisions

- **ADR-0007, "Cross-process write lock and lock ordering"**: the inverted
  child-write order (lock outside Pi's queue) and the fixed-maximum lock age
  are superseded by the one queue-then-lock order and confirmed-death
  reclamation above. The per-target lock itself, the session-directory lock
  area, and the cross-workspace separation stand.
- **ADR-0005, remaining workspace-store and lock-era trade-offs**: the
  last stale sentences about `.pi/anchored-edit` placement and the
  no-cross-process-lock stage are superseded by the session-directory store
  (already the case since #187's era) and this record's lock rules.
- **ADR-0007, trade-off 4** ("a same-process same-file write and replace
  contend on the lock and the bounded wait decides the loser") is void:
  same-process writer pairs now serialize through the queue before any lock
  wait and both settle deterministically.

## Trade-offs accepted

1. Anchored reads now take the cross-process lock for every read; a read
   contending with a writer refuses with `[E_FILE_LOCKED]` instead of
   serving unanchored content. The lock is per canonical target, so reads of
   different files never contend.
2. Contended replaces return `[E_FILE_LOCKED]` without fresh anchors. The
   anchors would be an observation made outside the boundary, and a retry
   against current content recovers them through `read`.
3. A malformed or foreign-host lock file is never reclaimed; the target
   stays contended (bounded refusal) until the file is removed. This is the
   fail-closed consequence of not treating elapsed age as proof of death.
4. The lock-file name is derived from the operation key (canonical path or
   stable inode identity); stores from before version 8 are quarantined on
   first open and pre-version-8 lock files are unverifiable ownership that
   fails closed, so no in-place migration exists.
5. Version-bound authorization is deliberately stricter than the historical
   behavior: a replace whose target was modified externally — even outside
   the replaced range, with unchanged anchor lines — is refused with
   `[E_RANGE_STALE]` until a fresh read. The refusal carries fresh anchors
   whose immediate retry applies, so the cost is one refused call, not a
   lost edit.
6. The parent write's filesystem seam means an anchored session depends on
   the public `WriteOperations` contract of the pinned Pi version; the plain
   filesystem write performed when anchored editing is disabled or the
   availability gate is closed is unaffected. Because that seam carries no
   AbortSignal, the parent write performs one immediate lock attempt: a
   cross-process holder makes the write refuse with `E_FILE_LOCKED`
   immediately instead of waiting out a budget — a small contention-retry
   cost accepted to keep the parent factory's execution unwrapped and to
   make cancellation leakage structurally impossible.
