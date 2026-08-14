---
"@odradekk/pi-square": minor
---

Add `filesOnly` parameter to the `rg` tool. When `filesOnly: true`, the result returns matching file paths with per-file match counts instead of match text, keeping the same paging, budget, and truncation rules. This is the cheapest way to discover which files contain a match during a first exploration.
