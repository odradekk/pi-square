---
"@odradekk/pi-square": minor
---

Migrate the primary Ask workflow to the operational interface.

Ask already rendered through `createWorkflowAdapter`. This closes the lifecycle, call-phase identity, progress-state, and collapsed-view gaps:

- **Explicit lifecycle**: `askLifecycle()` maps `isPartial` to running (progress updates), `phase="error"` to failed, `phase="cancelled"` to aborted (overriding `isError:true` for tool-aborted, matching the SSH #32/#33 pattern), and otherwise to completed. Call phase derives queued/pending/running from execution context.

- **Call-phase question count**: `actionFields` now falls back to `args.questions.length` when `details.totalQuestions` is unavailable (during call phase), so the Request section shows the question count immediately rather than being empty.

- **Compact Request section**: Operation identity (phase, questions, answered, skipped, current, reason) is now visible in collapsed mode as a compact section, replacing the raw JSON fallback.

- **Progress-aware rendering**: Progress updates (`isPartial: true`) show the running braille animation while the wizard is open, resolving to the terminal lifecycle marker when the final result arrives.

- **Needs-input qualifier**: The call carries `qualifiers: ["needs-input"]` while the wizard is active, signaling interactive input is required (matching the SSH `secret_input` pattern).

Model-facing schemas, execution behavior, keyboard navigation, focus movement, validation, submission, budgets, cancellation semantics, privacy, and security boundaries are unchanged.
