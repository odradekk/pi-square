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
nothing. The executing tool call's AbortSignal reaches every lock wait —
replace and read carry it directly, and the anchored write compositions run
the public factory execution inside an AsyncLocalStorage signal context
because the `WriteOperations` seam has no signal parameter. `[E_RANGE_STALE]`
is reserved for validation
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
write operations hold the same discipline: everything after their
filesystem write is post-commit, so a store failure there is reported as a
bounded actionable note on the truthful success, never as a failed write,
and the write's signal is checked before any filesystem effect (a cancelled
wait writes nothing).

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
and resource failures preserve rows and surface bounded diagnostics. Every
incompatible non-empty layout, including the former ownerless
current-version shape, is quarantined whole with its sidecars and rebuilt
fresh; there is no data migration.

### Lock ownership, publication, and verified removal

Lock creation publishes a complete owner record (random token, pid, host,
and process start time where the platform provides it) atomically by writing
an exclusive temporary file and hard-linking it into place, so no observer
ever sees a partial lock; publication failure outside the held case
(EEXIST) propagates — there is no writable fallback that could expose a
partial lock name. A record is attributable only when it satisfies the
complete schema; malformed and pre-token records are unverifiable ownership
and fail closed.

Removal never unlinks by path after a check. It takes the file atomically
with `rename` to a unique retirement name, then deletes it only when *both*
proofs hold: the taken file's node identity matches the identity the remover
verified beforehand, and the unique acquisition token inside the taken
record matches the token of the record that was verified. The second proof
exists because inode reuse inside one coarse birthtime window can falsify
identity alone. On a mismatch — a racing reclaimer retired the verified file
and a successor installed in between, or an inode was reused — the taken
file is foreign: it is restored with a no-clobber hard link as soon as the
lock path is free (a bounded wait that ends by preserving the file at its
retirement name and surfacing the displacement), and a foreign lock is never
destroyed or clobbered. Because a live owner is never reclaimed, a holder's
own release always finds exactly its own file.

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
execution is narrowed: arbitrary execution wrappers remain forbidden, but an
anchored write may inject the minimal supported filesystem operation needed
to join the same queue-then-lock protocol, and the registered write
definition adds exactly one execution-entry gate — when the anchored surface
is unavailable at execution time (another extension owns the built-in, or
the anchor store could not be initialized), execution falls back completely
to the plain native factory, so a half-activated anchored write (locked,
store-writing, but not observable as ours) cannot exist; the gate also runs
the factory execution in the write-signal context so cancellation reaches
the injected lock wait. Result, error, and renderer semantics stay the
factory's own. Display decoration stays independent of execution. The parent write result keeps Pi's factory
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
   the public `WriteOperations` contract of the pinned Pi version; the
   plain-factory fallback (anchored editing disabled, or the execution-entry
   gate closed) is unaffected.
