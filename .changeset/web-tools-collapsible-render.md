---
"@odradekk/pi-square": minor
---

Add Pi-native collapsible TUI presentation for the `search` and `fetch` web tools.

- Collapsed rows show a one-line semantic summary (queries/URLs, returned/dedup/failed or fetched/failed/retried counts, and any error) with an expand hint.
- Expanded rows reveal the full content: ranked results with clickable links for `search`, and per-page sections with clickable URLs, metadata, and the untruncated Markdown body for `fetch`.
- The model-facing `content` text is unchanged. `fetch` records per-page UTF-16 content offsets in `FetchDetails.pages` so the renderer slices the body from `content` without duplicating large text in `details`; `SearchDetails.results` carries a small structured render copy with provenance.
- Tools keep the default Pi shell, use theme tokens for color, and fall back to the full Markdown content for legacy `search` or `fetch` details.
- Display-only Markdown strips terminal control sequences and neutralizes page-authored link targets while preserving model-facing content; validated result and page-header links remain clickable.
