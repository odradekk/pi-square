# `delegate_subagent`

**Family:** agent · **Scope:** parent only · **Owner:**
`src/subagents/tool.ts`, rendered by `src/subagents/display-adapter.ts`

**Status:** Implemented.

`delegate_subagent` and `resume_subagent` share one grammar. This document is
the reference; [subagent-resume.md](subagent-resume.md) records only the
differences. Both tools are background-only: the tool call queues the child in
the session-owned background lifecycle and returns immediately with the public
ID and the queued state, and the finished result arrives as a background
completion message.

## Evidence level

Rendered through the production adapter `decorateSubagentTool` at 80 columns,
with a complete v3 run record for each lifecycle state. The record is
synthetic, because a real child run needs a live parent session; every field
uses the real v3 shape that the tool emits.

## Current output

Call:

```
● Subagent explorer                                                0.0s
│    Trace how the display runtime resolves the effective policy and report the
└─ exact files.
```

Queued result, collapsed (the immediate tool outcome):

```
– Subagent explorer           Queued in the parent session            0.0s
```

Completed background completion, collapsed:

```
✓ Subagent explorer done · 6 turns · 31.5k tokens · $0.018 · run 12345678 42.0s
```

## Target design

The subagent entry follows C4: the collapsed entry is one row with the
outcome inline, and the result preview renders only when the entry is
expanded.

### Call

```
● Subagent explorer 2 context messages                                0.0s
```

The target is the agent name. The inline summary states the context count in
words; the task text renders only when the entry is expanded. System text is
never rendered, and this rule does not change.

### Queued result

One row (C4). The immediate result of a delegation call states the queued
state and identifies the run:

```
– Subagent explorer           Queued in the parent session            0.0s
```

A generic run without a named agent shows the short run ID as the target.
Rules:

1. The queued row never implies completion.
2. The full run ID is never rendered.

### Completed result

The completed run renders through the background completion message, which
reuses this description builder inside Pi's native success/error shell. The
inline summary states the phase, the turns, the total tokens, the cost, and
the short run ID:

```
✓ Subagent explorer done · 6 turns · 31.5k tokens · $0.018 · run 12345678 42.0s
```

The normalized result preview renders only when the entry is expanded.

Rules:

1. The preview uses the same Markdown normalization as the expanded body, so
   `# Findings` never appears in one state and `Findings` in the other.
2. Activity rows never appear in the collapsed entry.
3. The full run ID is never rendered.

Inline summary cases:

| Case | Row |
|---|---|
| Completed | `done · 6 turns · 31.5k tokens · $0.018 · run 12345678` |
| Queued in background | `Queued in the parent session` |
| Failed | `error · 6 turns · run 12345678` |
| Aborted | `aborted · run 12345678` |
| Tool errors present | adds `· 1 tool error` and the `warning` qualifier |

### Expanded result

Four sections, in this order.

1. `TASK` — the delegated task text.
2. `RESULT` — the full normalized result, bounded by the policy.
3. `ACTIVITY` — **one row per tool call**, built from the start entry and
   completed by the end entry:

   ```
   │    ACTIVITY ──────────────────────────────────────────────────────────
   │    ✓  rg /resolvePolicy/ in src/display
   │    ✓  read src/display/policy.ts
   │    ×  read src/display (EISDIR)
   ```

   The leading glyph reuses the lifecycle vocabulary: `●` running, `✓`
   completed, `×` failed. A tool that the shared allowlisted formatter does
   not know shows only `called`. No tool result payload is ever rendered.

4. `USAGE` — one row, not six fields:

   ```
   │    6 turns · 18.2k in · 1.3k out · 12.0k cached · $0.018
   ```

One muted row above `TASK` states the run identity that the inline summary
does not carry: the run kind, the model, and the effort. An expanded queued
result states `Queued in the parent session` as a muted row instead of a
result preview.

### Failure

The error text appears exactly once, as the `RESULT` section content and the
inline failure sentence, never twice. Collected `toolErrors` appear as a
bounded muted row below `ACTIVITY`.

### Privacy

Unchanged and non-negotiable: no prompt snapshot, no custom system text, no
raw session data, no artifact path, and no full run ID in any state.

## Acceptance criteria

1. The header shows `–` for the queued result, the title `Subagent`, and the
   agent name (or short run ID) as the target.
2. The collapsed entry is exactly one row with the outcome inline, and no
   activity rows; the normalized result preview renders only when the entry
   is expanded.
3. Markdown normalization is identical in the collapsed and the expanded
   bodies.
4. `ACTIVITY` renders exactly one row per tool call, with the lifecycle glyph
   and no malformed `tool:` identity.
5. `USAGE` is one row.
6. A failure renders its message exactly once, and tool errors are visible.
7. No prompt, system text, session data, artifact path, or full run ID is
   rendered.
8. The model-facing result is unchanged: the queued ID text plus the queued
   run record.
9. Every state is bounded at 39, 40, 63, 64, 80, 99, 100, and 120 columns in
   both bundled themes.

## Out of scope

- The `/subagent` manager and the background completion message shell, which
  keep their own accepted designs and already share this description builder.
