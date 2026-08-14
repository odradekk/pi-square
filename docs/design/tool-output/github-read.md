# `github` (read)

**Family:** remote · **Scope:** parent, and child only for explicitly opted-in
trusted roles · **Owner:** `src/github/tools.ts`, rendered by
`src/display/remote-adapters.ts`

**Status:** Implemented.

Uses the `github_*` grammar of [github-search.md](github-search.md).

## Current output

```
⠋ ⌬ GitHub read                                                              1ms
└─   repo=BurntSushi/ripgrep · path=README · limit=6

✓ ⌬ GitHub read                                                              1ms
│    phase=done · repo=BurntSushi/ripgrep · path=README · limit=6
│  github_read BurntSushi/ripgrep:README.md
│  ref: default · sha: 54a7158a564faae22988da41efb1ef279e06fe5e · lines: 1-6/542
│
│  1: ripgrep (rg)
│  ... 5 source lines hidden
│
│  More lines: line 7
└─ rate 4999/5000 · core · reset 1786260935
```

Expanded — the `CONTENT` section numbers the tool's own header as file lines:

```
│    SUMMARY ───────────────────────────────────────────────────────────────────
│      phase=done
│      rate=4999/5000
│      sha=54a7158a564faae22988da41efb1ef279e06fe5e
│      lines=6/542
│      hasMore=yes
│
│    CONTENT ───────────────────────────────────────────────────────────────────
│     1  github_read BurntSushi/ripgrep:README.md
│     2  ref: default · sha: 54a7158a564faae22988da41efb1ef279e06fe5e · lines:
│        1-6/542
│     3
│     4  1: ripgrep (rg)
```

## Defects

The group defects 71 to 74 of [github-search.md](github-search.md) apply. In
addition:

| # | Defect | Convention |
|---|---|---|
| 69 | The header has no target. The repository and the path appear only in the body | C5 |
| 70 | The `CONTENT` section renders the tool's own text header as numbered file lines, so the displayed file content is not the file content and every line number is wrong | — |
| 76 | The full 40-character SHA is rendered as a key-value field | C4 |

Defect 70 is the most severe defect found in this family: the rendering states
something false about the remote file.

## Target design

### Header

```
● GitHub read BurntSushi/ripgrep README.md                                1.1s
```

The target is `owner/repo` followed by the repository-relative path. When the
model asked for the README without a path, the resolved file name is shown.
The target is elided in the middle when it does not fit; the repository and
the file name stay visible.

### Collapsed body

One summary row, exactly as [read.md](read.md) defines for a local file.

| Case | Row |
|---|---|
| Whole file | `542 lines · README.md` |
| Windowed | `lines 1-6 of 542 · continue at line 7` |
| Empty | `Empty file` |

```
● GitHub read BurntSushi/ripgrep README.md                                1.1s
└─   lines 1-6 of 542 · continue at line 7 · rate 4999 of 5000 left
```

### Expanded body

One `CONTENT` section with **only the remote file text**, numbered with the
real remote line numbers. The tool's own header rows are removed before the
section is built.

```
│      1  ripgrep (rg)
│      2  ============
│      3  ripgrep is a line-oriented search tool …
└─   lines 1-6 of 542 · continue at line 7
```

One muted row below the section states the resolved ref and the short SHA:
`master · 54a7158`. The full SHA is never rendered.

### Failure

| Cause | Row |
|---|---|
| Missing path | `File does not exist in BurntSushi/ripgrep` |
| Binary or oversized | `File is not readable as UTF-8 text` |
| Unknown ref | `Ref does not exist` |
| Group failures | as in [github-search.md](github-search.md) |

## Acceptance criteria

1. The header target states `owner/repo` and the file path.
2. The `CONTENT` section contains only remote file text, and its line numbers
   are the real remote line numbers.
3. No tool header row, no `More lines:` hint, and no full SHA is rendered.
4. The summary row states the line window, the total, and the continuation.
5. The ref and the short SHA appear once, in the expanded body.
6. The model-facing text is unchanged.
7. Every state is bounded at 39, 40, 63, 64, 80, 99, 100, and 120 columns in
   both bundled themes.
