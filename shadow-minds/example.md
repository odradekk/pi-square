---
# One complete Shadow Minds definition, annotated for authors (#188).
# This file is packaged reference documentation: it is never discovered as a
# runtime definition. Copy it into your agent directory (all projects) or the
# nearest .pi/shadow-minds directory (this project) and edit from there.
#
# The frontmatter is a strict YAML subset: plain or quoted scalars, one-line
# flow lists, nested maps with exactly two-space indentation. Whole-line
# comments (like these) are allowed; '#' inside or after a value is not.
promptVersion: 1

# The id must equal the Markdown filename stem: this file must be example.md.
# Pattern: letters or digits first, then letters, digits, dot, underscore, or
# dash; at most 64 characters.
id: example

# Human-readable label shown in the manager; at most 120 characters. Every
# effective definition needs one, so a nameless file fails closed unless a
# lower layer provides it.
name: Annotated example

# Definitions stay disabled until you explicitly enable them. The global
# agent-level master switch stays off by default and no project can turn it
# on; enabling here only arms this definition once the switch is on.
enabled: false

# hidden: true removes the definition from the manager list while keeping it
# schedulable. Omitted fields inherit from the lower layer (agent base under
# the project overlay); explicit null clears inherited instructions; an
# explicit empty list replaces an inherited list.
hidden: false

# priority breaks trigger ties: higher runs first. Integer, -1000..1000.
priority: 0

# Automatic triggers. Exactly these four exist; duplicates are rejected.
#   tool_turn  — parent tool activity generations
#   failure    — classified quality-command failures
#   mutation   — successful declarative file mutations
#   completion — the real-user run settles without interruption
triggers: [completion, failure]

# Per-trigger guidance merged by key across layers; null removes one key.
triggerInstructions:
  # Keep instructions below 8000 characters each.
  completion: Compare the settled answer against the evidence it cites.
  failure: Name the failing target and the first error line only.

# Delivery when an automatic run completes: steer supplements the active
# parent, wake starts a settled parent, notify only records an inbox result.
delivery: notify

# A completion gate holds this extension's settle handling for a bounded
# window so gate-subscribed completion work can finish before the answer
# settles. It requires a completion subscription above.
completionGate: false

# parentModels restricts activation to exact 'provider/model-id' references
# or '*' (any). Omit the field to allow every parent model; at most 32
# entries, no duplicates.
# parentModels: [anthropic/claude-sonnet-4-5, openai/gpt-5.1]

# An explicit Shadow model as exact 'provider/model-id'. Omitted inherits
# the activating parent model.
model: anthropic/claude-haiku-4-5

# Thinking selection for the Shadow model. One of: off, minimal, low,
# medium, high, xhigh, max. Omitted inherits definition -> effective
# defaults -> activating parent, in that order.
thinking: low

# Runtime budgets: integers within the bounds shown in the comments.
# Omitted values inherit the effective configuration defaults.
#   timeoutSeconds: 1..600   maxTurns: 1..32   maxToolCalls: 1..128
timeoutSeconds: 300
maxTurns: 8
maxToolCalls: 24

# Evidence tools. Omitted selects the default local read-only set
# (read, grep, find, ls); [] selects no tools. Names are lowercase
# snake_case, at most 16 entries. Project text can never expand the fixed
# Shadow-safe catalog; unavailable optional tools drop with a visible
# warning at run start.
tools: [read, grep, ls]

# Required tools must be a subset of the final tool set above. A required
# but unavailable or excluded tool fails before any model prompt.
requiredTools: [read]

# debug keeps the bounded child-session JSONL transcript for diagnostics.
debug: false

# The output schema is the contract the Shadow's final submit tool enforces.
# It is replaced atomically across layers (never field-merged); null restores
# the default summary schema. Bounded JSON Schema subset: object roots only,
# additionalProperties: false on every object, at most 6 levels of nesting,
# 64 total properties, 32 per object, maxItems <= 64, maxLength <= 12000.
outputSchema:
  type: object
  properties:
    # Enum values must match the declared scalar type.
    verdict:
      type: string
      enum: [sound, gap, wrong]
    findings:
      type: array
      items:
        type: string
        maxLength: 500
      maxItems: 16
  required: [verdict, findings]
  additionalProperties: false
---

Own one bounded responsibility and answer through the fixed result schema.

You observe the parent's trajectory as read-only evidence. Ground every
finding in entries you can quote; when the evidence is missing, say so in a
finding instead of guessing.

- Report at most a handful of findings; the payload bound is 24000 encoded
  characters and longer payloads are rejected with field-level errors.
- Never claim a capability the tool list does not give you: there is no
  shell, no write, no SSH, no upload, and no delegation in a Shadow run.
- The verdict is your single-word judgment; findings are its evidence.
