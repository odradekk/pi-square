# `pdf_search`

**Family:** search · **Scope:** parent, and child only by explicit trusted
opt-in · **Owner:** `src/pdf-search/tool.ts`, rendered by
`src/display/search-adapters.ts`

**Status:** Proposed. Not implemented.

## Current output

Two matches in a four-page document:

```
⠋ ⌕ PDF search marker                                                        1ms
└─   query=marker · path=.tmp-render-fixture/design-notes.pdf

✓ ⌕ PDF search marker                                                      485ms
│    returned=2 · status=success · phase=done · query=marker ·
│    path=.tmp-render-fixture/design-notes.pdf
│    MATCHES ───────────────────────────────────────────────────────────────────
│    .tmp-render-fixture/design-notes.pdf:1            exact · score 1 · edits 0
│      operational interface design the renderer owns every tool entry.
│      lifecycle markers use one glyph.
│    .tmp-render-fixture/design-notes.pdf:3            exact · score 1 · edits 0
│      motion policy a static marker removes the fast repaint loop. the duration
└─     remains the live element.
```

Expanded adds:

```
│    QUERY ─────────────────────────────────────────────────────────────────────
│      query=marker
│      path=.tmp-render-fixture/design-notes.pdf
│      limit=10
│
│    SUMMARY ───────────────────────────────────────────────────────────────────
│      status=success
│      phase=done
│      returned=2
│      totalMatches=2
│      pages=4
│      cacheHit=false
```

Missing document:

```
✗ ⌕ PDF search marker                                                        1ms
│    status=error · phase=done · code=INVALID_PDF_PATH · query=marker ·
│    path=.tmp-render-fixture/absent.pdf
│    Error: PDF path does not exist or cannot be resolved: ENOENT: no such file
│    or directory, lstat
└─   '/home/s1n/Projects/pi-square/.tmp-render-fixture/absent.pdf'
```

## Defects

| # | Defect | Convention |
|---|---|---|
| 26 | A key-value metadata row wraps to two rows and repeats the header query and path | C4, C8 |
| 27 | The expanded body repeats the same values as `QUERY` and `SUMMARY`, including the internal `cacheHit` telemetry | C8 |
| 28 | Every match repeats the document path, although the tool searches exactly one document | — |
| 29 | Every match carries `exact · score 1 · edits 0`, which is internal scoring detail | C4 |
| 30 | The page appears as a `:1` suffix, which reads as a line number | — |
| 31 | The failure text keeps the `Error:` prefix, the internal `INVALID_PDF_PATH` code, the `lstat` system call name, and an absolute path | C6 |

## Target design

### Header

```
● PDF search marker                                                      485ms
```

The target is the query. The document belongs to the summary row, because one
call searches one document.

### Collapsed body

One row per match. The row starts with the page label `page 1`, then the
normalized context with the matched text emphasized, truncated with `…`.

```
● PDF search marker                                                      485ms
│    page 1  operational interface design the renderer owns every tool entry…
│    page 3  motion policy a static marker removes the fast repaint loop. the…
└─   2 matches on 2 of 4 pages in design-notes.pdf
```

Rules:

1. Match rows keep the `previewLines` budget. Dropped rows are stated in the
   summary row and set the `truncated` badge.
2. An exact match carries no label. A fuzzy match closes its row with a muted
   `fuzzy`. The score and the edit distance appear only in the expanded body.
3. A context line is never wrapped.
4. The document name in the summary row is the file name. The full
   workspace-relative path appears in the expanded body.

### Summary row

| Case | Row |
|---|---|
| Matches | `2 matches on 2 of 4 pages in design-notes.pdf` |
| Bounded by `limit` | `10 of 34 matches on 9 of 120 pages in spec.pdf` |
| No match | `No matches in design-notes.pdf` |

### Expanded body

One `MATCHES` section with the full context of each match, bounded by the
policy, then one muted document row and the same summary row:

```
│    MATCHES ───────────────────────────────────────────────────────────────
│    page 1  operational interface design the renderer owns every tool entry.
│            lifecycle markers use one glyph.
│    page 3  motion policy a static marker removes the fast repaint loop. the
│            duration remains the live element.
│
│    docs/design-notes.pdf · 4 pages · cached
└─   2 matches on 2 of 4 pages in design-notes.pdf
```

A fuzzy match adds `fuzzy · 2 edits` in the muted tone at the end of its first
row. The fields `status`, `phase`, `returned`, `totalMatches`, and `cacheHit`
are never printed as key-value pairs. The cache state appears only as the word
`cached` in the document row.

### Failure

```
● PDF search marker                                                        1ms
└─   PDF does not exist
```

| Cause | Row |
|---|---|
| Missing path | `PDF does not exist` |
| Outside the workspace | `PDF is outside the workspace` |
| Encrypted | `PDF is encrypted` |
| No extractable text | `PDF has no extractable text` |
| Too large | `PDF is larger than 50 MB` |
| Too many pages | `PDF has more than 1,000 pages` |
| Timeout | `Search did not finish in 30s` |
| Anything else | The first line of the tool message |

The internal error code and the raw platform text stay available in the
expanded `ERROR` section. No row shows a system call name or an absolute path.

## Acceptance criteria

1. The header shows `●`, the title `PDF search`, and the query as the target.
2. Each match uses one row that starts with `page N` and never repeats the
   document path.
3. An exact match shows no type label; a fuzzy match shows a muted `fuzzy`.
4. The summary row states matches, matched pages, total pages, and the
   document name.
5. No surface prints `status`, `phase`, `returned`, `totalMatches`, or
   `cacheHit` as key-value pairs.
6. A failure renders one sentence with no `Error:` prefix, no internal code, no
   system call name, and no absolute path.
7. The model-facing JSON result is unchanged.
8. Every state is bounded at 39, 40, 63, 64, 80, 99, 100, and 120 columns in
   both bundled themes.

## Out of scope

- OCR, semantic search, and any remote document or asset fetch.
- Rendering PDF pages as images.
