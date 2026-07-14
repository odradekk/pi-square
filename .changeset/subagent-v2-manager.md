---
"pi-square": major
---

Redesign subagent configuration, prompt authority, persistence, and interactive management around a breaking V2 contract.

- Require `promptVersion: 2` definitions with source-aware package, user, and project field overlays.
- Replace YAML `system` and `prompt` with layered `policy`, replayed `instructions`, and replayed `output`, plus optional parent-system inheritance.
- Treat injected parent history as reference-only context and preserve deterministic prompt snapshots with hash/provenance manifests.
- Upgrade persisted run details to v3 with parent-session ownership; legacy v2 artifacts are ignored without automatic deletion.
- Add a non-overlay, responsive Pi-native `/subagent` manager with integrated current-session cancellation, history resume/fresh/delete actions, task editors, definition CRUD, diff review, and confirmations.
- Add parameterized `/subagent <request>` handoff as an ordered, collapsible Config Guide custom message followed by the unchanged native user request.
- Render asynchronous background completion follow-ups inside Pi's native success/error tool shell.
- Show active background summaries in a bounded second statusline row without exposing tool result payloads.
- Introduce a real `cancelling` transition while retaining aborted child sessions for resume.
