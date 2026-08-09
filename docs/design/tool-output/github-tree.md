# `github_tree`

**Family:** remote · **Scope:** parent, and child only for explicitly opted-in
trusted roles · **Owner:** `src/github/tools.ts`, rendered by
`src/display/remote-adapters.ts`

**Status:** Proposed. Not implemented.

Uses the `github_*` grammar of [github-search.md](github-search.md) and the
path-list grammar of [find.md](find.md).

## Current output

```
⠋ ⌬ GitHub tree                                                              1ms
└─   repo=BurntSushi/ripgrep · path=/ · limit=8

✓ ⌬ GitHub tree                                                              1ms
│    returned=8 · total=27 · phase=done · repo=BurntSushi/ripgrep · path=/ ·
│    limit=8
│  github_tree BurntSushi/ripgrep:.
│  ref: default · depth: 1 · offset: 0 · returned: 8
│
│  d .cargo · 0 bytes
│  ... 7 source lines hidden
│
│  More entries: offset 8
│
└─ rate 4997/5000 · core · reset 1786260935
```

Expanded adds `REQUEST` and `SUMMARY` with `returned`, `total`, `requests`,
`rate`, and `hasMore`.

## Defects

The group defects 71 to 74 of [github-search.md](github-search.md) apply. In
addition:

| # | Defect | Convention |
|---|---|---|
| 69 | The header has no target | C5 |
| 75 | Entries keep the `d` prefix that [ls.md](ls.md) removes, and a directory is annotated `0 bytes` | — |
| 77 | The expanded `SUMMARY` renders the internal `requests` counter, which states how many REST calls the tool made | C4 |

## Target design

### Header

```
● GitHub tree BurntSushi/ripgrep crates/printer                           0.9s
```

The target is `owner/repo` and the browsed path. The repository root is shown
as `owner/repo` alone.

### Collapsed body

One summary row.

| Case | Row |
|---|---|
| Complete | `4 directories · 23 files` |
| Bounded | `8 of 27 entries · continue at offset 8 · rate 4997 of 5000 left` |
| Empty | `Empty directory` |

### Expanded body

One `ENTRIES` section with the same rules as [ls.md](ls.md): directories
first, then files, each group alphabetical, a directory marked only by a
trailing `/`, and no `d` or `f` prefix. A file states its size in the muted
tone; a directory states no size.

```
│    ENTRIES ───────────────────────────────────────────────────────────────
│    .cargo/
│    .github/
│    crates/
│    .gitignore                                                        1.1 KB
│    Cargo.toml                                                        2.4 KB
└─   4 directories · 23 files
```

One muted row below the section states the resolved ref, the depth, and the
short SHA when the API returned one. The internal `requests` counter and the
remote truncation flag are stated in words when they matter:
`GitHub truncated this tree`, with the `truncated` badge.

### Failure

| Cause | Row |
|---|---|
| Missing path | `Path does not exist in BurntSushi/ripgrep` |
| Path is a file | `Path is a file; use github_read` |
| Unknown ref | `Ref does not exist` |
| Group failures | as in [github-search.md](github-search.md) |

## Acceptance criteria

1. The header target states `owner/repo` and the browsed path.
2. Entries carry no `d` or `f` prefix, directories end with `/`, and no
   directory shows a byte size.
3. The summary row states directory and file counts, or the bounded window and
   the continuation offset.
4. Remote truncation is stated in words and sets the `truncated` badge.
5. The internal request counter is never rendered as a key-value pair.
6. The model-facing text is unchanged.
7. Every state is bounded at 39, 40, 63, 64, 80, 99, 100, and 120 columns in
   both bundled themes.
