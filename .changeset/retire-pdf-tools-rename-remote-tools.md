---
"@odradekk/pi-square": major
---

Retire the PDF tools and rename the remote extension tools.

- Retired `pdf_search` (local PDF text extraction and search) completely: registrations, implementation, `pdfjs-dist`/`@cantoo/pdf-lib` dependencies, child and Shadow catalog entries, display support, tests, and documentation are removed. The name stays invalid with no alias.
- Retired `parse` (Firecrawl PDF page parsing and upload) completely, including the Firecrawl client, workspace PDF input validation, upload confirmation flow, and Firecrawl-only credential redaction. The name stays invalid with no alias.
- Renamed `search` to `web_search`, `fetch` to `web_fetch`, `libs` to `library_search`, and `docs` to `library_docs`. Parameter schemas, results, providers (Jina and Context7), authentication, bounds, retries, and display behavior are unchanged; only the names and their cross-references changed.
- Updated the child tool catalog, bundled subagent definitions, the Shadow-safe catalog, the operational display catalog, and current documentation to the new names. The `search` display family is unchanged; it is a presentation category shared with Pi's built-in `grep`, not the retired extension tool.
- The six old names follow the ordinary unsupported-extension-tool contract at every boundary: subagent definitions that request them fail with the supported-tool list, Shadow excludes them as unavailable optional tools (warning) or fails them as required tools before prompting, and resumed persisted selections re-resolve the same way. No aliases, migration wrappers, tombstone maps, or configuration rewrites ship.
- `web_fetch` keeps its ordinary generic HTTP(S) behavior; remote PDF URLs are neither newly blocked nor specially handled.
