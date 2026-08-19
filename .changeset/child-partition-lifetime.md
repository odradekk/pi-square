---
"@odradekk/pi-square": minor
---

Make child anchor-store partitions follow subagent artifacts. A child's served and revert records live under its own owner in the workspace store and are retained exactly while that child's history is retained, so a resumed child keeps the anchors it was working from and can edit a range it was shown without reading again. Deleting a child's history drops its partition with it, and a reconciliation at parent-session start evicts orphan partitions and enforces a documented bound (at most 32 child partitions per workspace, evicted least-recently-active first) while never discarding a partition that still holds a revert record a child is eligible to restore. Records for files that no longer exist are pruned for every owner, not only the parent.
