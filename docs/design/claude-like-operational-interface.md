# Claude-like operational interface

## Status

Accepted design specification. Implemented across every renderer-owned surface.

The architectural boundary is recorded in [ADR 0001](../adr/0001-use-claude-structured-operational-interface.md). Canonical domain terms are defined in the repository [context glossary](../../CONTEXT.md). Deliberate differences from the reference implementation are listed in [Accepted deviations](#accepted-deviations).

## Reference baseline

Visual decisions follow these sources in order:

1. Official Claude Code CLI `2.1.218` for observable experience.
2. `~/Projects/claude-code-rust` at commit `a5d19497ce4cc4cc08bb94ab7c707f6c48b98c60` (`v0.14.3-10-ga5d1949`) when official behavior is ambiguous or cannot be inspected.
3. Existing pi-square behavior when neither source defines an equivalent surface and preserving functionality requires a local rule.

The target is a recognizably Claude-like visual language, not a Claude clone or a pixel-perfect copy.

## Scope

The redesign covers every renderer-owned operational surface:

- all pi-square model-callable tools;
- Pi built-ins whose renderers are explicitly owned by pi-square;
- third-party tools that explicitly opt in through the public display Adapter;
- header, footer, extension status, todo widget, prompt manager, and display manager;
- ask workflows, confirmation content, SSH masked-input content, and subagent manager, status, notifications, and Config Guide.

It does not cover:

- ordinary user or assistant conversation messages;
- Pi's main input editor;
- unknown third-party or MCP tools that did not opt in;
- Pi-owned native shells around `ctx.ui.confirm`, `ctx.ui.notify`, or background custom messages.

Native shells remain visible exceptions. Their pi-square-owned content follows this specification where the public API permits it, but their outer containers are not recreated.

## Non-negotiable behavior

This is a presentation replacement, not a feature reduction. The redesign must preserve:

- model-facing tool schemas, execution, results, errors, and security checks;
- all currently visible information across the collapsed and expanded forms of a surface;
- responsive rendering, deterministic non-TTY and test behavior, and bounded output;
- dark, light, and valid third-party theme support;
- sanitization, secret redaction, privacy budgets, and protected security warnings;
- existing focus, keyboard, cancellation, confirmation, secure-input, and manager state machines;
- result replacement of the pending tool entry instead of rendering a second operational entry;
- public display Adapter v1 and its opt-in ownership model.

Critical identity, lifecycle, target, required action, error, and security-warning content must remain visible when collapsed. Other information may move into the expanded form, but it must not become available only in the model-facing payload.

## Shared visual language

All templates share:

- a restrained hierarchy built from a state marker, tool or surface icon, title, target, badges, and attached content;
- fixed single-column, non-emoji state markers and tool-family icons;
- compact spacing and unframed ordinary content;
- tree rails for content attached to a transcript entry;
- English fixed UI labels, badges, and omission messages; user content remains in its original language;
- Pi standard semantic theme tokens rather than required private tokens or hard-coded colors.

Bundled themes should tune the standard tokens toward Claude's rust-orange emphasis, dim gray chrome, red failures, and green additions or permissions. Third-party themes retain their own semantic colors.

## Template model

The interface uses three templates rather than one universal component.

### Tool transcript entry

Tool calls and results use the Claude-style transcript grammar:

```text
  {state marker} {tool icon or label} {title and target} {badges}
  │  {body line}
  └─ {final body line}
```

Execution output may use the reference implementation's fixed six-column indentation where a tree rail would add noise. The header is always width-bounded and ends with `…` when truncated.

Header information is layered as follows:

1. state marker;
2. tool icon and human-readable tool name;
3. primary target;
4. action-critical or lifecycle badges;
5. mode, model, retry, pagination, or rate-limit badges;
6. duration.

At narrow widths, lower-priority items move into the body or expanded form in reverse order. Duration is the first header item dropped. Identity and lifecycle are never dropped.

Short state-related metadata is rendered as a badge. Long values, explanatory metadata, and structured records belong in the attached body. A settled result visually replaces its pending call entry.

### Persistent chrome

Header, footer, and extension status use a chrome-specific layout while sharing the same tokens, markers, labels, and priority rules.

The optional header remains controlled by `banner.enabled`. It becomes a compact Claude-style identity block of at most two normal lines. It does not use `OPERATIONAL CONSOLE`, a marketing tagline, or a full-width decorative rule. Security and renderer-ownership diagnostics are additional protected lines when present.

The footer remains stateless and uses Pi's native read-only data. Its normal layout is:

```text
{model / provider / thinking}                  {usage / cache / cost}
Loc: {cwd / branch / session}                 {context usage / window}
{optional overflow statuses}
```

The highest-priority short status may occupy an available right-side hint position. Multiple or long statuses use the conditional third line. Subagent activity, required user action, security warnings, and renderer-ownership diagnostics have fixed priorities and use their own state markers instead of a blanket warning marker.

Narrow layouts retain the existing compact, regular, and wide responsive tiers and progressively omit low-priority footer details. No independent data polling or persisted usage accounting is introduced.

### Interactive workflow

Ask, manager, todo, secure input, and similar workflows retain their existing interaction state machines and non-overlay behavior. Their presentation adopts the shared title, marker, badge, list, tree, spacing, and theme rules. Security warnings, destructive actions, masked input, review states, and confirmation choices remain strongly visible and cannot be hidden by display policy.

## State model

State becomes a typed two-axis model:

- **Lifecycle**: queued, pending, running, completed, failed, or aborted.
- **Qualifier**: warning, partial, retrying, cancelling, truncated, projected, needs-input, or another closed qualifier justified by an owned surface.

A lifecycle may carry multiple compatible qualifiers. Rendering resolves the marker and badges from both axes, allowing states such as running plus retrying, completed plus warning, or completed plus truncated without flattening them into free text.

The marker vocabulary is:

| Meaning | Marker | Tone |
|---|---:|---|
| Queued | `–` | muted |
| Pending | `○` | accent |
| Running | braille spinner | accent |
| Completed | `✓` | accent or success semantic |
| Completed with warning | `!` | warning |
| Failed | `✗` | error |
| Aborted | `×` | muted error |

The running sequence is `⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏`. Every static marker and animation frame must measure exactly one terminal cell in supported environments.

## Tool icon vocabulary

Icons are semantic, monochrome, and width-tested:

| Family or operation | Icon |
|---|---:|
| Filesystem read/list/find | `▪` |
| Filesystem write/edit | `▣` |
| Search | `⌕` |
| Bash | `$ ❯` |
| PowerShell | `PS ❯` |
| Remote | `⌬` |
| Workflow | `◆` |
| Agent | `◇` |
| Unknown explicitly adapted tool | `○ Tool` |

The implementation must extend the exhaustive display catalog to assign the concrete icon and human-readable label for each owned tool. Unknown tools receive only the bounded generic fallback; the renderer does not inspect or claim unregistered tools.

## Content density and expansion

A collapsed entry is exactly one row. It carries the state marker, tool title,
target, an inline muted outcome summary (or one-sentence failure message),
qualifier badges, and elapsed duration; running and queued entries are also one
row and never stream a live tail into the collapsed view. The mutation family
(`edit`, `replace`, `revert`, `write`) is the only exception: it keeps a bounded
diff/preview body below the row so file mutations stay reviewable without
expanding. Payloads of every other tool are visible only when the entry is
expanded. In the wide layout tier (viewport of 100 columns or more) an entry
renders at `max(60, floor(0.6 × viewport))` cells, left-aligned; below the wide
tier it keeps full width, and expanded entries keep the same column so
expansion never causes a horizontal jump. Hue marks operational state only:
tool titles and targets use neutral text tones while the state marker, qualifier
badges, and diff added/removed lines carry semantic state tokens.

The new defaults are:

- `resultMode: preview`;
- `previewLines: 9`;
- a bounded expanded budget using the existing expanded maximum unless a later
  evidence-based limit is lower;
- `diffView: unified`;
- a default collapsed diff budget aligned with the nine-row body budget.

Collapsed rendering protects identity, lifecycle, targets, required actions,
errors, security warnings, and diff metadata. A redaction token (`[REDACTED]`)
is never split by inline middle elision, so security redaction stays visible
even when the surrounding sentence is elided. The row drop order is fixed:
duration, then the inline summary (eliding in place before dropping), then all
but the highest-priority qualifier badge, then target truncation.

Omissions use an English, dim message that distinguishes hidden source lines
from additional rows introduced by wrapping.

`resultMode: hidden` and `resultMode: summary` remain supported. Hidden policy
never suppresses errors, confirmations, required actions, secret-input notices,
or security warnings. Expanded output remains bounded and sanitized.

With `wordWrap: true`, content wraps within the attached-body width. With
`wordWrap: false`, every physical line is truncated to the available width with
`…`; terminal-native overflow or accidental wrapping is not allowed.

## Diff presentation

Unified diff is the default and follows the reference structure:

- three context lines;
- right-aligned dim line numbers;
- red `-` deletion and green `+` insertion markers;
- a `(+N, -M)` change-count header;
- repository or path metadata where available;
- hanging indentation for wrapped continuation rows;
- protected omission metadata when the collapsed budget is exceeded.

Split diff and `auto` layout remain explicit, non-default `/display` capabilities for users who need them. `auto` must resolve to a documented width-dependent layout. The configurable `diffIndicators` field is removed because bars, classic markers, or no markers would alter the fixed Claude-like grammar.

Projected write previews remain visibly non-authoritative and retain all existing workspace, symlink, regular-file, size, and TOCTOU restrictions.

## Motion

Motion remains `full | reduced | off`:

- `full`: one shared scheduler with a 34 ms minimum interval, approximately 29.4 FPS;
- `reduced`: one shared scheduler with a 120 ms minimum interval;
- `off`: static marker and no timer.

This deliberately changes the current reduced-motion contract from 1 FPS to a 120 ms interval; implementation must update the runtime constants, tests, `AGENTS.md`, and user documentation together.

Tests, CI, non-TTY sessions, `TERM=dumb`, and incapable environments continue to downgrade deterministically. The session owns one scheduler; tool count must not multiply timers. Disposal and terminal states unsubscribe cleanly.

## Display configuration

`/display` remains available for content projection and accessibility. It may control:

- result mode, preview rows, and expanded budget;
- metadata and duration visibility;
- wrapping versus bounded line truncation;
- diff layout, split threshold, and collapsed budget;
- full, reduced, or off motion.

It may not configure:

- state markers or animation frames;
- tool icons and labels;
- title, badge, or tree-rail structure;
- semantic color relationships;
- the three template types.

Configuration precedence, source provenance, project-trust checks, canonical scope, locking, compare-and-swap review, symlink and identity checks, mode preservation, and atomic rename remain unchanged.

A changed display schema uses reviewed one-time migration:

1. The old display object may be read only as a migration input.
2. Equivalent content and accessibility intent is staged in the new schema.
3. Removed or behavior-changing inputs are shown explicitly in `/display` review, including removal of `diffIndicators`, reviewed removal of deprecated `footer.mode`, and the change in meaning of `motion: reduced` from 1 FPS to a 120 ms interval.
4. No file is changed until the user approves the reviewed candidate.
5. The existing safe writer persists the candidate atomically.
6. The runtime does not retain a permanent old/new policy dual stack.

## Public Adapter v1

Adapter v1 remains stable. Its existing static fields are sufficient to produce the generic Claude-style transcript entry, and family or catalog information supplies the icon. This redesign does not add internal sections, raw components, renderer callbacks, theme tokens, or automatic tool discovery to the public API.

A future Adapter v2 requires a concrete third-party expression need that cannot be represented safely by v1. Permission to make a major internal change is not itself justification for a public API break.

## Release shape

The user-visible change ships atomically in one major release. Development may use internal milestones, but no published version may retain mixed native or legacy pi-square renderer branches or expose both the old operational-console visual grammar and the new Claude-like grammar.

Existing historical plans and reviews remain unchanged. Implementation must add the required major changeset, update user and maintainer documentation, and preserve all dependency, security, and package contracts unless a separately reviewed change explicitly modifies them.

## Verification

Automated verification must cover:

- widths 39, 40, 63, 64, 80, 99, 100, and 120;
- bundled dark and light themes plus a minimal valid third-party theme;
- every catalog tool's applicable call, partial, success, warning, failure, aborted, empty, expanded, hidden, summary, preview, and truncated states;
- lifecycle and qualifier combinations;
- state-marker and icon cell widths;
- full, reduced, off, and automatic motion downgrade;
- unified and explicit split diffs, wrapping, and no-wrap truncation;
- all three templates and native-shell exceptions;
- collapsed plus expanded information reachability;
- sanitization, redaction, privacy, security-warning, and bounded-output guarantees;
- public Adapter v1, child no-runtime behavior, ownership conflicts, session lifecycle, and unchanged model-facing results;
- production-decorated renderer paths rather than unreachable legacy renderers.

Required project gates remain:

```bash
npm test
npm run typecheck
npm run smoke
npm run package:check
npm run changeset:status
```

Manual visual acceptance compares the official Claude Code CLI, the pinned local reference, and the new implementation side by side in dark terminals at 80 and 120 columns. Automated tests decide bounds and regressions; manual review decides whether hierarchy, density, spacing, and scanability are recognizably Claude-like.

## Accepted deviations

These differences from the Claude Code reference are intentional. They follow
from ADR 0001, from Pi's public theme contract, or from a bounded scope
decision. They are not defects.

- **Marker and rail vocabulary.** The reference uses one platform dot for every
  tool state and a `⎿` result gutter. This specification instead fixes a
  per-lifecycle marker set and `│`/`└─` tree rails, because pi-square must
  distinguish queued, pending, running, completed, warning, failed, and aborted
  states across many tools that Claude Code does not have.
- **No syntax highlighting in diffs.** The reference renders diffs through a
  native syntax-highlighting module. pi-square uses Pi's semantic diff tokens
  plus word-level emphasis on the changed segment. Highlighting would require a
  new language-grammar dependency and a second required palette.
- **No italic omission text.** Pi's public theme exposes foreground, background,
  bold, and inverse only. Omission messages therefore use the dim token without
  italics.
- **Icons occupy up to four cells.** The symbol icons use one cell, while the
  `$ ❯`, `PS ❯`, and `λ ❯` execution prompts use up to four. Execution tools
  carry the prompt as their title, so the icon is never rendered twice.
- **Background completion messages.** Pi owns the native success and error
  message shell. Only the bounded result inside that shell uses this
  specification, and it shares one description builder with the transcript
  entry.

## Rejected alternatives

- Replacing ordinary conversation or Pi's main input surface.
- Reimplementing Pi native confirmation and notification shells solely for styling.
- Hard-coding Claude RGB values across third-party themes.
- Maintaining old and new visual modes in published releases.
- Removing expanded information to match the reference's collapsed density.
- Permanently supporting old and new display configuration schemas.
- Breaking or removing public Adapter v1 without a missing-expression case.
- Allowing `/display` to change the core visual grammar.
