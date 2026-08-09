---
"@odradekk/pi-square": major
---

Adopt the single-bullet visual vocabulary: one static `●` per tool entry, color carries state, no family icons.

This is a breaking visual change to the operational display grammar. The shipped family icons and animated braille running marker are replaced by one static `●` that marks every tool entry in every state.

**Marker and state encoding**

- One static `●` marks every tool entry in every state on a color-capable terminal. The state is carried by existing semantic tokens: queued, pending, and aborted muted; running accent; completed success; completed-with-warning warning; failed error.
- When color is unavailable (`NO_COLOR`, non-TTY, test, CI, monochrome), the renderer falls back to a distinguishable glyph set: `–` queued, `○` pending, `●` running, `✓` completed, `!` warning, `×` failed, `·` aborted. The fallback is automatic and not configurable.
- `pending` now uses the muted lifecycle token instead of accent, matching the design specification.

**Family icons removed**

- No family icon is rendered in any state. The title carries the tool identity.
- `FAMILY_ICONS`, `UNKNOWN_TOOL_ICON`, `MAX_ICON_CELLS`, `TOOL_ICONS`, and `catalogIconFor` are removed.
- The catalog `family` field stays and keeps selecting the owning adapter; it no longer selects a glyph.

**Motion**

- The marker never animates in any motion mode. The scheduler drives only the elapsed duration.
- `full` interval changed from 34 ms to 120 ms; `reduced` changed from 120 ms to 1 s; `off` is unchanged.
- `MOTION_FULL_INTERVAL_MS` is now `120`; `MOTION_REDUCED_INTERVAL_MS` is now `1_000`.
- `OperationalDisplayComponent.advanceFrame()` is removed.
- `DisplayRuntime.subscribeMotion()` no longer takes a component parameter.
- The subagent status controller no longer subscribes to motion; its markers are static.

**Other surfaces**

- `/display` manager header, `/subagent` manager header, and Config Guide label use `●` instead of `◆`.
- Footer status row uses `●` for subagents instead of `◇`.

**API changes**

- `OperationalDisplayOptions` gains optional `colorAvailable?: boolean` (defaults to `false`).
- `MotionEnvironment` gains optional `noColor?: boolean`.
- New exports: `BULLET_MARKER`, `FALLBACK_MARKERS`, `FALLBACK_WARNING_MARKER`, `colorAvailable`.
- Removed exports: `LIFECYCLE_FRAMES`, `QUEUED_FRAME`, `PENDING_MARKER`, `RUNNING_FRAMES`, `COMPLETED_FRAME`, `COMPLETED_WARNING_FRAME`, `FAILED_FRAME`, `ABORTED_MARKER`, `FAMILY_ICONS`, `UNKNOWN_TOOL_ICON`, `MAX_ICON_CELLS`, `TOOL_ICONS`, `catalogIconFor`.
