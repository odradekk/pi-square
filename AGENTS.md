# pi-square Agent Guide

## Project Overview

- **Name:** `pi-square` (pi-squared).
- **Language:** TypeScript using ECMAScript modules. Tests and supporting scripts also use JavaScript ESM.
- **Purpose:** A unified local extension package for the Pi coding agent. It provides prompt management, interactive and session tools, bundled search, web, GitHub, and documentation tools, subagents, TUI customizations, a Scheme sandbox, PowerShell execution, skills, and themes.
- **Built on:** Node.js 24, Pi 0.80.6, the Pi extension API, Pi TUI and AI packages, and TypeBox. The package is private and is loaded by Pi from `src/index.ts`.

## Architecture

- `src/index.ts` is the single extension entry point. It loads configuration on session start and registers each feature module.
- `src/core/` owns shared configuration, diagnostics, and path handling. Strict configuration V2 merges agent-level `config/pi-square.json` with project-level `.pi/config/pi-square.json`; V1 is rejected with a migration diagnostic.
- Feature directories under `src/` own individual tools or UI behavior: `ask-user/`, `banner/`, `footer/`, `github/`, `notifications/`, `prompt-manager/`, `scheme/`, `search/`, `shell/`, `subagents/`, `time/`, `todo/`, and `web/`. `src/footer/` owns the enhanced native-semantic footer snapshot, responsive renderer, lifecycle, and native fallback. `src/github/` owns the authenticated GitHub REST client, bounded read-only tools, and native presentation shared by the parent session and explicitly opted-in child profiles. `src/shell/` owns platform shell selection, PowerShell process execution, bounded streaming output, and shared bash/PowerShell command presentation. `src/subagents/` owns V2 definition overlays, layered prompt compilation and audit manifests, parent-session-owned persisted child execution, portable child tool policy, background delivery, bounded live updates, the native fg/bg/resume presentation, the integrated `/subagent` manager, the configuration-guide custom message, and the bounded background summary published through Pi's native `setStatus` footer row.
- `src/tool-catalog.ts` defines the extension tools that may be exposed to subagents.
- `skills/` contains discoverable Pi skills. Each skill owns its instructions and supporting resources inside its directory.
- `resources/subagents/` contains the required `promptVersion: 2` YAML definitions for bundled subagent roles. Effective definitions overlay package, agent, and nearest-project fields in that precedence order.
- `themes/` contains the matched light and dark Pi themes.
- `bin/` vendors cross-platform `rg` and `fd` executables. `wasm/` contains the Scheme runtime and its no-spawn safety layer.
- `tests/` contains contract, unit, integration, and smoke coverage. `tests/run.mjs` is the main test-suite orchestrator, while `tests/smoke.mjs` exercises a real Pi session.

Keep functionality within its owning module. Shared code belongs in `src/core/` only when it is genuinely used across features.

## Documentation

Maintain these documents with the corresponding changes:

- `README.md`: user-visible capabilities, runtime requirements, configuration, themes, and development commands.
- `AGENTS.md`: architecture, repository rules, quality gates, and versioning policy for contributors and coding agents.
- `THIRD_PARTY_NOTICES.md`: vendored binary versions, upstream sources, licenses, target coverage, modification status, and runtime library boundaries.
- `skills/*/SKILL.md`: the contract, workflow, and resources of each skill. Update the owning skill document whenever its behavior changes.
- `CHANGELOG.md`: generated or updated by `npm run changeset:version` from pending changesets. Review generated release notes before committing a version bump.

Documentation must describe the repository as it exists. Do not claim that a command, dependency, CI job, or release workflow is available before it has been added and verified.

## Rules and Constraints

