---
"@odradekk/pi-square": patch
---

Add `npm run bench:frames` to measure the frame cost of pi-square TUI surfaces.

The command reports the render cost of one operational display entry and the frame cost of a synthetic history at 10, 50, and 100 entries (cold and cached), plus the footer cost, in both bundled themes at width 120. It is a development report, not a required CI gate.
