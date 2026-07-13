---
name: plan
description: >
  Turn a decided goal into a reviewable, decision-complete implementation plan, scaled to the task's size.
  Use when: "plan this out", "create a roadmap", "break this into phases", "break this into steps",
  "give me a step-by-step", "how should I build this", or before starting a non-trivial multi-step change.
  Do not use when: the goal is still undecided and needs divergent exploration (use brainstorm),
  the task is a single known edit with an obvious cause, or something is broken and needs root-causing (use diagnose).
argument-hint: "[feature, task, or goal to plan]"
allowed-tools: [read, rg, fd, search, write, ask, subagent, todo]
---

# Plan — Decision-Complete Implementation Planning

Produce a plan a competent implementer can execute without making further design decisions. Plan covers **how and in what order**, given an already-decided goal. It does not decide *what* to build (that is brainstorm) and does not root-cause failures (that is diagnose).

User arguments: $ARGUMENTS

## Critical

- Explore before planning. Never write a plan from assumptions about the codebase — gather evidence first.
- Match planning depth to task size (see Phase 0). Over-planning a small change is a failure, not thoroughness.
- The plan is a reviewable artifact, not the act of building. Stop at the approval checkpoint; do not start implementing until the user approves.
- A plan with placeholders is an unfinished plan. "TBD", "add error handling", "similar to step N", "etc." are failures, not content. Every step names real files, real changes, real verification.

This skill produces the **specification** (the plan file). Progress tracking during execution is a separate concern — use the `todo` tool for that, seeded from the approved plan. Do not invent a parallel TODO mechanism inside the plan.

## Phase 0: Size the task

Pick the tier before starting. State the tier and one-line reason, then proceed. Sizing is provisional: if Phase 1 reveals the task is larger or riskier than it looked, restate the new tier and follow its path.

- **Light** — a small feature or a change touching a few files with a clear shape. Output: a 3-6 step plan written directly in the reply. Read the few files in scope (Phase 1, no subagents, no mid-flow ambiguity checkpoint), then draft (Phase 2) and present. No plan file. The Phase 4 approval checkpoint still applies.
- **Standard** — a multi-file feature whose approach has real choices. Output: a single plan file. Light exploration. Run all phases.
- **Deep** — a subsystem, a cross-cutting change, or anything where a wrong approach is expensive to unwind. Output: a plan file plus parallel exploration and a mandatory adversarial self-review. Run every phase.

If the request is a single obvious edit, this skill is unnecessary — say so and make the change directly.

## Phase 1: Explore

Gather the load-bearing facts the plan will rest on. Use the repository retrieval discipline:

- `explorer` subagents for behavior, architecture, intent, and feature location.
- `rg` for exact strings and symbols; `fd` for known paths; `read` the files that matter.
- `search` only for external APIs or libraries the plan depends on and the codebase does not document.
- For **Deep** tasks, delegate breadth to parallel `explorer` subagents — one per subsystem or question — and synthesize their returns. Do not serialize independent exploration.

Collect: the files in scope, the existing conventions to match, the integration points, and the constraints (build system, test discipline, framework guarantees). Name what you could not establish rather than assuming it.

Checkpoint (Standard/Deep): if a genuine ambiguity blocks the approach — not a trivial fork — resolve it with one round of `ask`. Do not pepper the user with questions that exploration could answer.

## Phase 2: Draft the plan

Write the plan against the structure in `${PI_SKILL_DIR}/references/plan-template.md`.

For **Light**, render the template's essential parts inline (goal, ordered steps with real file paths, verification) — no file.

For **Standard/Deep**, write the plan to `docs/plans/YYYY-MM-DD-<slug>.md` using the `write` tool. Use the current date; derive `<slug>` from the goal.

Every step must be decision-complete: the file to change, the nature of the change, and how its correctness is verified. Order steps so each builds on the last and the system stays buildable between them. Where new behavior is added, name the test that proves it.

## Phase 3: Self-review

Before presenting, scan the plan against `${PI_SKILL_DIR}/references/review-checklist.md`. The placeholder scan is mandatory for every tier. For Standard and Deep, also run the self-review section of the checklist. For Standard/Deep, fold any fixes back into the plan file by rewriting it before presenting — the presented file must be the reviewed version, not the first draft.

For **Deep** tasks only, run an adversarial pass: delegate the drafted plan to a `thinker` subagent with the critique brief in the review checklist, then fold genuine findings back into the plan. Skip this for Light and Standard — it is ceremony there.

## Phase 4: Approval checkpoint

Present the plan and stop. For Light, the plan is in the reply; for Standard/Deep, give the file path and a tight summary of the approach and the step count.

End at the decision point: the recommended approach and what approval will set in motion. Do not begin implementation in the same turn. On approval, seed the `todo` tool from the plan's steps and proceed to execution.

## References

- `${PI_SKILL_DIR}/references/plan-template.md` — the plan artifact structure.
- `${PI_SKILL_DIR}/references/review-checklist.md` — placeholder scan, self-review, and the adversarial critique brief.
