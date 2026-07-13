---
name: zoom-out
description: >
  Map an unfamiliar code area at a higher level: modules, callers, data flow, ownership, and strategic context.
  Use when: user asks to zoom out, explain how an area fits together, map callers,
  understand a subsystem, or step back from low-level debugging.
  Do not use when: user asks for a specific edit, exact symbol lookup, or direct bug fix.
argument-hint: "[file, symbol, subsystem, or behavior]"
allowed-tools: [read, rg, fd, subagent]
---

# Zoom Out

Explain a code area one level above the current details.

User arguments: $ARGUMENTS

## Critical

Do not summarize individual lines. Build a map: purpose, boundaries, callers, dependencies, data flow, and where change pressure lands.

Use `rg` for exact symbols or strings, `fd` for path discovery, and read candidate files before drawing conclusions. For conceptual or behavioral discovery, delegate to an `explorer` subagent.

## Step 1: Resolve the Area

Identify the target from `$ARGUMENTS`:

- File or directory.
- Symbol or function.
- Feature behavior.
- Error path or subsystem.

If the target is broad, delegate to an `explorer` subagent, then read the most relevant files.

## Step 2: Trace the Shape

Collect evidence for:

- What the area is responsible for.
- What it deliberately does not own.
- Main entry points.
- Main outputs or side effects.
- Callers and downstream dependencies.
- Tests or scripts that exercise it.
- Naming/domain terms used by the project.

Delegate to `explorer` for broad read-only tracing when the area spans multiple files.

## Step 3: Produce the Map

Use this structure:

```markdown
Purpose:
<one paragraph>

Boundaries:
- Owns: <responsibilities>
- Does not own: <non-responsibilities>

Flow:
1. <entry>
2. <handoff>
3. <output>

Key files:
- `<path>` — <role>

Change implications:
- <what tends to break if this area changes>

Best next move:
<single recommendation>
```

Keep the map proportional to the code area. A small helper does not need an architecture essay.

## Step 4: Stop Before Implementation

If the user needs a fix after the map, recommend the next skill or workflow:

- `diagnose` for unexplained broken behavior.
- `tdd` for test-first implementation.
- `grill-with-docs` for plans that must be checked against docs.
- `code-review` for auditing a diff.
