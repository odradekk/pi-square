---
status: accepted
---

# Extend hash-anchored editing to writable child sessions

ADR-0005 made workspace-scoped hash-anchored editing the parent-session editing
path and recorded that child sessions do not receive the anchored tools. Since
then the anchored mechanics that were parent-only have been extended to
writable subagents, and the ownership, resolution, and concurrency rules that
govern that extension have accumulated across several decisions. This record
captures those rules in one place and states the two deliberate departures from
earlier decisions.

## Decision

### Owner-scoped served state

Each agent's served rows and revert history live in the project store
`.pi/anchored-edit/hash-store.sqlite`, partitioned by an owner. The parent uses
the `parent` owner; a writable subagent uses its own subagent ID as the owner.
A parent read and a child read never share a served record, and two children
never share one. A child `replace` verifies against the child's own served
record (`requireServed`), so a child that names anchors it never read for
itself is refused with the recoverable `[E_RANGE_STALE]` code and served the
current range for an immediate retry.

### Capability-name resolution is an intentional alias

Bundled and user subagent definitions name the Pi built-in `edit` capability.
When anchored editing is enabled and a writable child declares that capability,
it resolves to the same anchored `replace` and `revert` tools the parent uses,
the built-in `edit` tool is removed so the child has exactly one range-editing
path, and a writable child also receives the anchored `write` (Pi's public write
factory with the same name). When anchored editing is disabled, the same
definition resolves to Pi's built-in `edit` and no anchored tools. A resumed
child re-derives this mapping from its persisted logical selection against
current configuration.

That is an alias: one capability name resolves to different tools depending on
configuration. The anchored tool names themselves (`replace`, `revert`, `write`)
are capability-only: they are granted only through the `edit` capability (and,
for `write`, the built-in `write` capability) and are rejected when requested by
name in a definition. Read-only roles and disabled anchored editing receive no
anchored tools.

This departs deliberately from ADR-0002's established mechanic, which retired
low-usage tools under the rule that a retired name stays invalid rather than
becoming an alias. The departure is justified because the two cases are not the
same kind of name: `edit` is a Pi built-in capability name that Pi itself
resolves through its session tool registry, not a pi-square extension tool that
pi-square retired. The definition's stable contract is the capability; the tool
that satisfies it changes with configuration, and pi-square keeps the anchored
resolution targets out of the capability namespace by rejecting them by name.

### Asymmetric revert authority

The revert record is single-level per file across all owners: `saveUndo`
replaces any prior record from any owner, and a rollback restores the prior
record under its own owner, so exactly one record per file exists and is owned
by the most recent editor. Revert authority is asymmetric. The parent
registration passes `revertAnyOwner: true`, so the parent can revert the most
recent edit to a file regardless of which agent made it and a supervisor can
roll back a subagent's mistake exactly. A child revert keeps
`revertAnyOwner: false` and is refused with the distinct `[E_UNDO_OWNER]` code,
naming the owning agent, when it targets a record it does not own. A successful
write clears the file's single revert record whoever recorded it.

The parent's authority to revert any agent's edit is bounded by child history
retention. The single revert record lives under the owner that made the edit,
so the parent can only revert it while that child's partition is retained.
Dropping the child's artifacts, including the automatic orphan reconciliation
at parent-session start, removes the record and with it the parent's ability to
revert that edit.

### Cross-process write lock and lock ordering

> Superseded by [ADR-0014](0014-anchored-operation-boundary.md) (#264): all
> mutations now use one queue-then-lock order — the child write joins the
> queue through the write factory's filesystem-operation seam — anchored
> reads hold the same exclusion, locks publish complete atomic owner records
> reclaimed only on confirmed local death (never by age), and contention is
> reported as `[E_FILE_LOCKED]`. The section below records the superseded
> history.

Anchored `replace`, `revert`, and the child anchored `write` take a
cross-process per-target-file write lock held across served-state verification
and the write and released after. Lock files live under
`.pi/anchored-edit/locks/` (Git-ignored), are keyed by the SHA-256 of the
canonical target so parallel edits to different files never contend, record the
owning pid and acquire time, and are reclaimed on the next attempt when the
owning process no longer exists or the lock is absurdly old. A bounded wait
ends in a recoverable refusal rather than an indefinite block: `replace`
refuses with `[E_RANGE_STALE]` carrying the current range with fresh anchors,
while `revert` and the child write refuse with `[E_FILE_LOCKED]` and leave
state (including the revert record) intact for a retry.

The lock ordering invariant is fixed: `replace` and `revert` enter Pi's
per-file mutation queue and then take the cross-process lock, while a subagent
`write` takes the lock outside Pi's write because that queue is not re-entrant.
A same-file `write` and `replace` in one process therefore invert the order and
rely on the bounded lock wait to end in a recoverable refusal rather than a
deadlock. This coexists with Pi's per-session mutation queue without
deadlocking, and a second Pi session in the same workspace comes under the same
discipline.

## Departures from earlier decisions

- **ADR-0002** recorded that a retired name stays invalid rather than becoming
  an alias. This record departs from that for the `edit` capability name: it is
  an intentional alias because it is a Pi built-in capability, not a retired
  pi-square extension tool, and the anchored resolution targets stay out of the
  capability namespace. See "Capability-name resolution".
- **ADR-0005** recorded that child sessions do not receive the anchored tools,
  that the revert record is per-parent-owner, and that the implementation does
  not add a cross-process write lock. All three are superseded here: writable
  children receive anchored read, replace, revert, and write; the revert record
  is single-level per file across all owners; and the cross-process write lock
  with its fixed ordering is in place. The departure is justified because the
  per-owner store, the asymmetric revert authority, and the cross-process lock
  give writable children the same conflict-safety guarantees the parent has, so
  the earlier parent-only exclusion no longer serves its purpose.

## Trade-offs accepted

1. History stays single-level per file across all owners; a successful revert
   consumes its record.
2. The parent's revert authority depends on the editing child's history
   retention, as bounded and evicted by the child partition policy.
3. The capability alias means a definition that names `edit` does not name the
   tool that will run; the resolution depends on configuration and is re-derived
   on resume.
4. A same-process same-file write and replace contend on the lock and the
   bounded wait decides the loser, rather than a strictly ordered internal
   queue for the write path.

## Superseded by #187 (undo-free store)

The undo-record, revert-authority, and retention-exception sections of this ADR
are superseded: the child and parent revert tools, the file-global undo record,
the `[E_UNDO_OWNER]`/`[E_UNDO_STALE]`/`[E_UNDO_UNAVAILABLE]` codes, and the
`hasUndo` retention exception were removed with the undo-free store schema. The
writable-child capability mapping resolves `edit` to the anchored `replace`
alone — superseded in turn by #287, which grants the anchored `insert` through
the same capability under the child's own owner; partition retention, the
served gate, lock ordering, and native path
authority are unchanged. Points 1 and 2 above are void; points 3 and 4 stand.

## Superseded by #264 (one operation boundary)

The lock-ordering trade-off above (point 4 included) is superseded by
[ADR-0014](0014-anchored-operation-boundary.md): every mutation now enters
Pi's per-file mutation queue first and takes the anchored cross-process lock
inside it, anchored reads hold the same target exclusion from bytes through
publication, the parent write joins the protocol through the public write
factory's filesystem-operation seam, and lock ownership is a complete atomic
record reclaimed only on confirmed local death. The owner-scoped store is
schema version 8 with one owner-aware layout and one connection per store
path (ADR-0014).
