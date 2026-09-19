---
"@odradekk/pi-square": patch
---

Subagents: render the running child roster below the footer instead of above the editor (#410).

Pi's input dock is a fixed VStack that ends at the footer, so a `belowEditor` widget lands between the editor and the footer, not under it. The roster therefore stops registering an editor widget and renders through a new single trailer slot the footer owns (`src/footer/trailer.ts`): the footer appends the slot's lines after its own two rows, separated by one blank line, and appends nothing when the slot returns no lines.

What changes on screen: session status is now one continuous band at the bottom — footer rows, a blank line, then one row per retained current-parent child. The editor no longer moves when children come and go, and an empty roster reserves no line at all (the old `aboveEditor` placement always held one, a side effect of the host container rather than a deliberate choice). Row content, the row budget (30% of terminal height, capped at ten), Up/Down candidate selection from an exactly empty editor, and Enter opening the read-only child overlay are unchanged. When the terminal is too short, the host keeps the leading lines of each dock component, so the roster's rows are dropped before the footer's model, usage, context, and branch rows.

A producer registers either a render function or, when it caches its lines, an object carrying `render` and `invalidate`. Pi drops cached lines on a theme change by walking `invalidate()` into every mounted component; the footer forwards that reach into the slot, so the roster's cached rows are recomputed in the new theme rather than staying in the old one indefinitely.

The slot is a single provider rather than a keyed map, and its failures are bounded separately from the footer's: a throwing provider drops only its own lines, where the footer's existing catch would have replaced the whole band with `! footer unavailable`. Producers register before any footer is mounted — the extension registers subagents ahead of the footer and both act on session start — so the slot lives at module scope and its repaint request is a no-op until a footer mounts and again once one is disposed.

`SUBAGENT_ROSTER_KEY` and `createSubagentRosterWidget` are removed from `src/subagents/roster.ts`. Both were internal to the widget registration this change deletes; neither is part of the package's public exports. The roster's render cache now keys on a publication counter instead of the per-publication widget instance, so two publications landing in the same millisecond still invalidate it.
