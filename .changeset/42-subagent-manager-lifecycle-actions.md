---
"@odradekk/pi-square": minor
---

Migrate subagent manager lifecycle actions to the operational marker vocabulary.

The subagent manager list rows and flash feedback adopt the Claude-like operational marker grammar:

- **Running-tab list rows**: Plain-text status (`running`, `queued`, `cancelling`) replaced with operational markers (`→ running`, `– queued`, `× cancelling`) with semantic tones matching the design spec state model.
- **Session-tab list rows**: Plain-text phases (`done`, `error`, `aborted`, `active`, `running (inactive)`, `cancelling (inactive)`) replaced with operational markers (`✓ done`, `✗ error`, `× aborted`, `→ active`, `→ running (inactive)`, `× cancelling (inactive)`).
- **Flash feedback**: Success and error flashes now carry `✓` and `✗` lifecycle markers for immediate visual recognition.
- **Delete-history review**: Label grammar fixed from two-space (`Agent  `, `Task  `) to colon-separated (`Agent: `, `Task:`) for consistency with the rest of the manager surfaces.

Manager lifecycle action views (cancel, resume, fresh, delete history) remain strongly visible: destructive reviews retain warning-colored body lines, clear eyebrow context, and explicit confirm labels. State machine contracts (lease gating, confirmation flow, resumability, race detection, cancellation transitions) are unchanged.

New focused tests exercise the production `SubagentManager` component for cancel, delete-history, fresh-run, decline, and failure-recovery flows, plus lifecycle marker verification in both running and session tabs.
