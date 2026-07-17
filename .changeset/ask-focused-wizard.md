---
"@odradekk/pi-square": major
---

Replace the `ask` tool's docked per-question widget with a focused, persistent Pi-native wizard and a versioned answer protocol.

- Preserve selections and comments across back navigation, review multi-question calls before submission, enforce required questions, expose explicit optional-question skipping, and confirm cancellation when drafts would be discarded.
- Present questions in a theme-driven, left-aligned form with a compact step rail, full-row focus treatment, adaptive option summaries, stable paged details, responsive command bars, a compact review checklist, and a half-width wide-terminal layout.
- Add multiline comments, placeholders, option descriptions, bounded input validation, count-only progress updates, and complete native collapsible call/result rendering.
- Return submitted, cancelled, and failed outcomes as self-contained JSON v1 while discarding every unsubmitted draft on cancellation.

This is a breaking change because `allowComment` now defaults to `false`, `required` now defaults to `true`, and final model-facing content changes from Markdown to structured JSON.
