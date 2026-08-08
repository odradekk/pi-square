---
"@odradekk/pi-square": minor
---

Migrate advanced Ask states to the operational interface.

Closes the comment-only ambiguity, progress-frame raw-JSON leak, and edge-state coverage gaps from issue #36:

- **Comment-only answer indicator**: When an answer has no selections but is not skipped (`selected: []`, `skipped: false`), the answer record now shows `comment-only=yes` in muted tone. This distinguishes a genuine comment-only submission from a skipped or failed answer.

- **Progress-frame raw-JSON fix**: Added "Request" to the `hasDomain` check. Expanded progress frames (phase=asking/reviewing with no answers) previously fell through to a raw JSON `Result` section because only "Request" content was present. Now the compact "Request" section is recognized as domain content, preventing JSON leakage in both expanded and collapsed progress views.

Model-facing schemas, execution behavior, keyboard navigation, validation, comment bounds, cancellation semantics, privacy budgets, and security boundaries are unchanged.
