# Search Expanded Results

Scope: `grep`, `codegraph`, `pdf_search`
Parent tools: all four. Child-capable: all four with existing role restrictions.
Primary family contract: query and location are the first-level identity; content excerpts are evidence, not raw dumps.

## Shared search grammar

Expanded search results use this order:

1. Error or recoverability state.
2. Query and effective filters.
3. Result/paging summary.
4. Grouped matches or semantic evidence.
5. Truncation, stderr, and binary/identity notices.

Structured details already exist for `codegraph` and `pdf_search`; adapters must consume those details before falling back to model-facing text.

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

- `codegraph` not-indexed and unhealthy-index recoverable displays.
- `pdf_search` encrypted and textless failure distinctions.
- No-match pages remain explicit and cannot loop.
- Expanded output stays within line budgets while retaining file/page identity.
