---
"@odradekk/pi-square": minor
---

Observe anchored insert mutations in Shadow Minds (#288)

- The automatic `mutation` trigger's closed Pi/pi-square mutation-tool set now includes the parent `insert` tool introduced by #285, alongside `edit`, `write`, and `replace`.
- An `insert` counts as a mutation only from its structured successful outcome (`metrics.classification: "applied"`), never from the invocation alone: stale, unserved, ambiguous, invalid, and locked refusals, cancellations before the commit, and failed calls never fire a false review trigger, while a successful insert carrying autocorrection warnings does.
- The truthful post-commit rule is preserved: an insert whose file commit succeeded but whose anchor-state publication later failed keeps its `applied` classification and remains an observed mutation.
- The Shadow trajectory projection exposes only the bounded safe `path` field for `insert`; anchors, directions, line payloads, and diff bodies never reach a Shadow run's evidence.
- `insert` stays excluded from the strictly read-only Shadow-safe tool catalog: requesting it drops with a warning and requiring it fails before prompting, so Shadow children can never execute it.
