# Plan Review

Run before presenting any plan. The placeholder scan is mandatory for every tier; the adversarial pass is Deep-only.

## Placeholder scan (mandatory)

A plan with any of these is unfinished. Find and fix each before presenting:

- Unfilled template placeholders: any `<...>` angle-bracket remnant from plan-template.md (e.g. `<goal in one line>`, `<concrete change>`)
- "TBD", "TODO", "later", "etc.", "and so on", trailing "..."
- "add error handling", "handle edge cases", "add validation" — without naming which, where, and why
- "similar to step N", "same as above", "repeat for the others" — spell out each step
- A step that references a file you have not read
- A step with no verification clause
- An approach section that still hedges between two options

If the scan finds nothing, the plan passes this gate. If it finds anything, the plan is not ready to present.

## Self-review (Standard and Deep)

- **Goal coverage** — every part of the requested goal maps to at least one step; nothing requested is silently dropped.
- **Scope alignment** — no step does more than the goal asks. No drive-by refactors, no speculative generality, no unrequested features.
- **Ordering** — each step builds on prior ones; the system stays buildable between steps; tests precede or accompany the behavior they cover.
- **Convention fit** — the plan matches the codebase's existing style, naming, and test discipline, not a generic default.
- **Verifiability** — the verification section names a real command or signal, not "make sure it works".

## Adversarial pass (Deep only)

Delegate the drafted plan to a `thinker` subagent. Brief:

> Task: critique this implementation plan as an adversarial reviewer. The plan is below.
> Context: <the goal, the tier, the key constraints from exploration>.
> Find: (1) missing steps or unhandled cases the goal implies; (2) ordering hazards where a step
> breaks the build or depends on something not yet built; (3) approach risks — places the chosen
> approach is more expensive to unwind than an alternative; (4) scope creep — steps beyond the goal;
> (5) weak or absent verification.
> Scope boundary: critique only. Do not rewrite the plan or propose a different feature.
> Deliverable: a numbered list of concrete findings, each with the step it concerns and why it
> matters. If the plan is sound, say so plainly rather than inventing problems.

Fold genuine findings back into the plan. Discard findings that misread the goal. Do not re-delegate the same plan more than once — a second weak return is a briefing problem, not a plan problem.
