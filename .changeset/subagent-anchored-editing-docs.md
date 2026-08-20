---
"@odradekk/pi-square": minor
---

Document subagent anchored editing. A new decision record (ADR-0007) captures the ownership, capability-resolution, asymmetric revert authority, and cross-process lock rules for anchored editing in child sessions, states that the `edit` capability name resolves to different tools by configuration as an intentional alias departing from the retired-name mechanic, and fixes the lock ordering invariant. ADR-0005 records its superseded child-session exclusion, per-parent revert record, and no-lock trade-off. The repository guide and README now state which bundled roles receive anchored editing, that a child must read before it edits, who may revert whose edit, and that the parent's ability to revert a child's edit is bounded by that child's history retention.
