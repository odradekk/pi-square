---
"@odradekk/pi-square": minor
---

Grant the anchored `insert` tool to writable subagents through the `edit` capability (#287)

- A writable child that declares `edit` with anchored editing on now receives the renderer-free anchored `replace` and `insert` definitions under its own anchor-store owner, and Pi's built-in `edit` tool stays absent; the effective child allowlist gains both anchored names while every unrelated requested capability is unchanged, and fresh and resumed sessions re-resolve the capability to the same surface.
- Child inserts verify the target anchor against the child's own served rows for the exact current content version, like the parent insert: a call naming anchors the child never read is refused recoverably with `[E_RANGE_STALE]` and fresh feedback rows, so the immediate retry succeeds; blank-line, empty-file initialization, external-target, and missing-target semantics match the parent tool, and the shared operation boundary keeps parent/child serialization, cross-process locking, and truthful post-commit behavior.
- `insert` stays capability-only: requesting it by name in `tools` or `extensionTools` is rejected with the anchored capability-gated error, and it is not part of the ordinary child extension tool catalog.
- Child tool summaries name the insert target file, and an anchored insert refusal renders as a warning qualifier (an anchored refusal, not a failed call) in activity, manager, and notification views.
