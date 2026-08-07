---
"@odradekk/pi-square": minor
---

Migrate CodeGraph operations and confirmations to the Claude-like operational interface.

CodeGraph's status, explore, sync, init, and reindex operations now render with operation-specific titles and targets (for example "CodeGraph explore \<query\>" versus "CodeGraph status \<projectPath\>"), a structured Index section with human-readable file/node/edge counts, database size, last-indexed timestamp, and pending-change/health fields, and distinct operational states for genuine success, empty explore results, recoverable conditions requiring model follow-up (missing index, reindex required, worktree mismatch), declined confirmations, cancellation, and hard errors. Running operations surface their streaming progress message inline.

This closes two real display bugs discovered during migration: CodeGraph's own `details.status` field is a rich index-health object, but the shared base adapter's generic metadata logic treated any tool's `status` field as a short string and rendered it as a raw `status={...}` JSON badge or `status=[object Object]`; and CodeGraph's aborted operations are marked as tool errors (matching every other CodeGraph error), which caused the shared runtime's error-safety override to always render them with the failed marker instead of the distinct aborted marker.

Init and reindex confirmation content now uses the same bounded `Label: value` line grammar already used by SSH and PDF upload confirmations, replacing free-form paragraphs. The confirmation shell, the shared FIFO coordinator, and all execution, validation, workspace-boundary, and telemetry behavior are unchanged; declining still performs no persistent write.
