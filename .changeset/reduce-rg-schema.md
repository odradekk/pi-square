---
"@odradekk/pi-square": major
---

Reduce the `rg` parameter schema to seven high-impact fields: `pattern`, `path`, `globs`, `literal`, `context`, `offset`, `limit`. Removed `case` (use inline regex flags like `(?i)`), `word` (use `\b`), `includeGlobs`/`excludeGlobs` (merged into `globs` with native `!` negation), `types` (use `globs`), `beforeContext`/`afterContext` (merged into symmetric `context`), `hidden`/`noIgnore` (use an explicit `path`), and `maxDepth` (use a narrower `path`). Smart case `-S` is now a fixed wrapper flag. `limit` maximum lowered from 100 to 25.
