---
"@odradekk/pi-square": minor
---

Migrate structural search (SG) to the Claude-like operational interface.

SG's rendering already inherited most of the shared operational lifecycle, error single-sourcing, and confirmed-empty messaging fixed in the text search migration, since it shares the same `createSearchAdapter` infrastructure with RG/FD/PDF search. This change closes the remaining gap: `selector` and `strictness` are documented in SG's own guidelines as applying only to pattern-mode searches, but were unconditionally surfaced whenever present in the call arguments — including when a model mistakenly supplies them alongside `kind` instead of `pattern`. Kind-mode calls and results now omit these fields from both the call badges and the expanded Query summary, giving pattern and kind mode visibly distinct, uncluttered summaries.

`mergeMetadata` gained an optional `suppress` parameter to unconditionally drop labels the shared base adapter's generic argument metadata would otherwise leak through regardless of mode; the default is a safe, unshared empty set with no effect on RG, FD, PDF search, or CodeGraph.