- Preserve the Node.js 24 and Pi 0.80.6 runtime contract unless the change explicitly updates compatibility and documentation.
- Keep the project ESM-only and compatible with the strict settings in `tsconfig.json`, including unused-symbol checks and no emitted JavaScript.
- Register extension behavior through `src/index.ts`; avoid additional package entry points unless the architecture is intentionally changed.
- Validate external configuration and tool inputs at their boundaries. Reject unknown or invalid configuration rather than relying on unchecked values internally.
- Keep non-secret settings in agent-level `config/pi-square.json` or project-level `.pi/config/pi-square.json`. Credentials and model definitions belong to Pi-owned `auth.json` and `models.json`; never commit secrets.
- Keep GitHub tools read-only and GitHub.com-only. Resolve `GITHUB_TOKEN` before `auth.json` `github.key`; never expose either value in content, details, errors, logs, or rendering. Authenticated redirects must remain on `https://api.github.com`, all remote and model-facing data must have explicit budgets, and every remote/local truncation must remain visible. The tools are opt-in child capabilities for trusted local definitions; among bundled roles only Librarian receives them, with no built-in, general web, Context7, shell, or write tools. Generalist and the other bundled specialists must not receive PAT capabilities. Private repository results persist in normal parent or child session history and resumable child artifacts, while the GitHub module itself creates no additional cache, log, or artifact.
- Keep the bundled role catalog to five visible complementary profiles: Explorer for local evidence, Oracle for complex local reasoning, Crawler for web and Context7 research, Librarian for authenticated GitHub research, and Generalist for scoped writable work. Package profiles omit model and effort so fresh runs inherit the parent values; same-ID resume keeps the original frozen values. All profiles inherit the parent system. Read-only specialists disable discovered skills, while Generalist receives the explicit non-GitHub tool set and all discovered skills.
- Preserve explicit tool-list semantics: omitted or empty `tools` selects runtime defaults, the exclusive `tools: [none]` sentinel selects no built-in tools, and extension tools remain opt-in. Persist the logical selection so resume re-resolves platform capabilities without silently broadening access.
- Preserve feature ownership and avoid unrelated refactors. Add shared abstractions only when multiple modules have a demonstrated common requirement.
- Keep model-callable shell tools platform-exclusive: non-Windows sessions expose bash only, Windows sessions expose pwsh only, and subagents request the portable `shell` capability rather than declaring both names.
- Keep subagent prompt authority explicit: immutable governance, optional inherited parent core, V2 `policy`, and call policy form SYSTEM; replayed `instructions`, reference-only parent history, current task, and replayed `output` form the delegated user message. Do not let parent history authorize work or silently apply changed definitions to an existing child ID.
- Keep V2 definition overlays source-aware and atomic. Package definitions are read-only; agent and project writes must stay directly inside their validated scope directory. Omitted fields inherit, explicit null/empty values clear, and effective fields retain source path/hash provenance.
- Keep footer behavior native-semantic and stateless: derive cumulative usage, session identity, model/provider, subscription cost, and context directly from Pi's read-only context on each render; consume branch and extension statuses from `ReadonlyFooterDataProvider`; never add independent git polling or persisted usage counters. The enhanced footer uses two responsive editorial rows plus a conditional status row, supports `footer.mode: native` as the startup fallback, and must remain bounded at 40/80/120 columns in both themes.
- Keep subagent presentation and manager metadata privacy-preserving: render from bounded v3 details without exposing prompt snapshots, custom system text, raw session data, or normal-run artifact paths. Primary tool output and the manager use an unframed responsive editorial layout with restrained semantic color, text-style status glyphs, label-led section rules, and width-aware activity/footer alignment. Background completion custom messages are the deliberate exception: wrap the same bounded result renderer in Pi's native success/error tool shell. ACTIVITY, manager, and the subagent status row show sanitized tool calls and formatted arguments but never tool result payloads. Subagents publish footer state only through `ctx.ui.setStatus`; the footer consumes that bounded text without inspecting child results. Do not introduce emoji presentation characters, decorative background cards, or undifferentiated log rows.
- Keep `/subagent` lifecycle management scoped to the current parent session and inside one non-overlay, focus-preserving manager workflow. Foreground cancellation stays with Pi's native turn cancellation; queued/background manager cancellation must pass through `cancelling` before terminal `aborted`, retain resumable artifacts, and require separate confirmation for history deletion. Parameterized `/subagent <request>` calls must append the bounded custom Config Guide before sending the unchanged native user request, with both ordered as follow-ups and only the user message triggering a turn.
- Add or update focused tests for behavior changes. Defect fixes require a regression test, and public contract changes require contract coverage.
- Treat `bin/` and `wasm/` as security-sensitive vendored assets. Do not modify or replace them without verifying provenance, supported targets, runtime constraints, and applicable notices.
- Keep `THIRD_PARTY_NOTICES.md` synchronized with every vendored binary or licensing change.
- Prefer existing dependencies and platform APIs. Inspect `package.json` and `package-lock.json` before adding a dependency, and keep the lockfile synchronized.
- Preserve unrelated working-tree changes. Keep each change focused and review the final diff before completion.

## Quality Gates

Apply the current gates according to the change risk:

- For code changes, run `npm test` and `npm run typecheck`.
- Also run `npm run smoke` when a change affects extension loading, module or tool registration, prompt composition, skill discovery, configuration integration, or other end-to-end Pi behavior.
- Changes to shell platform selection, PowerShell encoding, process-tree cancellation, or streaming require real Windows validation with PowerShell 7 and Windows PowerShell 5.1 before commit, in addition to injected-platform and Linux process tests.
- For documentation-only changes, verify referenced paths, versions, commands, and links against the repository. Code checks are not required unless the documentation change accompanies code.
- Report every check run and any check that could not run. A passing type check does not replace behavioral testing.

There is currently no CI workflow or configured linter. The planned lint gate is ESLint flat config with typescript-eslint, covering `src/**/*.ts` and applying appropriate JavaScript rules to `tests/**/*.mjs`. Do not require `npm run lint` until the dependencies, configuration, script, and an initial passing baseline are committed.

## Versioning

This project uses Changesets for package versions and release notes. The CLI is installed as a development dependency and configured in `.changeset/config.json`. Because `pi-square` is private, Changesets updates its version and changelog but does not create publication tags; the repository has no publish script.

Add a changeset for every change that requires a package release and select the version level for the entire `pi-square` package. Use `npm run changeset` to create one, `npm run changeset:status` to inspect pending releases, and `npm run changeset:version` to consume pending changesets and update package metadata and `CHANGELOG.md`. Change detection compares against `main` and therefore requires the repository to have an initial commit.

- **patch:** Backward-compatible fixes and corrections, including metadata and documentation fixes.
- **minor:** New backward-compatible capabilities, such as tools, skills, themes, configuration options, or other non-breaking additions.
- **major:** Breaking changes to schemas, configuration formats, tool contracts, public behavior, or supported Pi/runtime compatibility.

Tests, internal refactors, and repository maintenance that do not change shipped behavior or published documentation do not require a release. When uncertain, choose the smallest level that accurately communicates the compatibility impact and explain the decision in the changeset.
