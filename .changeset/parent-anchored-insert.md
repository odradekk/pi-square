---
"@odradekk/pi-square": minor
---

Add the parent-only anchored `insert` tool (#285)

- `insert` adds one or more literal lines immediately before or after one observed 3-char HASH anchor in an existing non-empty file, through the same per-target operation boundary, safety, publication, and calm operational display treatment as anchored `replace`; the anchor line itself is never modified and the request is a strict object schema (`anchor`, `direction` ∈ {`before`, `after`}, `lines`) with no replace-specific fields.
- Insertion authorization is version-bound and mandatory for every owner, the parent included: the target anchor must have been served for the file's exact current content version, and stale, ambiguous, or unserved refusals change nothing and return bounded current anchored context whose immediate retry is authorized.
- A successful insert returns an authoritative anchored unified diff and accurate metrics (inserted lines added, zero removed); under `anchoredEditing.autoRead` the diff's visible rows are served as fresh anchors, and a post-commit state-publication failure keeps the truthful success with a bounded `[E_STATE_UNAVAILABLE]` warning.
- `Insert` joins the operational display's mutation family with normalized-path targeting and diff-only success evidence; anchored-read and editing prompts now prefer `insert` for adjacent additions and `replace` for modification or deletion, while the `replace` API and behavior are unchanged.
- Empty-file insertion, empty-string line items, the writable-subagent edit capability, and Shadow Minds mutation observation stay outside this slice (follow-ups #286, #287, #288).
