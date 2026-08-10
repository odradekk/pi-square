# `subagent_resume`

**Family:** agent · **Scope:** parent only · **Owner:**
`src/subagents/tool.ts`, rendered by `src/subagents/display-adapter.ts`

**Status:** Implemented.

Uses the grammar of [subagent-delegate.md](subagent-delegate.md). This
document records only what differs.

## Current output

Call:

```
⠋ ◇ Resume subagent 12345678                                                 0ms
└─ Continue: also report the provenance fields.
```

Result, collapsed:

```
✓ ◇ Resume subagent explorer                                               42.0s
│    id=12345678 · mode=fg · phase=done · model=cpa/deepseek-v4-flash ·
│    effort=xhigh · turns=6
│    # Findings
│    read src/display/policy.ts
│
│    ACTIVITY ──────────────────────────────────────────────────────────────────
│    read:  working                                                       ✓ done
│
│    USAGE ─────────────────────────────────────────────────────────────────────
│      turns=6
│      …
```

## Defects

Every defect of [subagent-delegate.md](subagent-delegate.md), 99 to 104,
applies unchanged. In addition:

| # | Defect | Convention |
|---|---|---|
| 105 | The target changes between the call and the result: the call shows the short run ID, the result shows the agent name. The same transcript entry therefore changes identity when it completes | C5 |

The result must visually replace the pending call, so the identity in the
header must not move.

## Target design

### Header

```
● Resume explorer 12345678                                               42.0s
```

The title is `Resume`. The target is the agent name followed by the short run
ID, and it is **identical** in the call and in the result. The agent name is
known at call time from the persisted record; when the record cannot be read
before execution, the target is the short run ID alone and stays that way for
the whole entry.

### Call

```
● Resume explorer 12345678                                                0.0s
│    Continue: also report the provenance fields.
└─   frozen model and effort
```

The second row states that a resumed run keeps the original frozen model and
effort values, because that is the fact a user most often needs when they
compare a resume with a fresh delegation.

### Result

Identical to [subagent-delegate.md](subagent-delegate.md), with one addition
in the summary row: a resumed run states the cumulative turn count and marks
it as cumulative.

| Case | Row |
|---|---|
| Completed | `done · 9 turns total · 48.2k tokens · $0.031 · run 12345678` |
| Active lease conflict | `Run 12345678 is already active` |
| Unknown run | `Unknown run 12345678` |
| Not resumable | `Run 12345678 has no resumable artifacts` |

The retryable `SUBAGENT_ACTIVE` error keeps its exact tool-error contract; only
its rendered sentence changes.

## Acceptance criteria

1. The header target is identical in the call and in the result.
2. The title is `Resume` and the target carries the agent name and the short
   run ID.
3. The summary row states cumulative turns for a resumed run.
4. An active-lease conflict renders one sentence and the failed state, and the
   underlying tool-error contract is unchanged.
5. All acceptance criteria of [subagent-delegate.md](subagent-delegate.md)
   apply.
6. Every state is bounded at 39, 40, 63, 64, 80, 99, 100, and 120 columns in
   both bundled themes.

## Out of scope

- Any change to resume eligibility, the activity lease, or artifact retention.
