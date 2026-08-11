---
"@odradekk/pi-square": patch
---

Cache the rendered lines of the operational display component so a static history entry costs almost nothing in each frame.

Pi re-renders the full component tree on every frame, but `renderCall` and `renderResult` run only on the tool-execution update path. `OperationalDisplayComponent` now returns its cached lines while the description, policy, theme, render options, and width stay the same, and `update()` and `invalidate()` drop the cache. A running tool still refreshes its duration at the motion interval, a result replaces the pending call, and an expand, collapse, theme change, or width change produces newly calculated lines.
