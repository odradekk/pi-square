# Error codes

Error-code contract for the vendored hash-anchored editing module and its
pi-square workspace wrappers. Every code emitted by the module source is
documented here, and every code documented here is emitted by the module source;
`tests/anchored-edit/core/error-codes.test.ts` enforces both directions.

| Code | Meaning |
| --- | --- |
| `[E_BAD_SHAPE]` | Request envelope or edit item has unknown, missing, or wrongly-typed fields (for example `replacement_text` must be a string with `\n` line separators). |
| `[E_BAD_REF]` | An anchor in `remove_from`/`remove_to` is not a bare 3-char hash. |
| `[E_STALE_ANCHOR]` | An anchor does not match any line in the current file; call `read` for fresh anchors. |
| `[E_AMBIGUOUS_ANCHOR]` | An anchor matches multiple lines; call `read` for fresh anchors. |
| `[E_INVALID_PATCH]` | A `replacement_text` line is a diff-preview row (`+HASH│`, `-HASH│`, `-   │`). The marker is stripped automatically with a warning. |
| `[E_BARE_HASH_PREFIX]` | A `replacement_text` line starts with a hash-like `HASH│` prefix. The prefix is stripped automatically with a warning. |
| `[E_BAD_OP]` | Range start line is after range end line. The implementation swaps the pair with a warning when it can resolve the range; otherwise it refuses the invalid range. |
| `[E_WOULD_EMPTY]` | An edit would empty a non-empty file; use `write` instead. |
| `[E_NOT_FOUND]` | The path does not exist. |
| `[E_ACCESS]` | The file is not readable or writable. |
| `[E_READ_PATH]` | The requested `read` path cannot be resolved (an unresolvable cwd or a symlink loop). A missing path is not this code: Pi's native read failure is preserved. |
| `[E_READ_FAILED]` | Anchored-read guarding or post-factory transformation failed. The message gives the cause and may provide an appropriate fallback. |
| `[E_NOT_TEXT]` | The path is a directory, binary file, image, or UTF-16/UTF-32 encoded text; hashline editing only supports text files. |
| `[E_FILE_LOCKED]` | `replace`, `revert`, or a subagent `write` refused: the cross-process write lock on the target file could not be acquired within the bounded wait because another editor holds it. For `replace` the refusal is `[E_RANGE_STALE]` with fresh anchors; `revert` and `write` use `[E_FILE_LOCKED]` and leave state (including the revert record) untouched for a retry. |
| `[E_UNDO_STALE]` | `revert` refused: the file was modified or deleted after the last replace. |
| `[E_UNDO_OWNER]` | A subagent's `revert` refused: the most recent edit belongs to another agent, and the message names the owning agent. The parent may revert any agent's edit. |
| `[E_UNDO_UNAVAILABLE]` | Undo history could not be persisted to the hash store; the `replace` was refused and the file was left unchanged. |
| `[E_RANGE_STALE]` | A line in the replaced range no longer matches what was last shown (the file changed on disk, or the line was never shown). The edit was refused; the current range is returned with fresh anchors. |
| `[E_FILE_TOO_LARGE]` | The file exceeds the 238,328-line hashline limit or the 100MB size limit. |
| `[E_OUTSIDE_WORKSPACE]` | The canonical target resolves outside the workspace. Retained for callers that explicitly opt into workspace confinement; no production surface emits it since the writable-child compositions adopted native path authority (#186, following the parent in #185). |
