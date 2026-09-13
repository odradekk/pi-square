---
"@odradekk/pi-square": minor
---

Minor: prepare the symmetric Context Memory continuity and source-recovery qualification for #340.

- Replace the historical asymmetric 16-cell continuity matrix with one shared 12-case corpus run by both Sonnet 5 and GLM 5.3 as two concurrently started, internally sequential queues. The v3 report records all 24 isolated cells, 12 matched pairs, per-model totals, honest partial/error states, provider-reported usage presence, retrieval counts and bytes, and bounded private evidence; the v2 reader labels old evidence historical and never treats it as current qualification.
- Credit original source recovery only when an exact successful search/read result is present at the native request exit before the later handoff write. Deterministic native tests reject failed, stale, wrong-view, filtered, clipped, same-batch, and post-handoff evidence while accepting sufficient search snippets and search-to-targeted-read completion.
- Add a separate both-model search-enabled/read-only recovery comparison. Its internal runner seam removes search from the real model-visible tools while retaining read, leaves product configuration and default availability unchanged, and does not alter the main 24-cell completeness gate.
