---
"@odradekk/pi-square": minor
---

Migrate background subagent completion messages to the operational interface.

The background subagent notification rendering adopts the Claude-like operational grammar while preserving Pi's native success/error shell:

- **Header identity**: `subagent` text label replaced with `◇` agent-family icon from the design-spec icon vocabulary. The native shell context already identifies the surface.
- **Section headings**: All-caps (`ACTIVITY`, `ISSUES`, `TASK`, `RESULT`) changed to title-case (`Activity`, `Issues`, `Task`, `Result`) for consistency with the transcript adapter (#40).
- **Lifecycle markers**: Corrected to match the design-spec state model table:
  - Queued: `—` (em-dash) → `–` (en-dash, matching `QUEUED_FRAME`)
  - Aborted: `warning` tone → `muted` tone (spec: "muted error")
  - Running/active: `warning` tone → `accent` tone (spec: Running | accent)
- **Aborted shell fix**: Aborted notifications now correctly use the error shell (`toolErrorBg`) instead of the success shell. Aborted is a terminal failure state.

Delivery path (`notifyCompletion` → `pi.sendMessage` with `triggerTurn: true, deliverAs: "steer"`), registration (`registerMessageRenderer`), privacy sanitization, bounded output, and native shell exception are unchanged.

New tests verify the ◇ icon, title-case section headings, correct lifecycle markers for done/error/aborted, and the aborted error-shell fix.
