# `github_commit`

**Family:** remote · **Scope:** parent, and child only for explicitly opted-in
trusted roles · **Owner:** `src/github/tools.ts`, rendered by
`src/display/remote-adapters.ts`

**Status:** Implemented.

Uses the `github_*` grammar of [github-search.md](github-search.md) and the
diff grammar of [edit.md](edit.md).

## Current output

```
✓ ⌬ GitHub commit master                                                     2ms
│    returned=2 · phase=done · repo=BurntSushi/ripgrep · ref=master · limit=4
│  github_commit BurntSushi/ripgrep@3fce3b5bb0236da2df6d99672afb8a719642eca7
│  ignore-0.4.33
│
│  author: Andrew Gallant · 2026-08-04T14:00:08Z
│  ... 25 source lines hidden
│   A fast library for efficiently matching ignore files such as `.gitignore`
│  ```
│
└─ rate 4996/5000 · core · reset 1786260935
```

Expanded `SUMMARY`:

```
│      phase=done
│      returned=2
│      rate=4996/5000
│      sha=3fce3b5bb0236da2df6d99672afb8a719642eca7
│      author=Andrew Gallant
│      date=2026-08-04T14:00:08Z
│      message=ignore-0.4.33
│      verified=yes
│      additions=+2
│      deletions=-2
│      changes=4
```

## Defects

The group defects 71 to 74 of [github-search.md](github-search.md) apply. In
addition:

| # | Defect | Convention |
|---|---|---|
| 76 | The full 40-character SHA and a raw ISO date are rendered | C4, C6 |
| 78 | The collapsed body dumps the commit message and patch text with a head and tail split, including a stray closing fence ` ``` ` | C4 |
| 79 | The expanded `SUMMARY` prints eleven key-value fields, including the commit message that is already the record title | C4, C8 |

## Target design

### Header

```
● GitHub commit BurntSushi/ripgrep@3fce3b5                                1.2s
```

The target is `owner/repo@<short sha>`. When the model supplied a branch or a
tag, the resolved short SHA is still shown, because it is the identity of what
was read.

### Collapsed body

The commit identity, then the changed-file list bounded by `previewLines`,
then the summary row.

```
● GitHub commit BurntSushi/ripgrep@3fce3b5                                1.2s
│    ignore-0.4.33
│    Andrew Gallant · 5d ago · verified
│    M  crates/ignore/Cargo.toml                                         +2 −2
│    M  crates/ignore/README.md                                          +1 −1
└─   2 files · +3 −3 · rate 4996 of 5000 left
```

Rules:

1. The first row is the commit subject only. The body of the message belongs
   to the expanded view.
2. The second row states the author, a relative date, and the signature state.
   A raw ISO date and a full SHA are never rendered.
3. Each changed file uses one row: the status letter, the path, and the
   per-file `+N −M` counts.
4. Patch text is never rendered in the collapsed body.

### Summary row

| Case | Row |
|---|---|
| Complete | `2 files · +3 −3 · rate 4996 of 5000 left` |
| Bounded file list | `20 of 340 files · continue at page 2` |
| No patch available | adds `· patches unavailable` |
| Merge commit | adds `· merge of 2 parents` |

### Expanded body

One `MESSAGE` section with the full commit message, one `FILES` section with
the complete bounded file list, and one `PATCH` section that renders the
available patches with the diff rules of [edit.md](edit.md): new-file line
numbers, no `@@` header, word-level emphasis, and the policy line budget. A
missing or omitted patch is stated once in the muted tone.

## Acceptance criteria

1. The header target is `owner/repo@<short sha>`.
2. No full SHA and no raw ISO date is rendered in any state.
3. The collapsed body shows the subject, the author line, and a bounded
   changed-file list, and no patch text.
4. Each changed file states its status and its `+N −M` counts on one row.
5. Patches render with the `edit` diff rules and never with `@@` headers.
6. The expanded body has no `SUMMARY` section and no key-value field list.
7. The model-facing text is unchanged.
8. Every state is bounded at 39, 40, 63, 64, 80, 99, 100, and 120 columns in
   both bundled themes.
