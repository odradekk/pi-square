---
"@odradekk/pi-square": minor
---

Add live streaming to the subagent transcript viewer: while a child runs, the overlay shows its in-flight assistant message (ordered text/thinking parts) and live tool rows with immediate terminal states as a bounded tail below the persisted history. Event delivery is decoupled from the child run, ordinary repaints coalesce through one session-owned timer, completed messages reconcile against appended history only through occurrences that appeared after them, overflow shows an explicit recoverable omission state, and observer failures never reach the child.
