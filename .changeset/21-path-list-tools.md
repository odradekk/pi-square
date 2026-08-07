---
"@odradekk/pi-square": minor
---

Migrate bounded path-list tools (List, Find, FD) to the Claude-like operational interface.

List and Find now route through the explicit operational lifecycle (queued, pending, running, completed, failed) instead of the compatibility bridge. Results use the shared `paths` section grammar with `f`/`d` path-kind markers, replacing the previous `recordsSection` with its `/`-suffix tone heuristic.

The `find` tool moves from the `search` family to `filesystem`, matching the display catalog and the design spec's "Filesystem read/list/find" icon grouping. Find call and result targets now prioritize the pattern over the path.

FD path-kind detection improves: when `types: ["directory"]` or `types: ["symlink"]` is the sole type filter, results carry the `d` or `l` marker instead of defaulting to `f`. Byte-path entries continue to use the `s` marker.

Empty results show an explicit "No entries" or "No results" message. Error results are visibly distinct: error text renders through the `error` field with error styling rather than being parsed as path entries. Large path sets collapse at the 64-item budget with an accurate omission count in both collapsed and expanded views.
