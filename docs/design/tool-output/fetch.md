# `fetch`

**Family:** remote · **Scope:** parent and child · **Owner:**
`src/web/tools/fetch.ts`, rendered by `src/display/remote-adapters.ts`

**Status:** Proposed. Not implemented.

`fetch` uses the remote-record grammar of [search.md](search.md). This
document records only what differs.

## Current output

```
⠋ ⌬ Web fetch https://example.com/                                           1ms
└─   urls=https://example.com/ · maxTokens=800

✓ ⌬ Web fetch https://example.com/                                           1ms
│    phase=done · urls=https://example.com/ · maxTokens=800
│  ## Example Domain
│  URL: https://example.com/
│  Usage: 29 tokens
│
│  This domain is for use in documentation examples without needing permission.
│  Avoid use in operations.
│
└─ [Learn more](https://iana.org/domains/example)
```

Expanded:

```
│    RESULTS ───────────────────────────────────────────────────────────────────
│      1. Example Domain
│        url=https://example.com/ · lines=3 · tokens=29 · usage=29 tokens ·
└─       retried=yes
```

## Defects

The remote-record defects 48 to 53 of [search.md](search.md) apply. In
addition:

| # | Defect | Convention |
|---|---|---|
| 54 | The collapsed body renders the reader's own header block, `URL:` and `Usage:`, as page content | — |
| 55 | Raw Markdown link syntax `[Learn more](https://iana.org/…)` is rendered | — |
| 56 | The record row prints `tokens=29` and `usage=29 tokens`, which state the same value twice, plus the internal `retried=yes` | C8 |

## Target design

### Header

```
● Web fetch example.com                                                   1.2s
```

The target is the URL without the scheme, elided in the middle. With several
URLs the target is the first host followed by `+2 more`.

### Collapsed body

One record per URL, two rows, in the layout of [search.md](search.md):

```
● Web fetch example.com                                                   1.2s
│    1  Example Domain
│       example.com · 3 lines · 29 tokens
└─   1 page fetched
```

A failed URL keeps its record and states the reason on the second row in the
warning tone:

```
│    2  Not fetched
│       example.com/missing · 404
```

### Summary row

| Case | Row |
|---|---|
| One page | `1 page fetched` |
| Several pages | `3 pages fetched` |
| Mixed | `2 of 3 pages fetched` with the `partial` qualifier |
| All failed | `No page fetched` |
| Bounded content | `1 page fetched · content truncated` with the `truncated` badge |

### Expanded body

The same records, plus one `CONTENT` section for each successful URL with the
sanitized page text bounded by the policy. Sanitization removes the reader's
`URL:` and `Usage:` header block and converts Markdown link syntax to the link
text followed by the muted host. The `REQUEST` and `SUMMARY` sections are
removed, and `retried` is never rendered.

## Acceptance criteria

1. The header target is the scheme-less URL.
2. Each URL produces one two-row record; a failed URL states its reason in the
   warning tone.
3. The collapsed body contains no page content and no reader header block.
4. The expanded `CONTENT` section contains no `URL:` or `Usage:` row and no
   raw Markdown link syntax.
5. `tokens`, `usage`, and `retried` are never printed as key-value pairs, and
   the token count appears once.
6. The summary row states the fetched and requested page counts, and sets the
   `partial` or `truncated` qualifier when applicable.
7. The model-facing text is unchanged.
8. Every state is bounded at 39, 40, 63, 64, 80, 99, 100, and 120 columns in
   both bundled themes.

## Out of scope

- Rendering images or executing page scripts.
- Changing the reader mode contract.
