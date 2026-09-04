# `resume_subagent`

**Family:** agent · **Scope:** parent only · **Owner:**
`src/subagents/tool.ts`, rendered by `src/subagents/display-adapter.ts`

**Status:** Implemented.

Uses the grammar of [subagent-delegate.md](subagent-delegate.md). This
document records only what differs. `resume_subagent` is background-only like
`delegate_subagent`: it validates the persisted record and the effective
activity lease, queues the continuation in the session-owned background
lifecycle, and immediately returns the same public ID and the queued state.

## Current output

Call:

```
● Resume subagent 12345678                                          0.0s
└─ Continue: also report the provenance fields.
```

Queued result, collapsed:

```
– Resume subagent 12345678   Queued in the parent session           0.0s
```

## Target design

### Header

```
– Resume 12345678             Queued in the parent session          0.0s
```

The title is `Resume`. The target is the short run ID, and it is **identical**
in the call and in the queued result, so the entry never changes identity when
the result replaces the pending call.

### Call

```
● Resume 12345678 frozen model and effort                            0.0s
```

The inline summary states that a resumed run keeps the original frozen model
and effort values, because that is the fact a user most often needs when they
compare a resume with a fresh delegation. The follow-up task text renders
only when the entry is expanded.

### Queued result

Identical to [subagent-delegate.md](subagent-delegate.md), with the resume
target: one row that states the queued state and the same public ID that the
call named.

### Completed result

Rendered through the background completion message, identical to
[subagent-delegate.md](subagent-delegate.md), with one addition in the inline
summary: a resumed run states the cumulative turn count and marks it as
cumulative.

| Case | Row |
|---|---|
| Completed | `done · 9 turns total · 48.2k tokens · $0.031 · run 12345678` |
| Queued in background | `Queued in the parent session` |
| Active lease conflict | `Run 12345678 is already active` |
| Unknown run | `Unknown run 12345678` |
| Not resumable | `Run 12345678 has no resumable artifacts` |

The retryable `SUBAGENT_ACTIVE` error keeps its exact tool-error contract; only
its rendered sentence changes. The lease and history rejections happen before
anything is queued, so the tool call itself carries the structured error.

## Acceptance criteria

1. The header target is identical in the call and in the queued result.
2. The title is `Resume` and the target carries the short run ID.
3. The inline summary states cumulative turns for a resumed run.
4. An active-lease conflict renders one sentence and the failed state, and the
   underlying tool-error contract is unchanged.
5. All acceptance criteria of [subagent-delegate.md](subagent-delegate.md)
   apply.
6. Every state is bounded at 39, 40, 63, 64, 80, 99, 100, and 120 columns in
   both bundled themes.

## Out of scope

- Any change to resume eligibility, the activity lease, or artifact retention.
