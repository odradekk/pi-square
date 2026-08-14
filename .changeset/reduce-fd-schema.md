---
"@odradekk/pi-square": major
---

Reduce the `fd` parameter schema to eight fields: `pattern`, `path`, `excludeGlobs`, `types`, `extensions`, `maxDepth`, `offset`, `limit`. Removed `case` (use inline regex flags), `matchMode` (regex is the only pattern language), `hidden`/`noIgnore` (use an explicit `path`), and `minDepth` (use a narrower `path`). The `types` field switches from a `Type.Union` of literals to a `StringEnum`, matching the house style.
