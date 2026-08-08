---
"@odradekk/pi-square": minor
---

Replace the stateless footer with the accepted Claude-style two-row layout.

The footer row layout is restructured to match the design specification:

- **Row 1**: model name, provider (when multiple), and thinking level on the left; cumulative usage (input ↑, output ↓), cache read/write with hit rate, and subscription-aware cost on the right.
- **Row 2**: `Loc:` label with project path, git branch, and session name on the left; context bar with percentage and window on the right.
- **Row 3** (conditional): per-status markers (● for subagents, ! for display diagnostics, · for others) instead of a single blanket warning prefix. Display diagnostics now sort second after subagents.

The π² identity mark is removed from the footer (the compact header from #37 handles identity). Provider/model order matches the design doc (`model / provider`). Narrow widths (<64) retain the existing context-and-thinking-only behavior.

No new data polling, usage persistence, child-result inspection, or independent counters are introduced.
