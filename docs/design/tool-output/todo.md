# `todo`

**Family:** workflow · **Scope:** parent only · **Owner:**
`src/todo/index.ts`, rendered by `src/display/workflow-adapters.ts`

**Status:** Implemented.

## Current output

Setting a three-item list. The collapsed body is twelve rows of metadata and
contains no task text:

```
✓ ◆ Tasks set                                                                2ms
│    status=ok · action=set · changed=true
│    total 3 · pending 2 · inProgress 1 · completed 0
│    ACTION ────────────────────────────────────────────────────────────────────
│      action=set
│      changed=true
│
│    SUMMARY ───────────────────────────────────────────────────────────────────
│      total=3
│      pending=2
│      inProgress=1
│      completed=0
│      current=todo-1
│      title=Tool output redesign
│
│    PERSISTENCE ───────────────────────────────────────────────────────────────
│      stateVersion=2
└─     widget=unavailable
```

Expanded adds the tasks:

```
│    TASKS ─────────────────────────────────────────────────────────────────────
│      ◆ 1. Render current output for every tool
│        id=todo-1 · status=in_progress · current=yes
│
│      ○ 2. Write the per-tool design document
│        id=todo-2 · status=pending
```

An unknown ID appends the raw JSON body after the sections:

```
│    PERSISTENCE ───────────────────────────────────────────────────────────────
│      stateVersion=2
│      widget=unavailable
│      error=TODO_UNKNOWN_ID
│    {
│      "version": 1,
│      "status": "error",
```

## Defects

| # | Defect | Convention |
|---|---|---|
| 87 | The collapsed body is twelve metadata rows and shows no task text and no progress sentence | C4 |
| 88 | The metadata row, the `ACTION` section, and the `SUMMARY` section repeat the same values | C8 |
| 89 | The `PERSISTENCE` section exposes internals: `stateVersion`, `widget=unavailable`, and the error code | C4 |
| 90 | A failure appends the raw JSON body below the sections | C4, C6 |
| 91 | Each expanded task carries `id=`, `status=`, and `current=`, which repeat the leading glyph | C8 |

## Target design

### Header

```
● Tasks set                                                                2ms
```

The title is `Tasks`. The target is the action word: `set`, `add`, `update`,
`start`, `pause`, `check`, `uncheck`, `clear`, or `list`.

### Collapsed entry

One row (C4). The inline summary states the list title, the progress, and
the current task. The task list stays in the expanded body, because the
read-only widget above the editor already shows the live list; the transcript
row records what this call changed.

```
● Tasks set Tool output redesign · 1 of 3 done · now: Render current ou…   2ms
```

| Case | Row |
|---|---|
| List with a current item | `<title> · 1 of 3 done · now: <current text>` |
| No current item | `<title> · 1 of 3 done · paused` |
| No title | `1 of 3 done · now: <current text>` |
| Cleared | `List cleared` |
| No change | `No change` |
| Failure | one sentence, see below |

The current task text is truncated with `…`.

### Expanded body

One `TASKS` section. Each task uses one row: the state glyph, the index, and
the text. The glyphs reuse the lifecycle vocabulary of
[00-visual-vocabulary.md](00-visual-vocabulary.md): `○` pending, `●` in
progress, `✓` completed. The `id=`, `status=`, and `current=` fields are
removed, because the glyph already states them.

```
● Tasks set                                                                2ms
│    ✓  1  Render current output for every tool
│    ●  2  Write the per-tool design document
│    ○  3  Update the shared conventions
└─   Tool output redesign · 1 of 3 done · now: Write the per-tool design doc…
```

The explicit task ID appears only when the model supplied a custom ID, in the
muted tone at the end of the row. The `ACTION`, `SUMMARY`, and `PERSISTENCE`
sections are removed.

A failed widget synchronization is a display degradation, not a task fact. It
is reported once as a muted row, `Task widget unavailable`, and only when it
happens.

### Failure

```
● Tasks check                                                              0ms
└─   Unknown task id does-not-exist
```

| Cause | Row |
|---|---|
| Unknown ID | `Unknown task id <id>` |
| Duplicate ID | `Task id <id> already exists` |
| Empty list | `No task list exists` |
| Too many items | `A list holds at most 20 items` |
| Persistence failure | `Task list could not be saved` |

The raw JSON body and the internal error code are never rendered. They stay in
the model-facing result and in the expanded `ERROR` section.

## Acceptance criteria

1. The header shows `●`, the title `Tasks`, and the action as the target.
2. The collapsed entry is exactly one row whose inline summary names the
   list and the current task.
3. The expanded `TASKS` section uses one row per task with the `○`, `●`, `✓`
   glyphs and no `id=`, `status=`, or `current=` fields.
4. No `ACTION`, `SUMMARY`, or `PERSISTENCE` section exists, and no internal
   state version or widget state is rendered.
5. A failure renders one sentence and no raw JSON.
6. The model-facing JSON v2 snapshot is unchanged.
7. Every state is bounded at 39, 40, 63, 64, 80, 99, 100, and 120 columns in
   both bundled themes.

## Out of scope

- Any change to the persisted state contract or the above-editor widget.
