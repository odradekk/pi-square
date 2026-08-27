---
"@odradekk/pi-square": major
---

Remove anchored-edit revert and rebuild the undo-free store (odradekk/pi-square#187, final slice of #183).

- The parent and writable-child revert tools, the undo table and every persistent undo concept (records, pre-replace persistence, write undo cleanup, owner-authority rules, retention exceptions, `[E_UNDO_STALE]`, `[E_UNDO_OWNER]`, `[E_UNDO_UNAVAILABLE]`, prompts, and presentation) are removed rather than left dormant. `replace` is the only range-editing path on every surface; recovery from an unwanted edit is a follow-up `replace` through its returned diff rows or a new read.
- The anchor-store schema advances to an undo-free version. The first open of an older store — a stored schema version that is not current or any database still carrying the `undo` table — quarantines the database and sidecars once and rebuilds a fresh store; cached snapshot and served state are lost explicitly and recover through a new read, corruption quarantine still works, and a fresh store produces no migration residue.
- Served gates, snapshots, auto-read, owner partitions, mutation queues, cross-process locks, and native path authority from #185/#186 are unchanged and stay covered.
- Model-visible tool contracts, display catalogs, child activity formatting, smoke coverage (external read → replace → write and the replace-only active-tool list), docs, and ADRs match the replace-only surface.
