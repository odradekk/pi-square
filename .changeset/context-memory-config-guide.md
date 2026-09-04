---
"@odradekk/pi-square": minor
---

Add a Context Memory Config Guide to /context

`/context <request>` (any argument other than the read-only `memory <block> [page]` form) now asks the agent to help configure Context Memory, mirroring the `/shadow <request>` and `/subagent <request>` flow (odradekk/pi-square#254, parent spec #215).

- The command injects one bounded Config Guide custom message ahead of the unchanged user request; only the user message triggers the parent turn, and the guide writes nothing by itself. A message renderer is registered for the new `pi-square.context-memory/config-guide` type, and consultations are answered without changing any file.
- The guide carries computed current values for the running model, not formulas: the active configuration, the model's declared context window, Pi's compaction reserve, the resulting effective due point, the resulting Memory budget, the half-budget that decides append versus rebuild, and whether structured takeover is currently armed. Values are computed through the controller's own exported `effectiveDuePoint` arithmetic.
- The guide states that a Memory budget at or above the effective due point silently disables structured takeover, and gives the agent the arithmetic to check a proposed value before writing it.
- The guide states that `contextMemory` is agent-layer only and that writing it into a project-level `.pi/config/pi-square.json` rejects the entire project pi-square configuration atomically, enumerates the three settings with their exact bounds, and states that values are never normalized, clamped, or silently defaulted.
- Configuration work runs through the ordinary read/write/replace tools with no Context-Memory-specific write tool and no bespoke confirmation flow; existing `/context` behavior (no-argument snapshot and `memory <block> [page]` inspection) is unchanged.
