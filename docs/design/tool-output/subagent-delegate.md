# `subagent_delegate`

**Family:** agent · **Scope:** parent only · **Owner:**
`src/subagents/tool.ts`, rendered by `src/subagents/display-adapter.ts`

**Status:** Implemented.

`subagent_delegate` and `subagent_resume` share one grammar. This document is
the reference; [subagent-resume.md](subagent-resume.md) records only the
differences.

## Evidence level

Rendered through the production adapter `decorateSubagentTool` at 80 columns,
with a complete v3 run record for each lifecycle state. The record is
synthetic, because a real child run needs a live parent session; every field
uses the real v3 shape that the tool emits.

## Current output

Call:

```
⠋ ◇ Subagent explorer                                                        0ms
│    mode=fg · context=2
│  Trace how the display runtime resolves the effective policy and report the
└─ exact files.
```

Completed, collapsed:

```
✓ ◇ Subagent explorer                                                      42.0s
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
│      input=18240
│      output=1310
│      cacheRead=12000
│      cacheWrite=0
└─     cost=0.0182
```

Completed, expanded activity:

```
│    ACTIVITY ──────────────────────────────────────────────────────────────────
│    rg  rg /resolvePolicy/ in src/display                             → running
│    rg:  working                                                         ✓ done
│    read  read src/display/policy.ts                                  → running
│    read:  working                                                       ✓ done
```

Failed, where the error text appears twice:

```
✗ ◇ Subagent explorer                                                      42.0s
│    id=12345678 · mode=fg · phase=error · …
│    Child model returned no auth
│    …
└─   Child model returned no auth
```

## Defects

| # | Defect | Convention |
|---|---|---|
| 99 | The metadata row prints six key-value fields and wraps to two rows | C4 |
| 100 | Each tool call produces two `ACTIVITY` rows, and one of them is malformed: the tool name is parsed as `read:` with a colon and the summary degrades to the literal word `working` | — |
| 101 | `ACTIVITY` uses a `→ running` arrow, which is a second lifecycle vocabulary | C5 |
| 102 | A failure renders the error text twice | C8 |
| 103 | `USAGE` prints six key-value rows, and the collected `toolErrors` are never shown | C4 |
| 104 | The collapsed body mixes the result preview with activity rows and keeps the raw `# Findings` marker, while the expanded body strips it | C4 |

Defect 100 is a parsing defect, not a layout defect: the end-phase timeline
entry `read: ok` is split on whitespace, so the tool identity keeps its colon
and the remaining text is not a call summary.

## Target design

The subagent result is the deliverable, so a bounded result preview stays in
the collapsed body. This is an explicit C4 exception.

### Call

```
● Subagent explorer                                                       0.0s
│    Trace how the display runtime resolves the effective policy and report…
└─   fg · 2 context messages
```

The target is the agent name. The task preview keeps one row. The second row
states the delivery mode and the context count in words. Custom system text is
never rendered, and this rule does not change.

### Collapsed result

A bounded result preview, then one summary row.

```
● Subagent explorer                                                      42.0s
│    Findings
│    The runtime resolves policy in src/display/policy.ts.
│    - package defaults
│    - agent layer
│    - project layer
└─   done · 6 turns · 31.5k tokens · $0.018 · run 12345678
```

Rules:

1. The preview uses the same Markdown normalization as the expanded body, so
   `# Findings` never appears in one state and `Findings` in the other.
2. Activity rows never appear in the collapsed body.
3. The summary row states the phase, the turns, the total tokens, the cost,
   and the short run ID. The full run ID is never rendered.

Summary row cases:

| Case | Row |
|---|---|
| Completed | `done · 6 turns · 31.5k tokens · $0.018 · run 12345678` |
| Running | `running · 3 turns so far · run 12345678` |
| Queued in background | `queued · run 12345678` |
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
   completed, `×` failed. The `→ running` arrow is removed. A tool that the
   shared allowlisted formatter does not know shows only `called`. No tool
   result payload is ever rendered.

4. `USAGE` — one row, not six fields:

   ```
   │    6 turns · 18.2k in · 1.3k out · 12.0k cached · $0.018
   ```

One muted row above `TASK` states the run identity that the summary row does
not carry: the mode, the model, and the effort.

### Failure

The error text appears exactly once, as the `RESULT` section content and the
collapsed preview, never twice. Collected `toolErrors` appear as a bounded
muted row below `ACTIVITY`.

### Privacy

Unchanged and non-negotiable: no prompt snapshot, no custom system text, no
raw session data, no artifact path, and no full run ID in any state.

## Acceptance criteria

1. The header shows `●`, the title `Subagent`, and the agent name as the
   target.
2. The collapsed body contains a normalized result preview and exactly one
   summary row, and no activity rows.
3. Markdown normalization is identical in the collapsed and the expanded
   bodies.
4. `ACTIVITY` renders exactly one row per tool call, with the lifecycle glyph
   and no `→ running` arrow, and no malformed `tool:` identity.
5. `USAGE` is one row.
6. A failure renders its message exactly once, and tool errors are visible.
7. No prompt, system text, session data, artifact path, or full run ID is
   rendered.
8. The model-facing result is unchanged.
9. Every state is bounded at 39, 40, 63, 64, 80, 99, 100, and 120 columns in
   both bundled themes.

## Out of scope

- The `/subagent` manager and the background completion message, which keep
  their own accepted designs and already share this description builder.
