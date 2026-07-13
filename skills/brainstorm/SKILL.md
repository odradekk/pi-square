---
name: brainstorm
description: >
  Guide divergent-to-convergent thinking for any idea, concept, requirement, or feature,
  producing an actionable markdown deliverable.
  Use when: "brainstorm", "let's brainstorm", "help me think through", "explore this idea",
  "I have an idea", "let's diverge", or the user presents a vague idea needing structured exploration.
  Do not use when: user says "plan this out", "create a roadmap", "break this into phases",
  "break this into steps", "give me a step-by-step", "how do I do this",
  wants code review, adversarial review, or pair programming.
argument-hint: "[idea, topic, or problem to explore]"
allowed-tools: [read, rg, fd, search, write, ask, subagent]
---

# Brainstorm — Diverge-Converge Facilitator

Facilitate structured creative thinking: start broad, explore possibilities, then progressively narrow through multi-round interaction until a concrete, actionable deliverable emerges. Apply to product ideas, features, technical approaches, business strategies, creative projects, or any domain where exploration precedes decision.

## Important

- Never skip the diverge phase — even if the idea seems clear, surface at least 3 alternative angles before converging.
- Never converge without explicit user signal — present options and wait for direction.
- Require user confirmation before advancing to the next phase.

## Workflow

Execute phases in strict order. Each phase ends with a checkpoint question.

### Phase 1: Seed

Read $ARGUMENTS as the initial idea. If no arguments are provided, ask the user to describe it.

Restate the idea in clear terms and confirm understanding:

1. **Core idea** — What is being proposed, in one sentence
2. **Domain** — What area this touches (product, tech, business, creative, life, etc.)
3. **Motivation** — Why this is worth exploring; what problem or opportunity drives it
4. **Existing constraints** — Known boundaries (time, resources, tech stack, audience)
5. **Success vision** — What a good outcome looks like

Checkpoint: "Does this capture the idea correctly? Anything to add or correct?"

### Phase 2: Context Gathering

Collect background information to fuel divergence. Adapt methods to the domain:

- **Web research** — Search for related trends, prior art, competitor approaches, and case studies. Use `search` for current information.
- **Code exploration** — If the idea involves an existing codebase, use `rg` for symbol and string search, `fd` for path discovery, then `read` the relevant files. For broad architectural or behavioral exploration, delegate to an `explorer` subagent.
- **User knowledge** — Ask what is already known, what has been tried, and what references already exist.

Summarize the most relevant findings (up to 10). If evidence is thin, state that explicitly rather than padding the result.

Further targeted research is deferred — it happens inside converge, on demand, when a specific direction's viability hinges on a question this phase did not answer.

Checkpoint: "Here is what I found. Anything to add before we diverge?"

### Phase 3: Diverge (Breadth)

Load `${PI_SKILL_DIR}/references/techniques.md` and select 2-3 techniques from the **Divergent Techniques** section that fit the domain. Use the Technique Selection Guide at the end of the file to match techniques to the domain.

For each technique, generate concrete possibilities rather than abstract categories. Aim for **quantity over quality** in this phase.

Structure the output as:

1. **Technique applied** — Name and brief description
2. **Ideas generated** — Numbered list of concrete possibilities (aim for 5-8 per technique)
3. **Wild cards** — 2-3 deliberately unconventional or provocative ideas

Present all ideas together as a landscape map. Do not filter or rank yet.

Checkpoint: "Which ideas stand out? Any directions worth exploring further, or any that feel off?"

### Phase 4: Converge (Depth) — Multi-Round

This is the core interactive phase. Through multiple rounds, narrow from the full idea landscape to a focused, actionable direction. Select one **Convergent Technique** from `${PI_SKILL_DIR}/references/techniques.md` per round to structure the narrowing (for example, Impact-Effort Matrix in round 1, Pairwise Comparison in round 2).

**Round structure (repeat 2-4 rounds as needed):**

1. **Cluster** — Group the user's selected ideas by theme or approach
2. **Evaluate** — For each cluster, surface the chosen convergent technique and assess:
   - Strengths and unique value
   - Risks, unknowns, and dependencies
   - Effort estimate (rough: low/medium/high)
   - Synergies with other clusters
3. **Sharpen** — Ask a focusing question to guide selection:
   - "If only one direction could advance, which one?"
   - "What would be most regrettable to leave on the table?"
   - "Which option best aligns with the stated motivation?"
