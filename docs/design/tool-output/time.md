# `time`

**Family:** workflow · **Scope:** parent only · **Owner:**
`src/time/index.ts`, rendered by `src/display/workflow-adapters.ts`

**Status:** Implemented.

## Current output

```
⠋ ◆ Local time                                                               1ms

✓ ◆ Local time                                                               1ms
│  2026-08-09 14:42:36
│  ISO 8601: 2026-08-09T14:42:36+08:00
└─ Timezone: Asia/Shanghai (UTC+08:00)

✓ ◆ Local time                                                               0ms
│    LOCAL ─────────────────────────────────────────────────────────────────────
│      time=2026-08-09 14:42:36
│      iso=2026-08-09T14:42:36+08:00
└─     timezone=Asia/Shanghai (UTC+08:00)
```

## Defects

| # | Defect | Convention |
|---|---|---|
| 92 | The collapsed body dumps the three-line model text, and the expanded body restates the same three values as `time=`, `iso=`, and `timezone=` key-value pairs | C4, C8 |
| 93 | The result takes three rows for one fact that fits on one row | C4 |

`time` is the smallest tool in the catalog. Its current output is not wrong; it
is simply larger than the fact it states.

## Target design

### Header

```
● Local time                                                               1ms
```

The title is `Local time`. There is no target, because the tool takes no
argument.

### Collapsed entry

One row (C4). The inline summary carries the local time and the zone.

```
● Local time 2026-08-09 14:42:36 · Asia/Shanghai (UTC+08:00)              1ms
```

### Expanded body

The same summary, plus one muted row with the ISO 8601 value, because that is
the form a user copies into code:

```
● Local time                                                               1ms
│    2026-08-09T14:42:36+08:00
└─   2026-08-09 14:42:36 · Asia/Shanghai (UTC+08:00)
```

No section rule and no key-value pair is used, in line with convention C9. The
tool returns four values and three of them fit in these two rows; the fourth,
the IANA zone name, is already inside the zone token.

### Failure

`time` reads the host clock and has no failure path of its own. If the runtime
raises, the failure follows the shared rule: one sentence, with the platform
text in the expanded `ERROR` section.

## Acceptance criteria

1. The header shows `●` and the title `Local time`, with no target.
2. The collapsed entry is exactly one row whose inline summary carries the
   local time and the zone.
3. The expanded body adds exactly one muted ISO row.
4. No section rule and no key-value pair is rendered.
5. The model-facing text is unchanged.
6. Every state is bounded at 39, 40, 63, 64, 80, 99, 100, and 120 columns in
   both bundled themes.

## Out of scope

- Time zone conversion, formatting options, or any clock other than the host
  clock.
