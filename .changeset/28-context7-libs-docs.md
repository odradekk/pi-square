---
"@odradekk/pi-square": minor
---

Migrate Context7 library and docs to the Claude-like operational interface.

Library search and documentation retrieval already shared display integration through the generic `createRemoteAdapter` (Request/Summary/Results sections, lifecycle markers). This closes the metadata and summary gaps found during review:

- **Metadata duplication fixed**: `libs` showed both `libraryName` (raw arg-key) and `library` (renamed); `docs` showed both `libraryId`/`library` and `max_tokens`/`maxTokens`. Added `libraryName` and `libraryId`/`max_tokens` to the `REMOTE_SUPPRESS` set.

- **Docs summary enriched**: Previously only `status` and `phase` appeared. Now surfaces code/info snippet counts (`code=N/M`, `info=N/M`), combined `omitted`/`oversized`/`invalid` counts (distinguishing quota cutoff from individually-oversized from malformed-provider-data), consumed token budget (`tokens=estimated/maxTokens`), redirect indicators (`redirected=yes`, `finalLibrary=...`), retry hints (`retryAfter=Ns`), filter status (`filter=applied`), and rules omission (`rules=omitted`).

- **Libs summary enriched**: Added `filter=applied` for `searchFilterApplied`, and separate `invalid`/`oversized` count fields alongside the existing `omitted` for provider-data quality visibility.

All new summary fields are additive and detected by field presence (`codeCounts.returned !== undefined`, etc.), so search/fetch and other remote tools are unaffected. Model-facing schemas, execution behavior, result details, and security boundaries are unchanged.
