---
"@odradekk/pi-square": major
---

Remove the `sg` structural search tool and the `@ast-grep/cli` dependency. The tool is no longer registered in a parent session or offered by the child tool catalog. A subagent definition that still names `sg` fails its run with the supported-tool list, as any unknown name does. Users who relied on `sg` should use `rg` for text search or `codegraph` for semantic code exploration.
