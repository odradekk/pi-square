# `github_search`

**Family:** remote · **Scope:** parent, and child only for explicitly opted-in
trusted roles (of the bundled roles, only Librarian) · **Owner:**
`src/github/tools.ts`, rendered by `src/display/remote-adapters.ts`

**Status:** Implemented.

The four `github_*` tools share one grammar on top of the remote-record
grammar of [search.md](search.md). This document is the group reference;
[github-read.md](github-read.md), [github-tree.md](github-tree.md), and
[github-commit.md](github-commit.md) record only their differences.

## Current output

```
✓ ⌬ GitHub search ripgrep language:rust stars:>1000                          2ms
│    returned=2 · total=2 · phase=done · kind=repositories · query=ripgrep
│    language:rust stars:>1000 · limit=3
│  github_search repositories
│  query: ripgrep language:rust stars:>1000
│  page: 1 · returned: 2 · total: 2 · incomplete: false
│
│  ... 7 source lines hidden
│      Rust · 9794 stars
│      https://github.com/phiresky/ripgrep-all
│
└─ rate 29/30 · search · reset 1786257378
```

Expanded:

```
│    SUMMARY ───────────────────────────────────────────────────────────────────
│      phase=done
│      returned=2
│      omitted=0
│      total=2
│      rate=29/30
│      kind=repositories
│
│    RESULTS ───────────────────────────────────────────────────────────────────
│      BurntSushi/ripgrep:BurntSushi/ripgrep
│        url=https://github.com/BurntSushi/ripgrep · language=Rust · stars=67125
│        ripgrep recursively searches directories for a regex pattern while
│        respecting your gitignore
```

## Defects

The remote-record defects 48 to 53 of [search.md](search.md) apply. In
addition, these are shared by the whole `github_*` group:

| # | Defect | Convention |
|---|---|---|
| 71 | The record title repeats the identity twice with a colon, `BurntSushi/ripgrep:BurntSushi/ripgrep` | — |
| 72 | The rate limit is rendered twice, in the collapsed trailer and in `SUMMARY`, and the reset time is a raw Unix timestamp | C6, C8 |
| 73 | The collapsed body contains the tool's own machine header, `page: 1 · returned: 2 · total: 2 · incomplete: false` | C4 |
| 74 | Model-facing continuation hints such as `More lines: line 7` are rendered as content | C7 |

## Target design

### Header

```
● GitHub search ripgrep language:rust stars:>1000                         1.4s
```

The title is `GitHub search`. The target is the query, truncated with `…`. The
search kind belongs to the summary row.

### Record layout

Two rows, as in [search.md](search.md):

1. The rank and the repository or file identity, stated exactly once.
2. The secondary facts in the muted tone.

Repository search:

```
● GitHub search ripgrep language:rust stars:>1000                         1.4s
│    1  BurntSushi/ripgrep
│       Rust · 67.1k stars · updated 3d ago
│    2  phiresky/ripgrep-all
│       Rust · 9.8k stars · updated 2mo ago
└─   2 repositories · rate 29 of 30 left
```

Code search:

```
│    1  BurntSushi/ripgrep · crates/printer/src/json.rs
│       Rust · 1.2 KB
```

The GitHub URL is never rendered. `owner/repo` and the file path are the
identity, and they are shorter and unambiguous.

### Summary row

| Case | Row |
|---|---|
| Repositories | `2 repositories · rate 29 of 30 left` |
| Code | `12 files in 4 repositories · rate 29 of 30 left` |
| Bounded | `10 of 240 repositories · continue at page 2 · rate 29 of 30 left` |
| Incomplete provider result | adds the `partial` qualifier |
| Nothing found | `No results` |

The rate limit appears once, in this row, as a plain count. The reset time is
rendered only in the expanded body, and only as a relative time such as
`resets in 12m`. A raw Unix timestamp is never shown.

### Expanded body

One `RESULTS` section with the same records plus a third muted row with the
repository description or the code text match, bounded to two display rows.
The `REQUEST` and `SUMMARY` sections are removed. One muted option row states
the kind, the page, and the reset time.

### Failure

| Cause | Row |
|---|---|
| No token | `No GitHub token is configured` |
| Authentication | `GitHub rejected the token` |
| Rate limit | `GitHub rate limit reached · resets in 12m` |
| Invalid query | `GitHub rejected the query` |
| Timeout | `GitHub did not answer in time` |

The token never appears in any row, error, detail, or diagnostic.

## Acceptance criteria

1. The header shows `●`, the title `GitHub search`, and the query as the
   target.
2. Each record states its identity exactly once, with no `owner/repo:owner/repo`
   duplication and no GitHub URL.
3. The rate limit appears once, as a plain count, and the reset time is
   relative and expanded-only.
4. No machine header row and no model-facing continuation hint is rendered.
5. The summary row states the result counts and the paging continuation.
6. No token ever appears in any state.
7. The model-facing text is unchanged.
8. Every state is bounded at 39, 40, 63, 64, 80, 99, 100, and 120 columns in
   both bundled themes.

## Out of scope

- Any write capability, any host other than GitHub.com, and any change to the
  read-only contract.
