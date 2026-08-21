# `search`

**Family:** remote · **Scope:** parent and child · **Owner:**
`src/web/tools/search.ts`, rendered by `src/display/remote-adapters.ts`

**Status:** Implemented.

`search`, `fetch`, `libs`, and `docs` share one remote-record grammar. This
document is the reference for the group; the other three record only their
differences.

## Current output

```
⠋ ⌬ Web search ripgrep json output format                                    1ms
└─   queries=ripgrep json output format · limit=4

✓ ⌬ Web search ripgrep json output format                                    1ms
│    phase=done · queries=ripgrep json output format · limit=4
│  [1] Stats output in JSON mode · BurntSushi ripgrep · Discussion #3178
│      https://github.com/BurntSushi/ripgrep/discussions/3178
│      It would be awesome if ripgrep could output the search results in JSON
│  format, something like: { "search_query": "ipaddress", ...
│  ... 12 source lines hidden
│      https://github.com/eclipse-theia/theia/issues/2622
│      Moreover, the output isn't actually guaranteed to be UTF-8, and in that
│  case, it's pretty difficult to determine what exactly is a character.
└─     [q1#4]
```

Expanded uses a different, structured rendering:

```
│    REQUEST ───────────────────────────────────────────────────────────────────
│      queries=ripgrep json output format
│      limit=4
│
│    SUMMARY ───────────────────────────────────────────────────────────────────
│      phase=done
│      count=4
│      total=4
│
│    RESULTS ───────────────────────────────────────────────────────────────────
│      1. Stats output in JSON mode · BurntSushi ripgrep · Discussion #3178
│        url=https://github.com/BurntSushi/ripgrep/discussions/3178 ·
│        provenance=[q1#1]
│        It would be awesome if ripgrep could output the search results in JSON
│        format, something like: { "search_query": "ipaddress", ...
```

## Defects

| # | Defect | Convention |
|---|---|---|
| 48 | The collapsed body dumps the model-facing Markdown with a head and tail split, and continuation rows start at column 2, which breaks the indentation | C4 |
| 49 | The collapsed and the expanded bodies use two different renderings of the same data | — |
| 50 | The collapsed body ends with an orphan provenance token `[q1#4]` | — |
| 51 | A metadata row repeats the header query | C8 |
| 52 | The expanded body adds `REQUEST` and `SUMMARY`, and prints `url=` and `provenance=` as key-value pairs | C4, C8 |
| 53 | No summary row states the result count | C4 |

## Target design

### Header

```
● Web search ripgrep json output format                                   1.4s
```

The title is `Web search`. The target is the query. With several queries the
target is the first query followed by `+2 more`.

### Record layout

The records render only when the entry is expanded. The collapsed entry is
one row (C4) with the result counts inline:

```
● Web search ripgrep json output format 4 results for 1 query             1.4s
```

Each record uses two rows:

1. The rank, then the title, truncated with `…`.
2. The URL in the muted tone, without the scheme, elided in the middle so that
   the host and the last segment stay visible.

Expanded:

```
● Web search ripgrep json output format                                   1.4s
│    1  Stats output in JSON mode · BurntSushi ripgrep · Discussion #3178
│       github.com/BurntSushi/ripgrep/discussions/3178
│    2  Add json output format #930 · BurntSushi/ripgrep
│       github.com/BurntSushi/ripgrep/issues/930
│    3  Should I parse the json output now if I want to use ripgrep in rust?
│       github.com/BurntSushi/ripgrep/discussions/1592
└─   4 results for 1 query
```

The expanded record list keeps the policy line budget.

### Inline summary

| Case | Row |
|---|---|
| One query | `4 results for 1 query` |
| Several queries | `10 results merged from 3 queries` |
| Bounded | `4 of 22 results for 1 query` |
| Nothing found | `No results` |
| Partial query failure | `4 results · 1 query failed` with the `partial` qualifier |

### Expanded body

One `RESULTS` section with the same two-row records, plus a third muted row
per record with the snippet, bounded to two display rows. The `REQUEST` and
`SUMMARY` sections are removed.

The provenance token appears only when the call used more than one query, and
only in the expanded body, at the end of the URL row:

```
│    1  Stats output in JSON mode · BurntSushi ripgrep · Discussion #3178
│       github.com/BurntSushi/ripgrep/discussions/3178              [q1#1]
│       It would be awesome if ripgrep could output the search results in
│       JSON format, something like: { "search_query": "ipaddress", …
```

Request options that the header does not show — `limit`, `sites`, `country`,
`language`, `no_cache` — appear as one bounded muted row above the section,
and only when the model set them.

### Failure

```
● Web search ripgrep json output format Search provider returned 401     0.8s
```

| Cause | Row |
|---|---|
| Missing key | `No Jina key is configured` |
| Authentication | `Search provider returned 401` |
| Rate limit | `Search provider rate limit reached` |
| Timeout | `Search did not answer in time` |
| All queries failed | `All 3 queries failed` |
| Anything else | The first line of the provider message |

The provider body stays available in the expanded `ERROR` section. No key,
token, or authorization header ever appears in any row.

## Acceptance criteria

1. The header shows `●`, the title `Web search`, and the query as the target.
2. The record layout is the same wherever records render; the collapsed
   entry is one row.
3. Each record shows the rank, the title, and a scheme-less middle-elided URL.
4. The expanded record list keeps the policy line budget and contains no
   orphan provenance token.
5. The inline summary states the result count and the query count, and the
   `partial` qualifier is set when a query failed.
6. The expanded body has one `RESULTS` section, at most one request-option
   row, and no `REQUEST` or `SUMMARY` section.
7. No key-value pair is printed for `url` or `provenance`, and no credential
   ever appears.
8. The model-facing text is unchanged.
9. Every state is bounded at 39, 40, 63, 64, 80, 99, 100, and 120 columns in
   both bundled themes.

## Out of scope

- Changing the provider, the merge algorithm, or the model-facing text.
