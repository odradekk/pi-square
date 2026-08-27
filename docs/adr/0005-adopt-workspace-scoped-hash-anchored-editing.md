---
status: accepted
---

# Adopt workspace-scoped hash-anchored editing

Pi's built-in `edit` tool finds an exact text fragment. It cannot identify a
particular copy of repeated text, and it can silently overwrite an edited range
that changed after the model read it.

## Decision

pi-square makes hash-anchored editing the default parent-session editing path.
Pi's factory `read` adds unique three-character anchors to model-visible
workspace text. The parent exposes `replace` and `revert`, and removes Pi's
built-in `edit` from the active parent tool list. Set the agent-only
`anchoredEditing.enabled` setting to `false` to restore factory-faithful Pi
`read` and `edit`; this does not alter existing anchor-store data.

`replace` names an inclusive anchor range, verifies that every target row was
served and still matches disk content, then writes through the existing atomic
path. `revert` restores the one previous successful replace for a file. The
agent-only `anchoredEditing.autoRead` setting defaults to `true`: successful
changed Pi `write` calls append bounded fresh anchors, while successful
`replace` and `revert` retain their authoritative anchored diffs. Disabling it
suppresses those post-edit anchors but still clears write state.

The project-local `.pi/anchored-edit/hash-store.sqlite` holds snapshots, served
state, and one revert record per `parent` owner and file. A replace persists the
record before changing the file. If that persistence fails, the replace does
not write. If its write fails, the prior record is restored. A revert checks
that current file bytes equal the recorded replacement result before it restores
the saved normalized content, byte order mark, detected line-ending style, and anchors. A successful
explicit Pi `write` clears the record and served state for that workspace file;
a failed write does not.

The feature is limited to canonical workspace text paths, including symlink
resolution. Paths outside the workspace remain a Pi built-in workflow after
anchored editing is disabled. Writable child sessions receive anchored editing
under capability resolution; see ADR-0007.

## Alternatives considered

1. **Keep Pi's built-in `edit`.** It does not give an edit range a stable line
   identity or reject a stale served range. It cannot meet the conflict-safety
   requirement.
2. **Depend on the upstream package at runtime.** The upstream package registers
   its own tools, commands, and session hooks, owns a user-global store, and has
   a different Pi integration boundary. A runtime dependency would not preserve
   pi-square's parent-only registration, workspace store, public-factory, or
   model-schema contracts.
3. **Reimplement hash-anchored editing.** The upstream implementation already
   supplies the hashing, reference validation, persistence, error-code, and
   regression-test behavior needed here. Reimplementation would duplicate that
   mature behavior and make upstream regressions harder to compare.

pi-square therefore ports the upstream source into `src/anchored-edit/`, retains
its regression suite, and adapts only the integration seams required by this
repository. The vendored source and exact upstream provenance are recorded in
`THIRD_PARTY_NOTICES.md`.

## Trade-offs accepted

1. History is single-level per file. A successful revert consumes its record.
2. The implementation did not add a cross-process write lock at this stage; a
   revert refused a file that changed after the saved replace instead of
   overwriting it. Superseded by ADR-0007, which adds the cross-process write
   lock with a fixed lock ordering.
3. The feature is workspace-bounded. Paths outside the canonical workspace use
   Pi's built-in tools after the feature is disabled. Superseded for the parent
   surface by the native path authority change (#185): parent anchored read,
   `replace`, `revert`, and write-state handling accept the same paths as Pi
   0.84.2's native tools. Child anchored surfaces keep this boundary until
   their own native-authority slice.
4. The public tool is named `revert`; the vendor implementation and its retained
   regression suite keep the upstream `undo_last_replace` name internally.

## Partially superseded: native path authority (#185)

Trade-off 3 above no longer holds for the parent surface. Parent anchored
read, `replace`, `revert`, and write-state handling now preserve Pi 0.84.2's
native path authority — absolute paths, `~` paths, cwd-relative paths
(including `../`), and canonical targets reached through symlinks — with no
workspace-containment refusal. State for every target, external ones
included, stays attributed to the workspace that initiated the operation,
and two different workspaces intentionally keep independent external-target
state and locks (an accepted last-write-wins possibility matching Pi's
native cross-workspace behavior). Child anchored surfaces retain the
workspace boundary until their own native-authority slice.

## Superseded by ADR-0007

The statement in the decision that the revert record is per `parent` owner is
superseded: the record is single-level per file across all owners, owned by the
most recent editor. ADR-0007 also covers the ownership, retention, capability
resolution, and concurrency rules for anchored editing in child sessions.

## Vocabulary note

`anchor`, `served state`, and `anchor store` are durable terms not yet defined in
`CONTEXT.md`. This ADR records the gap for a future domain-modeling task; it
does not add competing glossary definitions.
