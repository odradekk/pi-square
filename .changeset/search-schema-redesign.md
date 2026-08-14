---
"@odradekk/pi-square": major
---

Redesign the `rg` and `fd` search tool schemas to eight fields each and add a `filesOnly` mode to `rg`.

**rg** is now 8 fields: `pattern` (required), `path`, `globs`, `literal`, `context`, `filesOnly`, `offset`, `limit`. The new `filesOnly` boolean returns file paths with match counts instead of individual match lines, paging the file list with `offset`/`limit`. The `limit` maximum remains 25.

**fd** is now 8 fields: `pattern` (optional, regex only), `path`, `excludeGlobs`, `types`, `extensions`, `maxDepth`, `offset`, `limit`. Removed `case` (smart case only), `matchMode` (regex only; use `rg` with `literal` or `globs` for glob/fixed matching), `hidden`/`noIgnore` (use a narrower `path`), and `minDepth`. The `types` items now use `StringEnum` for provider compatibility instead of `Type.Union`.

Removed dead constants and type aliases: `DEFAULT_PATH`, `DEFAULT_FD_PATTERN`, `DEFAULT_CASE`, `DEFAULT_FD_MATCH_MODE`, `CaseMode`, `FdMatchMode`.
