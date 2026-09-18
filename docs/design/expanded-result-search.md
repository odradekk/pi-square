# Search Expanded Results

Scope: `grep`
Parent tools: yes. Child-capable: yes with existing role restrictions.
Primary family contract: query and location are the first-level identity; content excerpts are evidence, not raw dumps.

## Shared search grammar

Expanded search results use this order:

1. Error or recoverability state.
2. Query and effective filters.
3. Result/paging summary.
4. Grouped matches or semantic evidence.
5. Truncation, stderr, and binary/identity notices.

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

## Search regression cases

- No-match pages remain explicit and cannot loop.
- Expanded output stays within line budgets while retaining file/page identity.
