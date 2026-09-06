# `library_search`

**Family:** remote · **Scope:** parent and child · **Owner:**
`src/web/tools/library-search.ts`, rendered by `src/display/remote-adapters.ts`

**Status:** Implemented.

`libs` uses the remote-record grammar of [search.md](search.md). This document
records only what differs.

## Current output

```
⠋ ⌬ Library search ripgrep                                                   1ms
└─   library=ripgrep · query=json output · limit=3

✓ ⌬ Library search ripgrep                                                   1ms
│    status=ready · phase=done · library=ripgrep · query=json output · limit=3
│  [1] Ripgrep
│      /burntsushi/ripgrep
│  ... 31 source lines hidden
│      trust: 9.5
│      benchmark: 84.75
│
└─ > 2 candidates omitted
```

Expanded:

```
│    RESULTS ───────────────────────────────────────────────────────────────────
│      /burntsushi/ripgrep
│        title=Ripgrep · stars=52658 · snippets=344 · tokens=22942 · trust=9.1 ·
│        benchmark=74.26 · updated=2026-07-10T10:32:48.574Z
│        ripgrep is a fast, line-oriented search tool that recursively searches
│        the current directory for a regex pattern, respecting gitignore rules
│        and skipping hidden/binary files by default.
```

## Defects

The remote-record defects 48 to 53 of [search.md](search.md) apply. In
addition:

| # | Defect | Convention |
|---|---|---|
| 57 | The record leads with the library ID and demotes the title to a `title=` field, which inverts the primary and the secondary identity | — |
| 58 | One record prints seven key-value metrics and wraps to two rows | C4 |
| 59 | The update time is a raw ISO timestamp | C6 |
| 60 | The collapsed body ends with the raw block-quote syntax `> 2 candidates omitted` | — |

## Target design

### Header

```
● Library search ripgrep                                                  1.1s
```

The target is the library name that the model supplied.

### Record layout

Two rows, as in [search.md](search.md), rendered only when the entry is
expanded. The collapsed entry is one row (C4) with the candidate counts
inline:

```
● Library search ripgrep 3 candidates · 2 omitted                         1.1s
```

Expanded:

```
● Library search ripgrep                                                  1.1s
│    1  Ripgrep · /burntsushi/ripgrep
│       52.7k stars · 344 snippets · 22.9k tokens · trust 9.1 · updated 30d ago
│    2  Ripgrepy · /securisec/ripgrepy
│       61 stars · 4 snippets · 359 tokens · trust 7.9 · updated 1y ago
└─   3 candidates · 2 omitted
```

Each record uses two rows:

1. The rank, the library title, then the library ID in the muted tone.
2. The retained metrics in the muted tone.

Retained metrics, in this order: stars, snippets, tokens, trust, updated.
`benchmark` is removed, because its definition is not published and it does
not change a library choice.

Formatting rules:

1. Star and token counts use a short form: `52.7k`, `22.9k`, `1.2M`.
2. The update time is relative and rounded: `30d ago`, `1y ago`.
3. A metric that the provider did not return is omitted, not printed as `0`.

### Inline summary

| Case | Row |
|---|---|
| Complete | `3 candidates` |
| With omissions | `3 candidates · 2 omitted` |
| Nothing found | `No candidates for ripgrep` |

The omission notice never uses block-quote syntax.

### Expanded body

The same records, plus a third muted row per record with the library
description bounded to two display rows. The `REQUEST` and `SUMMARY` sections
are removed. The request options `limit` and `mode` appear as one muted row
above the section, and only when the model set them.

### Failure

| Cause | Row |
|---|---|
| Missing key | `No Context7 key is configured` |
| Authentication | `Context7 returned 401` |
| Rate limit | `Context7 rate limit reached` |
| Timeout | `Context7 did not answer in time` |
| Anything else | The first line of the provider message |

## Acceptance criteria

1. The record leads with the title and shows the library ID as secondary
   identity.
2. Exactly five metrics are shown, in the order stars, snippets, tokens,
   trust, updated, and `benchmark` never appears.
3. Counts use the short form and the update time is relative.
4. The inline summary states the candidate count and the omission count, with
   no block-quote syntax.
5. The expanded body has one `RESULTS` section, at most one option row, and no
   `REQUEST` or `SUMMARY` section.
6. The model-facing text is unchanged.
7. Every state is bounded at 39, 40, 63, 64, 80, 99, 100, and 120 columns in
   both bundled themes.

## Out of scope

- Changing the Context7 ranking or the model-facing text.