4. **Narrow** — Based on the response, eliminate or merge directions

Each round meaningfully reduces the option space; the final round resolves to a single direction, typically as a two-way decision.

**Targeted research, on demand.** Whenever a candidate direction's viability hinges on a fact not yet established — feasibility, prior art, code-path constraints, references — pause the round to gather that evidence with `search`, `rg`, or `read`, then resume cluster evaluation. Resolve the question where it arises; do not defer it to a separate phase.

Checkpoint (each round): "We've narrowed to [N] directions. Ready to go deeper, or want to revisit anything?"

**Exit condition:** The user confirms a single clear direction with defined scope.

### Phase 5: Draft Output

Generate the deliverable using the template at `${PI_SKILL_DIR}/assets/output-template.md`.

The output document should include:

1. **Executive summary** — One-paragraph description of the final idea
2. **Problem & motivation** — Why this matters
3. **Proposed approach** — Concrete description of what to build, do, or create, including key components
4. **Key decisions made** — Record of choices from the converge phase with rationale
5. **Exploration record** — Summary of alternatives considered and why they were set aside
6. **Action items** — Concrete next steps
7. **Open questions** — Remaining unknowns to resolve
8. **References** — Links and sources gathered during research

Present the draft for review.

Checkpoint: "Draft is ready. What needs changing?"

Iterate on feedback until the user confirms the draft is satisfactory.

### Phase 6: Finalize

Once the draft is confirmed, ask in a single combined prompt:

"Draft is confirmed. Want an independent perspective review (an outside agent critiquing completeness, feasibility, blind spots, actionability), or is there anything else to add? Otherwise I'll write the file."

- **Review requested.** Delegate to an independent reviewer (e.g. a `thinker` or `worker` subagent) with the draft and a critique brief covering completeness, feasibility, blind spots, and actionability. Present the feedback, ask which points to incorporate, update the draft.
- **Supplements offered.** Incorporate them and re-present the draft.
- **Neither.** Proceed.

When the user confirms, write the file:

1. Ensure `{cwd}/.pi/plans/` exists.
2. Compute the slug via the bundled script — it handles unicode, multi-byte-safe truncation, and empty-input fallback:
   ```
   slug=$(python3 ${PI_SKILL_DIR}/scripts/sanitize-topic.py "<topic>")
   ```
   Filename: `brainstorm-${slug}.md`.
3. Write the final markdown via the `write` tool to `{cwd}/.pi/plans/brainstorm-${slug}.md`.
4. Present a concise summary. Do not begin execution unless the user explicitly approves.

## Adaptation Rules

Adapt behavior to the domain:

| Domain | Diverge emphasis | Converge emphasis | Extra actions |
|--------|-----------------|-------------------|---------------|
| Product/Feature | User needs, market gaps, UX flows | Feasibility, impact vs effort, scope | Explore competitors via web |
| Technical/Architecture | Design patterns, tradeoffs, alternatives | Performance, maintainability, constraints | Explore codebase for context |
| Business/Strategy | Market analysis, positioning, models | ROI, risk, timeline | Search for case studies |
| Creative | Inspiration, mood, references, style | Coherence, audience, medium constraints | Search for examples and trends |
| Personal/Life | Values, priorities, scenarios | Practicality, alignment, timeline | Reference prior decisions and personal frameworks for fit |

## Examples

### Example invocation

```
/brainstorm a notification system for our app
```

### Example diverge output (abbreviated)

**Technique: SCAMPER**
1. Substitute — Replace push notifications with an in-app inbox
2. Combine — Merge notifications with an activity feed
3. Adapt — Borrow Slack's threading model for grouped notifications
4. ...

**Technique: Six Thinking Hats**
1. White (facts): Current users check the app 3x/day on average
2. Red (feelings): Users report notification fatigue
3. ...

**Wild cards:**
- Anti-notification: Notify only when the user has **not** done something
- Social notifications: Let users subscribe to each other's activity

### Example converge round

**Clusters identified:**
- A: Smart digest (batched, prioritized summary)
- B: Activity feed (persistent, pull-based)
- C: Hybrid (real-time critical + daily digest)

**Focusing question:** "Users report fatigue — which approach best addresses that while keeping engagement?"
