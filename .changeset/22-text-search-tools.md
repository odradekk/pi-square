---
"@odradekk/pi-square": minor
---

Migrate text search tools (Grep, RG) to the Claude-like operational interface.

Grep now routes through the explicit operational lifecycle (queued, pending, running, completed, failed) instead of the compatibility bridge, and its results parse standard `path:line:text` grep output into the shared `matches` section grammar with path, line, and excerpt — replacing the previous raw text dump. Grep's `glob`, `ignoreCase`, `literal`, and `context` parameters now surface as call badges and in the expanded Query summary; the call and result targets prioritize the search pattern over the path.

The shared `search-adapters.ts` module used by RG, FD, SG, PDF search, and CodeGraph gains several fixes discovered while migrating RG:

- Arg-derived metadata (pattern, case, word, glob, ...) is deduplicated instead of appearing twice in the header.
- A tool error now renders exactly once through the dedicated error field instead of being duplicated across the preview, a diagnostics section, and the error field.
- Match/path-based tools show an explicit "No matches" or "No results" message when the result count is confirmed zero, instead of falling through to an ambiguous or empty raw-text preview. When the domain is absent but the result count is not confirmed empty (malformed or unexpected details), the raw text output remains visible so no information is silently dropped.

Empty results, invalid patterns, and errors now render as visibly distinct operational states for both tools.
