---
"pi-square": major
---

Redesign subagent configuration, prompt authority, persistence, and interactive management around a breaking V2 contract.

- Require `promptVersion: 2` definitions with source-aware package, user, and project field overlays.
- Replace YAML `system` and `prompt` with layered `policy`, replayed `instructions`, and replayed `output`, plus optional parent-system inheritance.
- Treat injected parent history as reference-only context and preserve deterministic prompt snapshots with hash/provenance manifests.
- Upgrade persisted run details to v3 with parent-session ownership; legacy v2 artifacts are ignored without automatic deletion.
- Add the Pi-native `/subagent` manager for current-session background cancellation, history resume/fresh/delete actions, and validated definition CRUD.
- Add parameterized `/subagent <request>` configuration handoff to the parent agent.
- Show active background summaries in a bounded second statusline row without exposing tool result payloads.
- Introduce a real `cancelling` transition while retaining aborted child sessions for resume.
