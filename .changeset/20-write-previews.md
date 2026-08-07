---
"@odradekk/pi-square": minor
---

Deliver projected Write previews through the new operational interface.

The Write tool now routes through the explicit operational lifecycle path (queued, pending, running, completed, failed). Projected create and overwrite previews carry the `projected` qualifier alongside the persistent `PROJECTED PREVIEW` label, clearly distinguishing pre-execution projections from authoritative results. Settled Write results never claim the projection is the final filesystem state.

Workspace canonicalization, symlink escape rejection, regular-file checks, UTF-8 text checks, the one-megabyte input ceiling, and before/after identity verification remain enforced before previewing. Outside-workspace, binary, oversized, and concurrently changed targets fall back to safe metadata without leaking content.
