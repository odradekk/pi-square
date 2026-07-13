---
"pi-square": major
---

Replace the session todo's binary checklist with a strict three-state workflow and a responsive Pi-native presentation.

- Add one-current-item `pending`, `in_progress`, and `completed` transitions with automatic advancement, explicit pause/start actions, atomic validation, and idempotent persistence.
- Replace the unbounded full-width widget with a read-only, theme-driven, half-width wide-terminal layout and a height-bounded viewport around the current task.
- Return self-contained JSON v1 snapshots, add complete native collapsible call/result renderers, and migrate existing `pi-square.todo.v1` session state to v2 snapshots.
- Bound lists and strings, reject duplicate or unsafe identifiers and terminal controls, and expand contract, lifecycle, migration, theme, width, height, and pressure coverage.

This is a breaking change because `create`, `replace`, and `status` are removed, task inputs use `status` instead of `completed`, new `start` and `pause` transitions define the current task, and model-facing Markdown results become structured JSON v1.
