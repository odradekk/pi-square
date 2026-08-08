---
"@odradekk/pi-square": minor
---

Complete the Claude-like operational interface: family icons, qualifier badges, and one shared subagent result grammar.

This closes the gaps found when the implemented interface was audited against the accepted design specification.

**Header grammar**

- Every catalog tool now renders its fixed family icon (`▪` filesystem read, `▣` filesystem write, `⌕` search, `⌬` remote, `◆` workflow, `◇` agent) or its explicit execution prompt (`$ ❯`, `PS ❯`, `λ ❯`). Execution tools carry the prompt as their title, so the icon is never duplicated.
- Active qualifiers render as bounded header badges (`[needs input]`, `[cancelling]`, `[retrying]`, `[projected]`, `[truncated]`, `[partial]`). Required action and retry state are no longer invisible in a collapsed entry.
- Duration is the first header item dropped at compact widths, and a compact layout keeps only the highest-priority badge.

**Corrections**

- `aborted` uses the muted lifecycle token instead of the warning token, matching the specification's quiet terminal state.
- Truncation uses the `…` glyph instead of `...` across headers, rows, sections, diffs, and the `/display` manager.
- Unified diffs emphasize the changed segment of a replaced line, matching the reference's word-level diff behavior. Diff colors remain Pi semantic tokens; syntax highlighting stays out of scope.
- Background subagent completion messages now render the same canonical run description as the transcript entry inside Pi's native success/error shell, replacing a parallel component tree. The delegated task moved into the expanded section model, and the full run ID is no longer rendered on any surface.

**Verification**

- Visual acceptance now asserts icon resolution, icon single-occurrence, one-cell markers, per-qualifier badges, compact badge and duration priority, and bounded rendering through the production decoration path for every non-built-in catalog tool.
