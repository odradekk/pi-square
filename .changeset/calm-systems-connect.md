---
"@odradekk/pi-square": major
---

Remove per-command SSH confirmations so concurrent remote commands cannot leave displaced confirmation promises pending. Connected sessions now execute commands directly while retaining configured target allowlists, pinned host verification, alternate-target approval, and the one-active-command-per-session invariant.

The `confirmCommands` SSH profile field is no longer accepted and must be removed from agent configuration. Remaining pi-square confirmations now share a session-scoped FIFO coordinator so SSH endpoint, CodeGraph lifecycle, and Firecrawl upload prompts cannot replace one another in Pi's single confirmation selector.
