---
"@odradekk/pi-square": minor
---

Add the default-off Context Memory shell for the parent Pi session

Establishes the experimental Context Memory capability as an inactive shell (odradekk/pi-square#216, parent spec #215). With no configuration, Pi behavior is unchanged: no context transform, no compaction takeover, no active model tool, no persistent file, no footer, and no widget.

- New agent-only `contextMemory` configuration (`enabled`, `compressionThreshold` as exactly one of a percent (10–80) or positive token count, `memoryBudgetPercent` 1–25) with strict bounds and unknown-field rejection; a project layer declaring `contextMemory` is rejected atomically and can never enable or alter the feature.
- Exact Pi 0.84.2 host gating: an unsupported host or missing public session/compaction/context/tool/active-tool interfaces leaves Pi native compaction and the active tool set unchanged.
- Registers the two parent-only model tools `submit_memory` and `read_memory_source` once, decorated through the shared operational display system, and keeps both inactive in the baseline state; outside their future activation windows they fail safely with the `SUBMIT_NOT_DUE` and `MEMORY_NOT_AVAILABLE` codes and never appear in child catalogs.
- The existing `/context` command stays the sole inspection surface and now renders a bounded one-line `memory[]` state between the system-prompt and message sections for the disabled, unsupported-host, and enabled-with-no-Memory states; the total usage bar is unchanged.
