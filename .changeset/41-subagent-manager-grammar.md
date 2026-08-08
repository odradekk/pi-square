---
"@odradekk/pi-square": minor
---

Migrate subagent manager browsing and live state to the owned-content grammar.

The subagent manager and notification rendering adopt the label-led detail row grammar:

- **Manager header**: `SUBAGENTS` (bold, all-caps) → `Subagents` (label-led, no bold).
- **Detail rows**: All `LABEL  value` (two-space, all-caps) → `Label: value` (colon-separated, title-case) across running, session, and definitions tabs. Affected labels: ID, Task, Activity, Usage, Model, Prompt, Hash, Description, Effort, Parent system, Tools, Extensions, Skills, Layers, Policy, Instructions, Output.
- **Review-view rows**: `Task  `, `Agent  `, `Source ID  `, `Prompt  `, `Path  ` → colon-separated labels.
- **Notification rendering**: `ID  `, `Task  `, `Cause  `, `Next   `, `Next  ` → `ID: `, `Task: `, `Cause: `, `Next: ` (consistent label grammar across collapsed and expanded views).
- **Section header**: `DETAIL` → `Detail` (label-led).

Navigation tab labels (`RUNNING`, `SESSION`, `DEFINITIONS`) are unchanged as they are navigation identifiers. Focus preservation, live refresh, scroll position, empty states, privacy boundaries, and responsive layout are unchanged.
