# `parse`

**Family:** remote · **Scope:** parent only · **Owner:**
`src/web/tools/parse.ts`, rendered by `src/display/remote-adapters.ts`

**Status:** Proposed. Not implemented.

`parse` uses the remote-record grammar of [search.md](search.md). This
document records only what differs: the upload confirmation, the page
selection, and the provider diagnostics.

## Current output

A confirmed upload of two pages from a four-page document:

```
⠋ ⌬ PDF parse .tmp-render-fixture/design-notes.pdf                           1ms
└─   path=.tmp-render-fixture/design-notes.pdf · pages=1-2

✓ ⌬ PDF parse .tmp-render-fixture/design-notes.pdf                           2ms
│    status=success · phase=done · path=.tmp-render-fixture/design-notes.pdf ·
│    pages=1-2
│  # Parsed PDF
│
│  Path: .tmp-render-fixture/design-notes.pdf
│  Pages: 1-2
│  ... 8 source lines hidden
│
│  Placeholder document page two Lambda mu nu xi omicron. Pi rho sigma tau
│  upsilon.
└─
```

Expanded:

```
│    SUMMARY ───────────────────────────────────────────────────────────────────
│      status=success
│      phase=done
│      pageCount=2
│      outputLines=15
│      tokens=108/12000
│      uploaded=1.1 KB
│      sourceSize=1.7 KB
│
│    MARKDOWN ──────────────────────────────────────────────────────────────────
│    Parsed PDF
│
│    Path: .tmp-render-fixture/design-notes.pdf
│    Pages: 1-2
│    Selected pages: 2 of 4
│    Mode: auto
│    Firecrawl parsed pages: 2
│    Firecrawl warning: The engine used does not support the following features:
│    skipTlsVerification -- your scrape may be partial.
│
│    ───────────────────────────────────────────────────────────────────────────
│
│    Placeholder document page one Alpha beta gamma delta epsilon. Zeta eta
│    theta iota kappa.
│
│    DIAGNOSTICS ───────────────────────────────────────────────────────────────
│    The engine used does not support the following features:
└─   skipTlsVerification -- your scrape may be partial.
```

Declined upload:

```
× ⌬ PDF parse .tmp-render-fixture/design-notes.pdf                           1ms
│    status=declined · phase=done · path=.tmp-render-fixture/design-notes.pdf ·
│    pages=3
└─ PDF upload declined by the user.
```

## Defects

The remote-record defects 48 to 53 of [search.md](search.md) apply. In
addition:

| # | Defect | Convention |
|---|---|---|
| 64 | The collapsed body dumps the model-facing Markdown, including its own `# Parsed PDF`, `Path:`, and `Pages:` header block | C4 |
| 65 | The expanded `MARKDOWN` section renders that model header block again, plus a horizontal rule | C8 |
| 66 | The Firecrawl warning appears twice: inside `MARKDOWN` and again in `DIAGNOSTICS` | C8 |
| 67 | `tokens=108/12000`, `uploaded=1.1 KB`, and `sourceSize=1.7 KB` are coded key-value pairs | C4 |
| 68 | The declined result keeps the metadata row and wraps the decline sentence in a `MARKDOWN` section | C4 |

## Target design

### Header

```
● PDF parse design-notes.pdf                                  [needs input]
● PDF parse design-notes.pdf                                              2.4s
```

The target is the file name. The full workspace-relative path appears in the
expanded body. While the confirmation is open, the header carries the
`needs-input` badge and the lifecycle is `pending`.

### Collapsed body

One row per parsed page, in the `page N` form of
[pdf-search.md](pdf-search.md), with the parsed text truncated with `…`, then
the summary row.

```
● PDF parse design-notes.pdf                                              2.4s
│    page 1  Placeholder document page one Alpha beta gamma delta epsilon.…
│    page 2  Placeholder document page two Lambda mu nu xi omicron. Pi rho…
└─   2 of 4 pages · 1.1 KB uploaded · 108 tokens
```

The model-facing header block — `# Parsed PDF`, `Path:`, `Pages:`,
`Selected pages:`, `Mode:`, `Firecrawl parsed pages:`, `Firecrawl warning:` —
is removed before any row is built. Its values are already in the header, the
summary row, or the diagnostics.

### Summary row

| Case | Row |
|---|---|
| Success | `2 of 4 pages · 1.1 KB uploaded · 108 tokens` |
| Whole document | `4 pages · 1.7 KB uploaded · 210 tokens` |
| Output bounded | adds `· output truncated` and the `truncated` badge |
| Provider warning | adds the `warning` qualifier |
| Declined | `Upload declined` |
| Failure | one sentence, see below |

The upload size is always stated, because it is the quantity of local data
that left the machine.

### Expanded body

One `PAGES` section with the full parsed text of each page bounded by the
policy, then one muted row with the workspace-relative path, the parse mode,
and the destination host, then the summary row.

Provider diagnostics appear exactly once, in a `DIAGNOSTICS` section, and only
when the provider returned one.

### Declined and confirmation states

A declined upload is the `aborted` lifecycle. Its body is the single summary
row `Upload declined`. No `MARKDOWN` section and no metadata row is rendered.

The confirmation prompt itself stays Pi-owned and is unchanged. It remains the
only place that states the destination endpoint, the page selection, and the
Zero Data Retention consequence before any byte leaves the machine.

### Failure

| Cause | Row |
|---|---|
| Missing key | `No Firecrawl key is configured` |
| Missing file | `PDF does not exist` |
| Outside the workspace | `PDF is outside the workspace` |
| Encrypted | `PDF is encrypted` |
| Too large | `PDF is larger than 50 MB` |
| Too many pages | `More than 50 pages were selected` |
| Provider error | `Firecrawl returned 402` |
| Timeout | `Firecrawl did not answer in time` |

The provider body stays in the expanded `ERROR` section. The API key never
appears in any row, error, or diagnostic.

## Acceptance criteria

1. The header target is the file name, and the `needs-input` badge is shown
   while the confirmation is open.
2. The collapsed body shows one row per parsed page and contains no
   model-facing header block.
3. The summary row states the parsed and total page counts, the uploaded size,
   and the token count.
4. Provider diagnostics appear exactly once, in the expanded body.
5. A declined upload renders the aborted marker and the single row
   `Upload declined`.
6. `status`, `phase`, `pageCount`, `outputLines`, `tokens`, `uploaded`, and
   `sourceSize` never appear as key-value pairs.
7. No credential appears in any state.
8. The model-facing text is unchanged.
9. Every state is bounded at 39, 40, 63, 64, 80, 99, 100, and 120 columns in
   both bundled themes.

## Out of scope

- Any change to the confirmation contract, the upload bounds, or the fixed
  endpoint.
- Exposing `parse` to child sessions.
