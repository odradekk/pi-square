---
"@odradekk/pi-square": minor
---

Migrate GitHub tree and commit inspection to the operational interface.

Tree and commit display already shared integration through `createRemoteAdapter` from #30. This closes the remaining #31 acceptance-criteria gaps:

- **Commit message and date visible**: `details.message` and `details.authoredAt` now appear in the Summary section alongside `sha`, `author`, and `verified`. Previously these were only in the model-facing text content — the base adapter's row-based rendering was replaced by structured sections.

- **Empty results indicator**: Tree results with zero entries now show `(empty directory)` (or `(no entries at offset N)` when paging past a non-empty directory) instead of a raw text fallback. Commit results with zero changed files show `(no changed files)`. Previously these appeared as empty Results sections with the raw tool output text leaking through the Output fallback.

- **Entry-kind coverage verified**: All four tree entry types (`file`, `directory`, `symlink`, `submodule`) are explicitly tested with their structured display.

- **All three patch states verified**: Commit file records explicitly show `patch=included`, `patch=missing` (binary/unavailable), and `patch=omitted` (budget-exhausted), with `patches=N omitted` in the Summary.

Model-facing schemas, execution behavior, result details, authentication boundaries, and security redaction are unchanged.
