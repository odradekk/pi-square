---
"@odradekk/pi-square": patch
---

Memoize the footer usage totals and session name so they recompute only after the session entries change.

Pi renders the footer in each frame. The snapshot collector previously scanned the full session entry list twice per frame — once to sum cumulative usage and once to resolve the session name. `FooterSnapshotProvider` now caches those derived values by session entry count (the session is append-only, so a stable count means no new entries) and recomputes only after that count changes. The memo holds in-memory derived values for the current entry set; it is never persisted and adds no independent polling.
