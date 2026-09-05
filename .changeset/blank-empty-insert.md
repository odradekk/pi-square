---
"@odradekk/pi-square": minor
---

Complete blank-line and empty-file semantics for the anchored `insert` tool (#286)

- An empty-string `lines` item is now one real blank logical line instead of a rejected input: in normalized LF terms it adds one LF before a first row, one blank row between neighboring rows, and — appended after an unterminated last row — the two terminal LFs the blank row needs to exist; the empty `lines` array and embedded CR/LF remain rejected.
- An empty file is no longer refused: its anchored read serves one synthetic anchor row (`HASH│` with empty content), and `insert` initializes the file with exactly the requested logical lines, terminated, with `before` and `after` as the same initialization; a BOM is preserved and an empty file defaults to LF.
- Authorization, publication, and safety are unchanged: the synthetic anchor must be served for the empty file's exact content version like any other anchor, BOM and LF/CRLF/CR conventions and non-blank terminal-newline states are preserved, and all #285 operation-boundary guarantees (owner-scoped version-bound publication, literal content, truthful post-commit results) carry over.
- Metrics report every requested logical line, blank ones included, as added with zero removed, while the authoritative diff keeps the truthful remove/re-add representation the diff library produces when EOF terminator bytes change.
- The empty-file read and auto-read hints and the insert/read prompts now state the logical-line, blank-line, and synthetic-anchor contract explicitly.
