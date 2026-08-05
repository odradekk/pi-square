# Search Expanded Results

Scope: `grep`, `rg`, `sg`, `codegraph`, `pdf_search`
Parent tools: all five. Child-capable: all five with existing role restrictions.
Primary family contract: query and location are the first-level identity; content excerpts are evidence, not raw dumps.

## Shared search grammar

Expanded search results use this order:

1. Error or recoverability state.
2. Query and effective filters.
3. Result/paging summary.
4. Grouped matches or semantic evidence.
5. Truncation, stderr, and binary/identity notices.

Structured details already exist for `rg`, `fd`-style paging, `sg`, `codegraph`, and `pdf_search`; adapters must consume those details before falling back to model-facing text.

## grep

Expanded sections:

- `ERROR` for invalid regex, process, or read failures.
- `QUERY`: pattern, path, case/literal/word/context and paging metadata.
- `RESULTS`: path-grouped records with line/column, match text, and bounded context.
- `PAGING`: returned, offset, next offset, total, and has-more.
- `TRUNCATION`: line excerpt and context omission details.

Rules:

- Pi's built-in grep result remains authoritative; pi-square does not re-run or reinterpret the search.
- Match highlighting uses safe display ranges only; byte-encoded values remain escaped and unlinked.
- Context and matches are visually distinct but use the same semantic theme family.

## rg

Expanded sections:

- `ERROR` for invalid regex, native failure, or cap overflow.
- `QUERY`: pattern, path, case, literal, word, glob/type/context, offset, and limit.
- `SUMMARY`: file count, returned, total, next offset, and omission counts.
- `MATCHES`: file-grouped sections with aligned line/column gutter, bounded excerpts, and exact-match emphasis.
- `CONTEXT`: merged context ranges remain attached to their file group.
- `DIAGNOSTICS`: bounded stderr, binary/byte-path notice, and content-budget details.

Rules:

- Use `details.files` and safe display ranges when available.
- Preserve UTF-8, UTF-16 display mapping, byte-base64 identity, and path normalization semantics from the execution layer.
- A continuation marker must identify the next offset.
- No raw malformed JSON event is rendered as a match.

## sg

Expanded sections:

- `ERROR` for process, schema, or malformed NDJSON failure.
- `QUERY`: pattern or node kind, language, selector, strictness, path, glob/context, offset, and limit.
- `SUMMARY`: returned, total, next offset, and content-budget status.
- `MATCHES`: file/location records with the matched structural excerpt.
- `CAPTURES`: bounded metavariable records grouped under each match.
- `DIAGNOSTICS`: bounded stderr and unsupported-language notices.

Rules:

- Keep the syntactic/tree-sitter distinction explicit; do not imply type-aware references or call hierarchies.
- Metavariable values are display-sanitized and bounded.
- `pattern` and `kind` remain mutually exclusive in display as they are in execution.

## codegraph

Expanded sections:

- `ERROR` for not-indexed, unhealthy-index, process, or workspace-boundary failures.
- `OPERATION`: operation, project path, query, and max files.
- `SUMMARY`: status, freshness, files, symbols, relationships, and sync/reindex state when exposed.
- `RESULTS`: bounded source and relationship sections from CodeGraph content.
- `LIFECYCLE`: confirmation status for init/reindex and automatic incremental sync note.
- `DIAGNOSTICS`: bounded stderr and telemetry-disabled scope.

Rules:

- Parent lifecycle operations retain confirmation state; child definitions remain `explore`/`status` only.
- Missing or stale index output is recoverable and points to the next valid operation without executing it.
- Never imply network access, daemon mode, watcher mode, or install/uninstall support.

## pdf_search

Expanded sections:

- `ERROR` for encrypted, textless, timeout, malformed, or outside-workspace failures.
- `QUERY`: path, query, limit, cache state, and extraction/search phase.
- `SUMMARY`: matched pages, returned count, exact/fuzzy distribution, and truncation.
- `MATCHES`: page-oriented records with match type, score, edit count, matched text, and bounded context.
- `BOUNDS`: page/document text caps, timeout, and cache identity/invalidation state.

Rules:

- Exact matches rank before fuzzy matches in display as they do in execution.
- Context ordering remains best-effort and is labeled as such.
- The renderer never attempts OCR or semantic interpretation.
- Local-only behavior must remain visible; no remote assets or document fetches are part of the design.

## Search regression cases

- `rg` Unicode columns, byte paths, and merged context.
- `sg` metavariable-heavy output at narrow widths.
- `codegraph` not-indexed and unhealthy-index recoverable displays.
- `pdf_search` encrypted and textless failure distinctions.
- No-match pages remain explicit and cannot loop.
- Expanded output stays within line budgets while retaining file/page identity.
