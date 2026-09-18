# `library_docs`

**Family:** remote · **Scope:** parent and child · **Owner:**
`src/web/tools/library-docs.ts`, rendered by `src/display/remote-adapters.ts`

**Status:** Implemented.

`library_docs` uses the remote-record grammar of [web-search.md](web-search.md). This document
records only what differs.

## Current output

```
⠋ ⌬ Library docs /burntsushi/ripgrep                                        1ms
└─   library=/burntsushi/ripgrep · query=json output format · maxTokens=800

✓ ⌬ Library docs /burntsushi/ripgrep                                        1ms
│    status=ready · phase=done · library=/burntsushi/ripgrep · query=json output
│    format · maxTokens=800
│  ### SubMatch serialization: each submatch has 'match', 'start', 'end' fields
│
│  ... 83 source lines hidden
│  Source:
│  https://github.com/burntsushi/ripgrep/blob/master/crates/printer/src/json.rs
│
└─ > Context7 omissions: 2 snippets omitted
```

Expanded:

```
│    SUMMARY ───────────────────────────────────────────────────────────────────
│      status=ready
│      phase=done
│      code=3/3
│      info=0/2
│      omitted=2
│      tokens=770/800
│      kind=all
│
│    CODE ──────────────────────────────────────────────────────────────────────
│      SubMatch serialization: each submatch has 'match', 'start', 'end' fields
│        source=https://github.com/burntsushi/ripgrep/blob/master/crates/printer
│        /src/jsont.rs · page=Ripgrep: ripgrep --json format line text and match
│        submatches fields; interaction with --only-matching · language=rust ·
│        tokens=277
```

## Defects

The remote-record defects 48 to 53 of [web-search.md](web-search.md) apply. In
addition:

| # | Defect | Convention |
|---|---|---|
| 61 | The `SUMMARY` section uses coded fields, `code=3/3`, `info=0/2`, `tokens=770/800`, `kind=all`, which do not state their meaning | C6 |
| 62 | One snippet record prints `source`, `page`, `language`, and `tokens` as key-value pairs and occupies three or four rows | C4 |
| 63 | The collapsed body ends with the raw block-quote syntax `> Context7 omissions: 2 snippets omitted` | — |

## Target design

### Header

```
● Library docs /burntsushi/ripgrep                                       2.3s
```

The target is the library ID. The query belongs to the expanded option row.

### Record layout

The collapsed entry is one row (C4) with the snippet counts inline. The
records render only when the entry is expanded, two rows per snippet:

```
● Library docs /burntsushi/ripgrep 3 code snippets · 770 of 800 tokens…   2.3s
```

Expanded:

```
● Library docs /burntsushi/ripgrep                                       2.3s
│    1  SubMatch serialization: each submatch has 'match', 'start', 'end'…
│       rust · 277 tokens
│    2  JSON line format for match events
│       rust · 240 tokens
│    3  Interaction between --json and --only-matching
│       text · 253 tokens
└─   3 code snippets · 770 of 800 tokens · 2 omitted
```

Each record uses two rows:

1. The rank and the snippet title, truncated with `…`.
2. The language and the token count in the muted tone.

### Inline summary

The coded fields become one sentence.

| Case | Row |
|---|---|
| Code only | `3 code snippets · 770 of 800 tokens` |
| Mixed kinds | `3 code and 2 info snippets · 770 of 800 tokens` |
| With omissions | `3 code snippets · 770 of 800 tokens · 2 omitted` |
| Budget reached | adds the `truncated` badge |
| Nothing found | `No documentation for this query` |

`status`, `phase`, and `kind` are never rendered. The requested `kind` appears
in the expanded option row only when it is not the default.

### Expanded body

One `SNIPPETS` section with the same two-row records, plus a third muted row
per record with the source location: the repository-relative file path, elided
in the middle, without the scheme and the host. The full page title and the
absolute URL are not rendered; the model already has them.

One muted option row above the section states the query and any non-default
`kind` or `max_tokens`.

### Failure

The failure rows of [library-search.md](library-search.md) apply, plus:

| Cause | Row |
|---|---|
| Unknown library ID | `Unknown library /foo/bar` |

## Acceptance criteria

1. The header target is the library ID.
2. Each snippet uses two rows when expanded, with the title, the language,
   and the token count.
3. The inline summary states the snippet counts and the token budget in words,
   and sets the `truncated` badge when the budget was reached.
4. `status`, `phase`, `kind`, `code=`, `info=`, and `tokens=` never appear as
   coded key-value pairs.
5. No absolute source URL and no full page title is rendered.
6. No block-quote syntax appears in any row.
7. The model-facing text is unchanged.
8. Every state is bounded at 39, 40, 63, 64, 80, 99, 100, and 120 columns in
   both bundled themes.

## Out of scope

- Syntax highlighting of documentation snippets.
- Changing the Context7 selection or the token budget contract.
