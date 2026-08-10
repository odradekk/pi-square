---
"@odradekk/pi-square": major
---

Rework the search tool output (#56)

- **Grouped match layout:** `grep`, `rg`, and `sg` group matches by file with one row per match. A file-header row carries the dim workspace-relative path; each match row has a right-aligned dim line number, two spaces, and the matched text emphasized. Long lines truncate with `…` and never wrap.
- **No noise fields:** no row carries a column number, a `match`/`context` label, a language label, or a score. `sg` shows only the first line of a matched node plus a muted `+N lines` suffix; the full body moves to the expanded view.
- **Paging as sentences:** `12 of 240 matches in 5 files · continue at offset 12` replaces `returned=12 · total=240 · next=12 · hasMore=true`. The fields `returned`, `total`, `next`, `hasMore`, and null values never appear.
- **`rg` context lines** render in the muted tone with no label. The matched text is emphasized through the precomputed `display.highlights` ranges.
- **`fd` collapsed body** is one summary row (`6 of 24 files in src/display · continue at offset 6`); paths move to the expanded view.
- **`pdf_search`** renders one row per match starting `page N`, never repeats the document path, and shows `fuzzy` only for fuzzy matches.
- **`codegraph explore`** parses the upstream output into a file-and-symbol list (collapsed) and a blast-radius records section (expanded). Emoji, model instructions, and verbatim source blocks are sanitized out.
- **`codegraph status`** states counts, size, and a relative index age (`278 files · indexed 22h ago`), and names the required action when the index is stale (`run sync`) or corrupt (`run reindex`).
- **`truncated` badge** appears on the header when the collapsed body drops rows; the summary row states the dropped count (`· 52 not shown`).
- Model-facing tool output is unchanged for all six tools.
