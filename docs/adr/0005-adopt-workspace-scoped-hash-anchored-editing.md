---
status: accepted
---

# Adopt workspace-scoped hash-anchored editing

Pi's built-in `edit` tool finds an exact text fragment. It cannot identify a
particular copy of repeated text, and it can silently overwrite an edited range
that changed after the model read it.

## Decision

When the agent-only `anchoredEditing.enabled` setting is true, pi-square uses
three parent-only tools for workspace text files:

- Pi's factory-faithful `read` returns unique three-character anchors in its
  model-visible text content.
- `replace` names an inclusive anchor range, verifies that every target row was
  served and still matches disk content, then writes through the existing atomic
  path.
- `revert` restores the one previous successful replace for a file.

The project-local `.pi/anchored-edit/hash-store.sqlite` holds snapshots, served
state, and one revert record per `parent` owner and file. A replace persists the
record before changing the file. If that persistence fails, the replace does not
write. If its write fails, the prior record is restored. A revert checks that
current file bytes equal the recorded replacement result before it restores the
saved content, byte order mark, line endings, and anchors. A successful explicit
Pi `write` clears the record and served state for that workspace file; a failed
write does not.

The setting is agent-only. A project configuration cannot enable or disable it.
When the setting is enabled, the Pi built-in `edit` tool is removed from the
active parent list. When disabled, Pi's built-in read and edit behavior remains
factory-faithful. Child sessions do not receive the anchored tools.

## Trade-offs accepted

1. History is single-level per file. A successful revert consumes its record.
2. The implementation does not add a cross-process write lock. A revert refuses
   a file that changed after the saved replace instead of overwriting it.
3. The feature is workspace-bounded. Paths outside the canonical workspace use
   Pi's built-in tools after the feature is disabled.
4. The public tool is named `revert`; the vendor implementation and its retained
   regression suite keep the upstream `undo_last_replace` name internally.

## Vocabulary note

`anchor`, `served state`, and `anchor store` are durable terms not yet defined in
`CONTEXT.md`. This ADR records the gap for a future domain-modeling task; it does
not add competing glossary definitions.
