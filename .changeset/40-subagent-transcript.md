---
"@odradekk/pi-square": minor
---

Migrate subagent transcript entries to the operational interface.

The subagent delegate and resume transcript entries now use explicit lifecycle fields and qualifiers instead of relying solely on the status compatibility bridge:

- **Explicit lifecycle + qualifiers**: `subagentLifecycle()` maps all phase/isError combinations: partial → running with `partial` qualifier (plus `retrying` when retries > 0 during an active retry); cancelling → running with `cancelling` qualifier; aborted → aborted (overrides isError); error → failed; completed with retries → completed with `warning` qualifier; otherwise completed.

- **Removed `ACTIVITY`/`ISSUE` row label prefixes**: Body rows now show just the allowlisted tool summary text (e.g., `rg /needle/ in src`) without the old `ACTIVITY  ` or `ISSUE  ` label prefix. The section titles ("Activity", "Issues") remain.

- **Removed dead code**: Unreachable `queued` phase check removed (SubagentPhase never contains `queued`).

Agent identity, short ID, task target, bounded live text, allowlisted ACTIVITY (via the shared formatter), usage, duration, privacy boundaries, and unchanged schemas remain preserved.
