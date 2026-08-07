---
"@odradekk/pi-square": minor
---

Migrate SSH session transcripts to the operational interface.

SSH already shared display integration through `createRemoteAdapter`. This closes the operation-identity, session-state, cursor, and output-quality gaps:

- **Operation-specific targets**: Connect shows `profile/target`; command/read/input/interrupt/close show `session ID`; list has no target. Previously all operations showed the raw operation name.

- **Session state visible**: `endpoint`, `sessionState`, `commandState`, `disconnectReason`, and `exitCode` (with success/error tone) now appear in the Summary section. Previously only `status`/`code`/`message` were visible.

- **Cursor metadata explicit**: A composite `cursor` field surfaces `expired`, `N dropped`, and/or `more` when the output page reports cursor expiry, ring truncation, or remaining data. Previously invisible.

- **Terminal output extraction**: `sshOutputText()` extracts `body.output` from the SSH tool's JSON-serialized result body, so the display shows clean projected terminal output instead of raw JSON in both expanded Output sections and collapsed previews.

- **List as structured records**: Profile and session summaries render as records with full identity fields (name, defaultTarget, targets+endpoints, maxSessions, state, commandState, disconnectReason).

- **Aborted marker fix**: SSH command/read operations set `isError: true` even for aborted results; the `remoteLifecycle` override renders × instead of ✗ for `status: "aborted"`.

Model-facing schemas, execution behavior, result details, cancellation semantics, privacy budgets, and security boundaries are unchanged.
