---
"@odradekk/pi-square": minor
---

Read valid Context Memory and recover each block's original sources

Makes an existing valid Context Memory compaction fully inspectable without adding Memory writes (odradekk/pi-square#217, parent spec #215). The feature stays default-off; native, unknown, malformed, or over-bound compactions remain usable as opaque Pi summaries.

- Completes the v1 persisted format: the fixed deterministic wrapper and separator framing, the `pi-square.context-memory/1` tag, and the ordered `endEntryId`/`markdownBytes` byte directory. The latest compaction on the current leaf parses only when its exact format, wrapper, byte directory, source ordering, bounds, and kept-tail relationship are valid (64 KiB details cap, 16 KiB block bound); anything else renders opaque with no guessed repair and no fallback to older Memory entries.
- Reconstructs each block's continuous original-entry range on the carrying compaction's own ancestor path, following Pi's context projection minus compaction entries and Context Memory protocol artifacts (`submit_memory`/`read_memory_source` calls and results).
- Activates the parent-only `read_memory_source` tool only for valid non-empty current Memory, re-synchronized at session start, tree navigation, and compaction completion while preserving every other active tool (the built-in baseline restore now preserves the dynamically owned names). Execution revalidates and returns one fixed 16 KiB UTF-8 transcript page — code-point-safe paging, role/tool/error structure preserved, storage paths, entry IDs, timestamps, provider metadata, and binary payloads excluded — with only the five bounded paging details and the safe short codes `MEMORY_NOT_AVAILABLE`, `BLOCK_OUT_OF_RANGE`, `PAGE_OUT_OF_RANGE`, and `MEMORY_CHANGED`.
- `/context` now shows the active Memory hierarchy (state, Memory/budget estimate, block count, stable prefix, next operation, usage, one bounded chronological row per block) and the opaque state line; `/context memory <block> [page]` performs read-only human inspection sharing the tool's transcript renderer and paging, with no model call and no session write.
- Both tools render through the shared operational display system: `submit_memory` keeps a neutral `candidate` row with its fixed pending outcome and never echoes Markdown; `read_memory_source` shows a `block B · page P` target with the transcript page visible only when expanded.
