---
name: manual-programming
description: >
  Run a Principle Questioning loop after code generation: the agent quizzes the user
  on data flow, state, complexity, and edge cases of the produced code before treating
  it as accepted, preventing rubber-stamping of AI output.
disable-model-invocation: true
---

# Manual Programming — Principle Questioning Mode

A short Socratic check performed by the agent **after** producing code. The premise: code that passes through the screen but not through the brain accumulates as latent debt. Before the user accepts AI-generated code as theirs, they must articulate how it works at the level that matters for the task.

## Important

- The agent is the auditor, not the tutor. Withhold answers until the three-strike fallback triggers.
- Ask one question at a time. Do not chain.
- Question mechanism, behavior, complexity, and edge cases. Never style, naming, or taste.
- The user may opt out at any point with a clear statement ("skip the questioning"). Honor it without negotiation.

## Workflow

After producing a non-trivial code change, do not declare completion. Open a Principle Questioning loop instead.

### 1. Pick load-bearing points

Choose 2–4 places in the change where misunderstanding would actually matter:

- Data flow that crosses a boundary (function, thread, process, network)
- Mutating state, especially shared or aliased
- Algorithmic choice with non-obvious complexity
- Error handling — what propagates, what is swallowed, what recovers
- Boundary conditions — empty input, overflow, race window, partial failure

Skip surface details. If no load-bearing point exists, the change is trivial and this skill does not apply.

### 2. Ask, one point at a time

For each point, ask one targeted question, then wait:

- "Walk through what happens to `<value>` from when it enters this function to when it leaves."
- "If two callers hit this code at the same time, what breaks, if anything?"
- "What is this loop's worst-case cost, and which input shape triggers it?"
- "Which inputs land in the error path, and what is the user-visible consequence?"
- "If `<field>` is null/empty/zero here, what does the next line do?"

Phrase questions in concrete terms tied to the actual code. Avoid generic prompts like "explain this function".

### 3. Grade the answer

Score privately against three criteria:

- **Mechanism named** — the user identifies the actual operation (call, allocation, branch, lock, syscall), not paraphrased pseudocode.
- **Load-bearing behavior identified** — the user names the part that would break if changed.
- **One risk or edge case volunteered** — the user surfaces a failure mode without being prompted for it.

Then route:

- **Solid** (all three): confirm in one sentence and move to the next point.
- **Partial** (one or two): probe the missing criterion with a single follow-up. Do not reveal the answer yet.
- **Off** (none, or pure restatement of code): reframe the question more specifically. Same point, sharper angle.

### 4. Three-strike fallback

If the same point fails to reach **solid** after three exchanges:

1. State the correct understanding plainly in one or two sentences.
2. Anchor it to the specific lines of code.
3. Name one primary source the user should review before similar work (language spec section, RFC, kernel doc, library reference). Cite by name, not by guess.
4. End the loop for this point. Do not retry.

The fallback is not a failure mode for the user — it is the loop's exit valve. Frame it neutrally.

### 5. Close

Once all chosen points are resolved (solid or fallback-delivered):

- Summarize in one line which points landed solid and which fell to fallback.
- Hand control back. Do not declare the code "complete" — only that the loop is done.
