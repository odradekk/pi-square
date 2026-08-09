# `ls`

**Family:** filesystem · **Scope:** parent and child · **Owner:**
`src/display/builtins.ts` (Pi built-in, decorated by `decorateBuiltinDefinition`)

**Status:** Proposed. Not implemented.

## Current output

Rendered through the production decoration path at 80 columns with a plain
theme.

Directory with five entries, collapsed and expanded:

```
✓ ▪ LS /tmp/pi-square-render-rUWyVc                                          1ms
│    ENTRIES ───────────────────────────────────────────────────────────────────
│    f .gitignore
│    d empty/
│    f package.json
│    f README.md
└─   d src/

✓ ▪ LS /tmp/pi-square-render-rUWyVc                                          0ms
│    DIRECTORY ─────────────────────────────────────────────────────────────────
│      path=/tmp/pi-square-render-rUWyVc
│
│    ENTRIES ───────────────────────────────────────────────────────────────────
│    f .gitignore
│    d empty/
│    f package.json
│    f README.md
└─   d src/
```

Empty directory and missing directory:

```
✓ ▪ LS /tmp/pi-square-render-rUWyVc/empty                                    1ms
│    ENTRIES ───────────────────────────────────────────────────────────────────
└─   f (empty directory)

✗ ▪ LS /tmp/pi-square-render-rUWyVc/absent                                   0ms
└─   Path not found: /tmp/pi-square-render-rUWyVc/absent
```

## Defects

| # | Defect | Convention |
|---|---|---|
| 1 | The title `LS` is uppercase and is not a word | C1 |
| 2 | The path is absolute and consumes most of the header | C2 |
| 3 | The collapsed body lists every entry and states no count | C4 |
| 4 | The expanded body adds only a `DIRECTORY` section that repeats the header path | C8 |
| 5 | The `d`/`f` prefix repeats the information already carried by the trailing `/` | — |
| 6 | The empty-directory placeholder is rendered as a file entry, `f (empty directory)` | — |
| 7 | Directories and files are mixed in one alphabetical run | — |
| 8 | The error repeats the header path and is not a sentence | C6, C8 |
| 9 | A large directory has no defined bound and no overflow notice | C7 |

## Target design

### Header

```
● List src/display                                                         1ms
```

The target is the workspace-relative path. The working directory itself is
shown as `.`.

### Collapsed body

One counting row. A count of zero is omitted, so a directory that holds only
files does not print `0 directories`.

| Case | Row |
|---|---|
| Directories and files | `3 directories · 9 files` |
| Files only | `5 files` |
| Directories only | `2 directories` |
| Empty | `Empty directory` |
| Failure | one sentence, see below |

```
● List .                                                                   1ms
└─   3 directories · 9 files
```

### Expanded body

One `ENTRIES` section. Directories come first, then files; each group is
sorted alphabetically. A directory keeps its trailing `/` and there is no
`d`/`f` prefix.

```
● List .                                                                   1ms
│    empty/
│    src/
│    .gitignore
│    package.json
│    README.md
└─   3 directories · 9 files
```

Rules:

1. The section keeps the line budget of the effective display policy.
2. When entries are dropped, the summary row states the overflow:
   `3 directories · 9 files · 6 not shown`.
3. An empty directory produces no `ENTRIES` section. The collapsed row is the
   whole body.
4. Reordering is presentation only. The text returned to the model keeps the
   order that Pi produced.

### Failure

```
● List src/absent                                                          0ms
└─   Directory does not exist
```

| Cause | Row |
|---|---|
| Missing path | `Directory does not exist` |
| Path is a file | `Path is a file` |
| Permission | `Permission denied` |
| Anything else | The first line of the platform message |

The raw platform text stays available in the expanded `ERROR` section.

## Acceptance criteria

1. The header shows `●`, the title `List`, and a workspace-relative path, with
   the working directory shown as `.`.
2. The collapsed body is exactly one row and lists no entry names.
3. Zero counts are omitted from the counting row.
4. The expanded body sorts directories before files, marks directories with a
   trailing `/`, and shows no `d`/`f` prefix.
5. An empty directory renders `Empty directory` and no `ENTRIES` section.
6. A bounded listing states the number of entries that are not shown.
7. A missing directory renders one sentence and does not repeat the path.
8. The model-facing text is unchanged, including its original entry order.
9. Every state is bounded at 39, 40, 63, 64, 80, 99, 100, and 120 columns in
   both bundled themes.

## Out of scope

- Recursive or tree listing. Pi's `ls` lists one level.
- File size, mode, or modification time columns.
