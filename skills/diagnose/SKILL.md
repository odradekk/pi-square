---
name: diagnose
description: >
  Run a disciplined diagnosis loop for hard bugs and performance regressions:
  reproduce, minimise, hypothesise, instrument, fix, and regression-test.
  Use when: user says diagnose/debug, reports broken behavior, failing tests,
  thrown errors, flaky behavior, or performance regression.
  Do not use when: user already asks for a specific small edit with a known cause.
argument-hint: "[bug report, failing command, symptom, or performance regression]"
allowed-tools: [bash, read, write, edit, rg, fd, ask, subagent]
---

# Diagnose

Run a disciplined diagnosis loop for hard bugs and performance regressions.

User arguments: $ARGUMENTS

## Critical

Build a fast, deterministic feedback loop before fixing. If no loop can be built, stop and state exactly what evidence is missing. Do not proceed on an untested hypothesis.

Use the repository retrieval discipline: `rg` for exact strings and symbols, `fd` for known paths, direct reads for relevant files, and subagents for non-trivial investigation.

## Phase 1: Build a Feedback Loop

Create an agent-runnable pass/fail signal that reproduces the user's symptom.

Preferred loop types, in order:

1. Failing test at the seam that reaches the bug.
2. CLI command or script with fixture input and expected output.
3. HTTP request against a local dev server.
4. Headless browser script for UI behavior.
5. Replay of a captured trace, payload, log, or fixture.
6. Throwaway harness that exercises the code path directly.
7. Property, fuzz, stress, or repeated-run loop for intermittent bugs.
8. Bisection harness for regressions between commits, data versions, or configs.
9. Human-in-the-loop script copied from `${PI_SKILL_DIR}/scripts/hitl-loop.template.sh` when manual interaction is unavoidable.

Improve the loop until it is sharp enough: faster, more deterministic, and asserting the specific failure rather than a nearby crash.

## Phase 2: Reproduce

Run the loop and confirm the observed failure matches the user's report.

Check:

- The failure mode is the same bug, not an adjacent failure.
- The failure reproduces consistently enough to debug.
- The exact symptom is captured: error text, wrong output, timing, or UI state.

Do not modify production code before this phase succeeds unless the only task is to add instrumentation.

## Phase 3: Hypothesise

Produce 3–5 ranked, falsifiable hypotheses before testing any one of them.

Use this format:

```text
If <cause> is true, then <probe/change> should <observable prediction>.
```

Discard hypotheses that cannot make a prediction. If domain knowledge from the user could materially reorder the list, ask once; otherwise proceed with the highest-value probe.

## Phase 4: Instrument

Probe one hypothesis at a time.

Prefer:

1. Debugger or REPL inspection when available.
2. Targeted logs at boundaries that distinguish hypotheses.
3. Focused assertions or counters inside the reproduction loop.

Tag temporary instrumentation with a unique prefix such as `[DEBUG-a4f2]`. Remove all tagged instrumentation before declaring completion.

For performance regressions, establish a baseline measurement first. Use timing harnesses, profilers, query plans, or repeated measurements; do not guess from code shape alone.

## Phase 5: Fix and Regression-Test

Write a regression test before the fix when a correct seam exists.

A correct seam exercises the real bug pattern as it occurs for the caller. If the only available seam is too shallow, state that limitation and prefer an integration-style test or original feedback loop.

Execution order:

1. Turn the minimized reproduction into a failing test or script.
2. Observe the failure.
3. Apply the smallest fix that addresses the proven cause.
4. Observe the test pass.
5. Re-run the original feedback loop.

## Phase 6: Cleanup and Report

Before reporting completion:

- Re-run the original reproduction loop.
- Run the regression test or explain why no correct seam exists.
- Remove all temporary instrumentation.
- Delete throwaway harnesses unless they became intentional tests or documented debug scripts.
- State the proven cause and the verification performed.

If the diagnosis exposes an architectural barrier, report it separately after the fix rather than bundling an unsolicited refactor.
