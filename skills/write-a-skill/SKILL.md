---
name: write-a-skill
description: Create new agent skills with proper structure, progressive disclosure, and bundled resources following the Pi / Agent Skills standard.
disable-model-invocation: true
---

# Writing Skills

## Process

1. **Gather requirements** — ask the user about:
   - What task or domain the skill covers
   - The specific use cases it should handle
   - Whether it needs executable scripts, reference docs, or assets
   - Any existing materials to bundle

2. **Draft the skill** — produce:
   - `SKILL.md` with concise instructions and valid frontmatter
   - `references/` files for material that need not load every time
   - `scripts/` for deterministic operations
   - `assets/` for templates or static resources

3. **Review with the user** — present the draft and ask:
   - Does it cover the use cases?
   - Anything missing or unclear?
   - Should any section be more or less detailed?

## Skill Structure

A skill is a directory containing at minimum a `SKILL.md`. Everything else is optional.

```
skill-name/
├── SKILL.md           # Required: frontmatter + instructions
├── references/        # On-demand docs (loaded only when needed)
│   └── api.md
├── scripts/           # Helper scripts (shell, python, node)
│   └── process.sh
└── assets/            # Templates, fixtures, static resources
    └── template.json
```

Reference everything inside the skill directory with either a bare relative path (`references/api.md`) or the Pi runtime variable `${PI_SKILL_DIR}` (`${PI_SKILL_DIR}/references/api.md`). The variable resolves to the skill's root at load time and is more robust when the agent's CWD is not the skill directory — preferred for scripts and any path the agent will execute.

## SKILL.md Template

```md
---
name: skill-name
description: Brief description of capability. Use when [specific triggers].
---

# Skill Name

## Quick start

[Minimal working example]

## Workflows

[Step-by-step processes; checklists for complex tasks]

## References

[Point to on-demand files: See references/api.md for details.]
```

## Frontmatter

Per the Agent Skills specification, supported by Pi:

| Field | Required | Notes |
|---|---|---|
| `name` | Yes | 1–64 chars; lowercase `a-z`, `0-9`, hyphens only; no leading/trailing/consecutive hyphens. Standard requires it to match the parent directory; Pi only warns on mismatch. |
| `description` | Yes | ≤1024 chars. What the skill does and when to use it. |
| `license` | No | License name or path to a bundled license file. |
| `compatibility` | No | ≤500 chars. Environment requirements (runtimes, packages, network). |
| `metadata` | No | Arbitrary string key-value map. |
| `allowed-tools` | No | Space-separated pre-approved tools (experimental). |
| `disable-model-invocation` | No | Pi extension. When `true`, the skill is hidden from the system prompt and is only invocable via `/skill:name`. |

Unknown fields are ignored. A skill with missing `description` is not loaded.

## Description Requirements

The description is **the only thing the agent sees** at startup when deciding which skills to load. It is surfaced in the system prompt alongside every installed skill.

**Goal**: give the agent enough information to know:

1. What capability this skill provides
2. When and why to trigger it (specific keywords, contexts, file types)

**Format**:

- ≤1024 chars
- Write in third person
- First sentence: what it does
- Second sentence: "Use when [specific triggers]"

**Good**:

```
Extract text and tables from PDF files, fill forms, merge documents. Use when working with PDF files or when the user mentions PDFs, forms, or document extraction.
```

**Bad**:

```
Helps with documents.
```

The bad example gives the agent no way to distinguish this from any other document skill.

## Progressive Disclosure

Skills load in three tiers. Structure content so each tier carries only what that stage actually needs.

1. **Metadata** (~100 tokens): `name` and `description`, loaded at startup for every skill.
2. **Instructions** (<5000 tokens recommended): the body of `SKILL.md`, loaded when the skill is activated.
3. **Resources** (as needed): files under `references/`, `scripts/`, `assets/`, loaded only when the workflow calls for them.

Keep `SKILL.md` under 500 lines. Push depth into `references/`.

## When to Add Scripts

Add scripts under `scripts/` when:

- The operation is deterministic (validation, formatting, parsing)
- The same code would otherwise be regenerated repeatedly
- Errors need explicit handling

Scripts save tokens and improve reliability compared to model-generated code.

## When to Split Files

Move material out of `SKILL.md` and into `references/` when:

- `SKILL.md` is approaching 500 lines
- Content covers distinct domains that callers will not need together
- Advanced features are rarely needed and would otherwise dilute the main instructions

## Review Checklist

After drafting, verify:

- [ ] `name` is lowercase, 1–64 chars, hyphens only, matches the directory name
- [ ] `description` is ≤1024 chars and includes "Use when…" triggers
- [ ] `SKILL.md` body is under 500 lines and roughly under 5000 tokens
- [ ] Detailed material lives in `references/`, not inline
- [ ] All paths to scripts, references, and assets are either bare relative or `${PI_SKILL_DIR}`-prefixed — no absolute paths
- [ ] No time-sensitive information (dates, version-of-the-week claims)
- [ ] Terminology is consistent across SKILL.md and reference files
- [ ] Concrete examples are included
- [ ] References stay one level deep — no chain of pointers
