# Handoff: Display Migration Wave #15–#50

## Context

This session implements a cascading series of GitHub issues for `odradekk/pi-square`, migrating every display surface to a Claude-like operational interface. The design spec is at `docs/design/claude-like-operational-interface.md`. Each issue follows the `/implement` skill workflow: explore → design → implement → test → typecheck+smoke → two-axis code review → changeset+commit+push+close.

## Completed Issues (#15–#46)

All issues #15 through #46 are closed. The migration covered:

- **#15–#17**: Operational lifecycle model, attached content through Read, shared motion through Scheme
- **#18**: Authoritative edit diffs (breaking change — `diffIndicators` removed)
- **#19–#20**: Public Adapter v1 bridge, projected Write previews
- **#21–#26**: Path-list (List/Find/FD), text search (Grep/RG), structural search (SG), CodeGraph, PDF search, platform shell
- **#27–#29**: Jina search/fetch, Context7 libs/docs, Firecrawl parse
- **#30–#31**: GitHub search/read, GitHub tree/commit
- **#32–#33**: SSH session transcripts, SSH confirmation/masked input
- **#34**: Todo transcript and widget (three-state markers, SUMMARY/PERSISTENCE sections)
- **#35–#36**: Ask workflow (explicit lifecycle, needs-input qualifier), advanced Ask states (comment-only indicator, progress-frame JSON leak fix)
- **#37**: Compact header (removed OPERATIONAL CONSOLE, tagline, decorative rule)
- **#38**: Claude-style two-row footer (model/usage row, Loc/context row, per-status markers)
- **#39**: Prompt Manager notification content (tree rails, removed decorative rule)
- **#40**: Subagent transcript entries (explicit lifecycle+qualifiers, removed ACTIVITY/ISSUE label prefixes)
- **#41**: Subagent manager browsing (label-led grammar: `LABEL  value` → `Label: value`)
- **#42**: Subagent manager lifecycle actions (operational markers in list rows, flash markers, delete-review label grammar fix)
- **#43**: Subagent footer status (●→◇ marker, running tone warning→accent, PENDING_FRAMES→RUNNING_FRAMES, production-path tests)
- **#44**: Background subagent completion messages (◇ icon, title-case sections, marker tone fixes, aborted error-shell fix)
- **#45**: Config Guide rendering (◆ workflow icon, title-case label, standard semantic tokens, width-aware rule)
- **#46**: Canonical display policy migration reader (pure-function legacy-input reader, diffIndicators/footer.mode/reduced-motion change recording, family/tool name validation)

## Remaining Issues (#47–#50)

Open issues, in dependency order:

| # | Title | Blocked by |
|---|-------|------------|
| 47 | Deliver reviewed migration through /display | #46 ✅ |
| 48 | Contract the legacy internal display model | #47 |
| 49 | Complete cross-surface visual acceptance | #48 |
| 50 | Release the atomic major redesign | #49 |

**Next issue to start: #47** (blocked dependency #46 is complete).

## Key Architecture

### Files modified across the migration wave

- `src/display/workflow-adapters.ts` — Todo, Ask, and Time display adapters (`createWorkflowAdapter`)
- `src/display/remote-adapters.ts` — Search, fetch, docs, parse, GitHub, SSH adapters (`createRemoteAdapter`)
- `src/display/search-adapters.ts` — rg, fd, sg, pdf_search, codegraph adapters (`createSearchAdapter`)
- `src/display/execution-adapters.ts` — bash, pwsh, scheme adapters (`createExecutionAdapter`)
- `src/display/internal-adapters.ts` — Routing table for `decorateInternalTool`
- `src/banner/index.ts` — Compact header
- `src/footer/render.ts` — Claude-style two-row footer
- `src/prompt-manager/render.ts` — Tree-rail notification content
- `src/subagents/display-adapter.ts` — Delegate/resume transcript lifecycle
- `src/subagents/manager.ts` — Manager browsing label grammar
- `src/subagents/render.ts` — Notification label grammar

### Shared patterns

- **Explicit lifecycle**: `OperationalLifecycle` field set on every adapter's `describeResult`, overriding the `statusFor` → `status` → compatibility bridge via `resolveOperationalState` in `src/display/types.ts`.
- **Lifecycle overrides isError for abort**: When `isError:true` is set for tool-aborted results, explicit `lifecycle:"aborted"` ensures `×` marker instead of `✗`. Pattern used by: SSH (#32/#33), Ask (#35), subagents (#40).
- **Qualifiers**: `needs-input` (Ask wizard), `retrying` (subagent active retry), `warning` (completed-with-retries), `partial` (progress updates), `cancelling` (subagent cancellation), `truncated` (output bounds).
- **Compact sections**: `compact:true` makes sections visible in collapsed mode (used by Todo, Ask).
- **`hasDomain` check**: Prevents raw JSON from leaking in expanded views by recognizing structured sections.
- **`dedupeMetadata`**: Prevents duplicate metadata entries when base adapter and workflow adapter both emit the same label.

### Key contracts preserved

- Model-facing schemas unchanged (top-level `Type.Object` with `additionalProperties: false`)
- Public Adapter v1 unchanged (16-field cap, field allowlist)
- Privacy: question text, option labels, prompt snapshots, artifacts, secrets never in call display or collapsed sections
- Sanitization: `sanitizeDisplayLine` applied to all user-facing values
- `run.mjs` registers each test suite; new suites go in the `suites` array

## Key Decisions

- **Review model**: `ccr-claude/claude-sonnet-5` via `subagent_delegate` — consistently finds real issues before commit
- **Changeset level**: All changes are `minor` except #18 (`major` for breaking `diffIndicators` removal)
- **Test naming**: `tests/display/<feature>.test.mjs`, registered in `tests/run.mjs`
- **Pre-existing test hang**: `tests/display/integration.test.mjs` and `tests/release/installed-display-export.test.mjs` and `tests/web/context7-client.test.mjs` have handle leaks causing `run.mjs` to hang. Tests pass individually with `timeout 10 node <file>`. This is NOT caused by our changes.

## Important Test Pitfalls

- `makeCtx(args, state, overrides)` helper: always pass `{}` explicitly for `state` when only using overrides
- Markdown rendering tests need `initTheme()` from `@earendil-works/pi-coding-agent` before `.render()` works
- Collapsed view suppresses non-compact sections; use `expanded: true` to inspect section content in tests
- `remote-agent.test.mjs` has blanket assertions for all tools; new tools with structured domain sections must be excluded from the raw-text assertions
- `field()` helper drops empty/undefined values; empty string `""` is dropped too — use explicit indicator text (e.g., `comment-only=yes`) for empty-but-meaningful fields

## Suggested Skills

- **`/implement`**: The primary workflow skill for each issue (explore → design → implement → test → review → commit)
- **`/code-review`**: Two-axis Standards+Spec review before commit (use `ccr-claude/claude-sonnet-5` model)
- **`/commit`**: Conventional Commits with per-group confirmation
- **`/research`**: If an issue requires investigating external API behavior or design decisions

## Current State

- **Git**: On `main`, pushed to `origin/main` at `92d0881`
- **TypeScript**: Clean (`npx tsc --noEmit`)
- **Smoke**: Passing (`npm run smoke`)
- **Changesets**: 32 pending changesets in `.changeset/`
- **Test suites**: 110 suites registered in `tests/run.mjs` (109 display/feature suites pass individually; pre-existing handle leak in 3 suites)
