---
"@odradekk/pi-square": minor
---

Integrate subagent status into the operational footer marker vocabulary.

The subagent footer status surface adopts the Claude-like operational interface:

- **Footer status markers**: subagent status marker changed from the non-vocabulary `●` to `◇` (agent-family type identifier from the design-spec icon vocabulary); generic extension marker retains neutral `·` (not a lifecycle state, must not borrow a marker+tone pair); display diagnostic `!` unchanged.
- **Running-job marker tone**: corrected from `warning` to `accent` to match the design-spec state model (Running | braille spinner | accent).
- **Running-frame import**: `PENDING_FRAMES` → `RUNNING_FRAMES` for semantic correctness — background jobs are running, not pending.
- **Status priority**: cancelling jobs already outrank running jobs in the status text (preserved); generic extension status ordering remains stable (alphabetical after subagent and display).

The subagent status text itself already carries per-job lifecycle markers (`⠋` running, `×` cancelling, `–` queued), short IDs, bounded activity summaries from the shared allowlisted formatter, and count badges. The footer renders these on the conditional third row with stable priority ordering. Privacy sanitization, bounded output, and motion subscription/unsubscription lifecycle are unchanged.

New tests verify the running-marker accent tone, cancelling-outranks-running priority, footer marker presence through the production rendering path, and status ordering across all footer breakpoints.
