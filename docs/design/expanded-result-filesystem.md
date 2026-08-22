# Filesystem Expanded Results

Scope: `read`, `ls`, `edit`, `write`, `find`
Parent tools: all six. Child-capable: all six.
Primary family contract: paths first, authoritative content second, projected state always labeled.

## Shared filesystem grammar

Expanded filesystem results use this order:

1. Error or mutation warning.
2. Result summary.
3. Path/location context.
4. Structured content, records, or diff.
5. Truncation, binary, image, or projected-preview notice.

Path values remain workspace-relative when Pi's tool result exposes them that way. Absolute or outside-workspace values stay exact and sanitized; the display layer does not imply ownership. Binary/image results never fabricate textual content.

## read

Collapsed: title, path, duration, and status remain the only persistent identity.

Expanded sections:

- `ERROR` when present.
- `FILE`: path, line range when present, image metadata when present.
- `CONTENT`: bounded code/text block with line-number gutter and language inferred conservatively from extension for display only.
- `TRUNCATION`: line, byte, and continuation indicators supplied by Pi's read details.

Rules:

- Text content receives a code block and line numbers.
- Image attachments remain Pi image components outside the textual section; the textual section only carries bounded metadata.
- Directory or unreadable outcomes render as explicit records, not as fake content.
- The display must not add syntax parsing that can misclassify content; language labels are best-effort display metadata only.

## ls

Expanded sections:

- `ERROR` when present.
- `DIRECTORY`: canonical target and entry count.
- `ENTRIES`: bounded path hierarchy with directory/file markers, grouped by Pi's result order rather than re-sorted.
- `LIMIT`: remaining entry or depth notices when Pi reports truncation.

Rules:

- Directory grouping is visual, not a filesystem claim.
- Symlinks and special entries remain textual unless Pi's structured details identify their kind.
- No file content is read by the display layer.

## edit

Expanded sections:

- `ERROR` for failed exact-match or validation outcomes.
- `TARGET`: path, replacement count, and first changed line when available.
- `DIFF`: authoritative Pi edit patch, using existing split/unified diff policy.
- `NOTES`: bounded warning details such as omitted or unchanged edits.

Rules:

- Authoritative result diffs replace any projected call preview after execution.
- The exact edit count and failed edit identity must be visible without expanding model content manually.
- The mutation queue and Pi execution path remain untouched.

## write

Expanded sections:

- `ERROR` when present.
- `TARGET`: path, byte count, and whether the operation created or replaced content when exposed.
- `DIFF` for authoritative result details; otherwise `CONTENT` shows bounded submitted content.
- `PROJECTED` only when a preview was projected before execution; terminal output must not retain an obsolete projected-preview warning after a successful write.
- `TRUNCATION` for display budget or file-preview limits.

Rules:

- Projected previews remain workspace-bounded, UTF-8 text, regular-file, 1 MB-capped, TOCTOU-checked, and non-authoritative.
- Binary preview refusal is explicit as `binary`, not a control-character dump.
- A final result should never say `projected preview unavailable` as though the write itself failed.

## find

Expanded sections:

- `ERROR` when present.
- `QUERY`: pattern, root/path, type, and depth filters supplied by args.
- `RESULTS`: bounded path hierarchy or records with directory/file markers.
- `PAGING`: returned, limit, remaining, and truncation metadata.

Rules:

- Results remain in Pi result order.
- Paths are not read or stat'ed again by display.
- Empty results are an explicit `No matching paths` state, not a blank body.

## Filesystem regression cases

- Workspace-inside and workspace-outside write previews.
- Binary write preview refusal.
- Unicode paths and surrogate-safe truncation.
- Long paths at 39 and 40 columns.
- Expanded/collapsed transitions reuse one operational component.
- Authoritative edit diff replaces projected content after terminal result.
