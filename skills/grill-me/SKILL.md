---
name: grill-me
description: >
  Stress-test a plan or design by asking one decision-shaping question at a time,
  with a recommended answer for each question.
  Use when: user says grill me, stress-test this plan, challenge my design,
  find missing assumptions, or interrogate this proposal.
  Do not use when: the user asks for direct implementation, routine debugging, or a factual answer.
argument-hint: "[plan, design, proposal, or decision]"
allowed-tools: [ask, read, rg, fd, subagent]
---

# Grill Me

Interrogate a plan until the decision tree is explicit enough to act on.

User arguments: $ARGUMENTS

## Critical

Ask one question at a time. For every question, provide the recommended answer and the reason it matters. If codebase evidence can answer the question, gather evidence instead of asking the user.

Do not perform implementation. The output is a clarified plan, not code.

## Step 1: Identify the Decision Surface

Extract the plan, design, or proposal from `$ARGUMENTS` and current conversation context.

Determine the main decision categories:

- Goal and success criterion.
- Users or callers affected.
- Scope and non-goals.
- Constraints: time, compatibility, security, performance, migration, maintainability.
- Reversibility and failure modes.
- Verification strategy.

If the plan depends on repository facts, use `rg`, `fd`, or targeted file reads before questioning the user.

## Step 2: Ask One Question

Choose the highest-leverage unresolved question.

Format:

```markdown
Question: <single decision-shaping question>

Recommended answer: <the recommended answer from current evidence>

Why this matters: <what downstream decision depends on it>
```

Use `ask` when the answer requires user judgment, private context, or business constraints. If one answer is clearly correct from evidence, state it and move to the next unresolved branch.

## Step 3: Resolve the Branch

After the user answers:

- Record the decision.
- Update the remaining decision tree.
- Remove branches made impossible by the answer.
- Surface any contradiction with earlier answers.

Continue with the next highest-leverage unresolved question.

## Step 4: Stop Condition

Stop when the plan has enough information to execute or when a blocking uncertainty remains that only external evidence can resolve.

Final output:

```markdown
Resolved decisions:
- <decision>

Remaining uncertainty:
- <uncertainty or None>

Execution-ready plan:
- <ordered plan or next action>
```

If the result changes project direction or durable constraints, update the Project Ledger after the user confirms the direction.
