---
"@odradekk/pi-square": minor
---

Shadow Minds: expose per-request usage and prompt-cache diagnostics. Every run records a structured cache-cohort hash set (model, thinking, tool schema, SYSTEM, working directory, trajectory checkpoint, truncation mode, plus parent-core and project-rules hashes computed where the raw text is visible) — hashes only, never prompt text or credentials. Per-request metrics retain input/output/cache read/write/cost, the turn ordinal, attributed tool calls, and TTFT, with unreported or unsupported provider cache values distinguishable from a provider-reported zero. The `/shadow` manager gains a bounded Diagnostics view with aggregate totals, cache coverage, TTFT stats, and cohort grouping, describing cache reuse as measured and best-effort rather than guaranteed.
