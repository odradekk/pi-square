# Plan Artifact Template

Use this structure for the plan file (`docs/plans/YYYY-MM-DD-<slug>.md`). For Light-tier tasks, render only the starred (*) sections inline in the reply.

Keep it lean. The plan is read by an implementer who has the codebase but not your exploration context. Every section earns its place; drop any that the task does not need.

```md
# Plan: <goal in one line>

Date: YYYY-MM-DD
Tier: Light | Standard | Deep

## Goal *

What this change accomplishes, in one or two sentences. The decided outcome, not the motivation.

## Context

The load-bearing facts from exploration: files in scope, conventions to match, integration
points, constraints (build, test, framework). Reference paths with line ranges rather than
pasting code — e.g. `src/core/router.ts:40-72`. Name anything that could not be established.

## Approach

The chosen approach in a short paragraph. If alternatives were weighed, name the one rejected
and why in a single line — not a comparison table. One approach goes forward.

## Steps *

Ordered, decision-complete steps. Each step names the file(s), the change, and its verification.
The system stays buildable between steps.

1. `path/to/file.ext` — <concrete change>. Verify: <test name / command / observable result>.
2. `path/to/other.ext` — <concrete change>. Verify: <...>.
3. ...

## Verification *

How the whole change is proven correct: the test command, the build/lint gate, and any manual
check for UI or runtime behavior. State what cannot be verified in this environment, if anything.

## Risks & open questions

Only genuine ones. The expensive-to-unwind decisions, the unverified assumptions, the places a
reviewer should look hardest. Omit the section entirely if there are none worth naming.
```

## Notes

- File paths are real and exact. A step that points at a file you have not read is not ready.
- "Verify" is not optional. A step with no verification is a hope, not a plan.
- Do not embed a progress checklist here. Progress is tracked by the `todo` tool after approval; this file is the specification.
