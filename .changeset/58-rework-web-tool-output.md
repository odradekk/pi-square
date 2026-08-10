---
"@odradekk/pi-square": major
---

Rework the web remote tool output (#58)

The five web tools (search, fetch, libs, docs, parse) now use the same
two-row record layout in collapsed and expanded bodies. Records show the
rank, title, and a scheme-less middle-elided URL instead of key=value
metadata pairs. The collapsed body keeps the previewLines budget, and a
summary row states the result count.

Key changes:
- Shared two-row records: rank+title, then secondary line (URL, metrics)
- No key=value metadata, no REQUEST or SUMMARY sections
- search: provenance token expanded-only, summary row with query count
- fetch: reader headers (URL:/Usage:) stripped, Markdown links flattened,
  tokens stated once, no retried
- libs: five metrics (stars, snippets, tokens, trust, updated), short
  counts, relative update time, no benchmark
- docs: sentence-style snippet counts and token budget, no absolute URL
  or page title in collapsed body
- parse: model-facing # Parsed PDF header stripped, uploaded size in
  summary, diagnostics once, declined upload = aborted with one row
- No credentials rendered in any state
