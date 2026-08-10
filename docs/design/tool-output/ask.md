# `ask`

**Family:** workflow · **Scope:** parent only · **Owner:**
`src/ask-user/index.ts`, rendered by `src/display/workflow-adapters.ts`

**Status:** Implemented.

The interactive wizard itself is **not** part of this document. It is a
separate full-screen workflow surface with its own accepted design. This
document covers only the transcript entry that the wizard leaves behind.

## Current output

```
⠋ ◆ Questions [needs input]                                                  1ms
└─   questions=2

✓ ◆ Questions                                                                1ms
│    phase=done · questions=2 · answered=2 · skipped=0
│    Completed
│    REQUEST ───────────────────────────────────────────────────────────────────
│      phase=done
│      questions=2
│      answered=2
└─     skipped=0
```

Expanded:

```
│      Which document layout should the redesign use?
│        selected=One document per tool
│
│      Which families are in scope?
│        selected=filesystem, search
└─       both families first
```

Cancelled:

```
× ◆ Questions                                                                0ms
│    phase=cancelled · questions=2 · answered=0 · skipped=0
│    REQUEST ───────────────────────────────────────────────────────────────────
│      phase=cancelled
│      questions=2
│      answered=0
└─     skipped=0
```

A failure appends the raw JSON body below an `ERROR` section that already
states the same message.

## Defects

| # | Defect | Convention |
|---|---|---|
| 94 | The metadata row, the lone word `Completed`, and the `REQUEST` section state the same four values three times | C8 |
| 95 | The collapsed body states no outcome sentence and no answer information | C4 |
| 96 | A cancelled call states `phase=cancelled` only as a key-value pair | C6 |
| 97 | A failure renders the raw JSON body in addition to the `ERROR` section | C4, C6 |
| 98 | An answer prints `selected=` as a key-value pair, and a comment row carries no label, so it reads as part of the selection | C4 |

## Target design

### Call

```
● Questions 2 questions                                       [needs input]
```

The target is the question count only. The wizard call must never expose
question or option text, and this rule does not change. The `needs-input`
badge stays for the whole time the wizard is open.

### Collapsed result

One outcome row.

| Case | Row |
|---|---|
| All answered | `2 answered` |
| Mixed | `1 answered · 1 skipped` |
| Cancelled | `Cancelled` |
| No terminal | `An interactive terminal is required` |
| Invalid input | `Invalid question set` |

```
● Questions 2 questions                                                   4.2s
└─   2 answered
```

### Expanded result

The answers render as plain rows with **no section rule and no separator**.
Each question uses one row with the question text, then one indented row with
the selected labels joined by `, `. An optional comment uses a third muted
row with the `note:` label.

```
● Questions 2 questions                                                   4.2s
│    Which document layout should the redesign use?
│      One document per tool
│    Which families are in scope?
│      filesystem, search
│      note: both families first
└─   2 answered
```

This follows convention C9: the expanded body holds one kind of content, so no
section rule is drawn. Each question text already leads its own group.

A skipped question shows the muted word `skipped` instead of the label list.
The `REQUEST` section is removed; its four counters are already in the outcome
row.

### Failure

One sentence, with the raw JSON body and the internal code kept out of every
row. The platform message stays in the expanded `ERROR` section, which appears
exactly once.

## Acceptance criteria

1. The call target is the question count, and no question or option text is
   rendered before submission.
2. The `needs-input` badge is present while the wizard is open.
3. The collapsed result is exactly one outcome row.
4. The expanded body renders no section rule and no separator, uses no
   `selected=` key-value pair, and labels a comment with `note:`.
5. A cancelled call renders the aborted marker and the row `Cancelled`.
6. A failure renders one sentence, one `ERROR` section, and no raw JSON.
7. The model-facing JSON v1 answer payload is unchanged.
8. Every state is bounded at 39, 40, 63, 64, 80, 99, 100, and 120 columns in
   both bundled themes.

## Out of scope

- The interactive wizard layout, its navigation, and its review step.
