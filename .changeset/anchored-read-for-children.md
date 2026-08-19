---
"@odradekk/pi-square": minor
---

Give writable subagents an anchored read with owner-scoped served state. When anchored editing is enabled, a writable child's read is composed from Pi's public read factory plus the shared anchor transform, so the child returns the same three-character anchors as the parent and can address lines by anchor instead of quoting content. Served rows are recorded under the child's own owner (its subagent ID), so the parent's served record and each child's record never mix. Read-only roles and disabled anchored editing are unchanged.
