# Domain Docs

This is a single-context repository. Engineering skills consume the root glossary and system-level ADRs before exploring or changing the relevant area.

## Before exploring

- Read `CONTEXT.md` at the repository root.
- Read ADRs in `docs/adr/` that affect the area under investigation.
- If either location does not exist, proceed silently. Do not propose creating domain documentation before a term or decision has actually been resolved.

The `domain-modeling` skill, including its use through `grill-with-docs` and `improve-codebase-architecture`, creates glossary and ADR files lazily when the work establishes durable language or a qualifying decision.

## Layout

```text
/
├── CONTEXT.md
├── docs/
│   └── adr/
│       └── 0001-example-decision.md
└── src/
```

## Use canonical vocabulary

When output names a domain concept in an issue, specification, proposal, test, or implementation, use the term defined in `CONTEXT.md`. Do not substitute a synonym listed under `_Avoid_`.

If a needed concept is absent, first check whether the proposed term is unnecessary or conflicts with existing language. Record a genuine vocabulary gap for `domain-modeling` rather than silently inventing a competing term.

## Surface ADR conflicts

If proposed work contradicts an existing ADR, identify the conflict explicitly instead of silently overriding it. State which ADR would need to be reopened and why the new evidence or trade-off justifies reconsideration.
