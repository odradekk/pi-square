# Code Review — `5fb8fa2` `feat(display)!: add operational console rendering`

| | |
|---|---|
| **Commit** | `5fb8fa2ffda56ef56435f8face47838a8eea2102` |
| **Parent** | `d572443` (Merge PR #11, changeset-release/main) |
| **Branch** | `main` |
| **Author / Date** | s1n · Wed Aug 5 01:32:44 2026 +0800 |
| **Size** | 99 files, +8028 / −322 (42 added, 57 modified) |
| **Release level** | `major` (`.changeset/pi-square-display-redesign.md`) |
| **Reviewed** | 2026-08-05 |

## Verdict

**Approve with required follow-ups.** The new `src/display/` module is a well-engineered
core: the configuration writer, public Adapter v1, projected-write preview, and policy
provenance model are all above the bar for security and boundary discipline, and every
quality gate passes.

The problem is not in `src/display/` — it is in the **integration layer**. The commit adds a
generic decorator on top of every existing tool definition instead of migrating them, which
silently disables roughly 3,000 lines of specialized renderer code, produces a measurable
functional regression in subagent presentation, and violates a rule this same commit adds
to `AGENTS.md`. Roughly 2,400 lines of passing tests now exercise a code path production
never reaches.

### Verification performed

| Gate | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm test` | pass — 92 suites, 0 failed |
| `npm run smoke` | pass |
| `npm run package:check` | pass — 196 files, 23,075,784 bytes |
| `npm run changeset:status` | 1 pending `major` for `@odradekk/pi-square` |

Findings marked *(measured)* were reproduced by executing the shipped modules directly.

---

## What the commit does well

- **`src/core/config-write.ts`** — the `/display` writer is the strongest code in the change.
  It canonicalizes the scope root, rejects symlinked path segments rather than following them,
  takes an `O_CREAT|O_EXCL` lock with identity- and token-verified release, re-checks the
  full-file SHA-256 fingerprint both before staging *and* immediately before rename, validates
  the complete candidate through the same schema as `loadConfig`, preserves the existing file
  mode, and cleans up the temp file by verified identity. The stale-review path returns the
  user to review instead of clobbering an external edit.
- **`src/display/public.ts`** — Adapter v1 refuses accessors, symbol properties, non-`Object`
  prototypes, and unknown keys; it takes ownership at the property-descriptor level and
  restores originals *only while the installed descriptors still match*, so a later third-party
  renderer is never overwritten. The absent-runtime queue is versioned, bounded at 128, and
  tolerates a damaged global without dropping in-module registrations.
- **`src/display/file-preview.ts`** — `realpath` workspace boundary, regular-file-only,
  1 MB cap, and a genuine TOCTOU check using bigint `dev/ino/size/mtimeNs/ctimeNs` identity
  taken before and after the read.
- **`src/display/catalog.ts` + `policy.ts`** — one exhaustive catalog with `validateCatalog()`
  invariants, and a policy resolver that carries per-leaf provenance (`"default"` or the
  config path that last set it) through the documented
  agent-defaults → agent-family → agent-tool → project-defaults → project-family → project-tool
  order.
- **`src/display/motion.ts`** — a single unref'd interval, deterministic downgrade for
  `NODE_ENV=test`, `CI`, non-TTY, and `TERM=dumb`, and a subscriber set that self-heals when a
  callback throws.
- **Sanitization is applied at the render boundary**, not at the call sites, so every
  description field passes through control-character escaping and secret redaction regardless
  of which adapter produced it.
- **Built-in overrides are factory-faithful**: definitions are recreated from the Pi 0.80.6
  public factories, only `renderShell`/`renderCall`/`renderResult` are replaced, the exact
  active-tool list is restored, and the `pi-tool-display` global marker hard-blocks all
  overrides. No `registerTool` monkey-patching, no private Pi APIs.

---

## Findings

### H-1 — Every specialized tool renderer is silently overridden and is now dead code

**Severity: High · Architecture / maintainability · Violates a rule added by this commit**

`decorateToolDefinition` (`src/display/tool-renderer.ts:131`) returns
`{ ...definition, renderShell: "self", renderCall() {...}, renderResult() {...} }`. The spread
runs first, so the definition's own renderers are unconditionally replaced. Every registrar in
`src/index.ts:44-57` now passes `() => display.runtime`, so the decoration always applies in
the parent session.

Every pi-square tool still declares its specialized renderers, and all of them are now unreachable:

```
src/github/tools.ts:310,465,578,705      src/web/tools/{search,fetch,libs,docs,parse}.ts
src/subagents/tool.ts:189,294            src/search/tools/{rg,fd,sg}.ts
src/ssh/tool.ts:359                      src/shell/tools/pwsh.ts:260
src/codegraph/tool.ts:489                src/pdf-search/tool.ts:232
src/todo/index.ts:216                    src/ask-user/index.ts:260
```

Proof *(measured)* — registering through the production wiring:

```
subagent_delegate | renderShell: self | renderCall === renderSubagentCall: false
subagent_resume   | renderShell: self | renderCall === renderSubagentCall: false
```

**Scale:** ~3,063 lines across twelve `render.ts` modules
(`ask-user`, `codegraph`, `github`, `pdf-search`, `scheme`, `search`, `shell`, `ssh`,
`subagents`, `todo`, `web/shared`, `web/tools/context7-render`) plus ~2,361 lines of tests
that still pass because they call the renderer functions directly.

**Contract conflict.** `AGENTS.md`, as amended *by this commit*, states:

> Do not patch ordinary user/assistant message components, introduce a second required
> palette, **retain native/legacy renderer branches**, or let child tool construction require
> a parent display runtime.

`docs/plans/2026-08-04-deep-tui-display-redesign.md` steps 4–10 called for *migrating* these
surfaces. The commit decorated over them instead.

**Note on the `runtime ? decorate(...) : definition` ternary.** That branch is legitimate and
required — child tool construction must not need a parent runtime, and
`tests/display/remote-agent.test.mjs` asserts `child.renderShell !== "self"`. The problem is
the retained *renderer bodies*, not the conditional.

**Required action:** either delete the legacy renderer modules and the `renderCall`/
`renderResult` fields from the definitions (converting any content worth keeping into
declarative descriptions), or state explicitly in `AGENTS.md` that legacy renderers are
retained as the child-session presentation and adjust the rule. The current state is the worst
of both: maintained, tested, documented code that never runs.

---

### H-2 — Subagent tool output loses live text, ACTIVITY, and agent identity, and reports a false state

**Severity: High · Functional regression · Contradicts `README.md` and `AGENTS.md`**

Consequence of H-1 applied to `src/subagents/render.ts` (712 lines). The generic
`createAdapter("subagent_delegate", "agent")` in `src/display/internal-adapters.ts:150` never
reads `details.timeline`, never reads `details.liveText`, and never sets `target`.

Rendered output for a running foreground child *(measured, width 80)*:

```
⠹ Subagent                                                                  4.2s
  phase=running
  Completed
```

versus the now-unreachable `renderSubagentResult` for the same input:

```
scanning repository for candidates
found 3 matches
```

Three separate defects visible in three lines:

1. **`Completed` is false.** `summaryRows()` (`internal-adapters.ts:136`) falls back to
   `"Completed"` whenever no count, message, or `returned` field matched — even when
   `details.phase === "running"`. The UI asserts completion for work still in progress.
2. **No live streaming.** With the default `resultMode: "summary"`, `components.ts:208`
   evaluates `showPreview = isCall || expanded || resultMode === "preview"` — all false during
   a partial result — so the child's live text is suppressed entirely.
3. **No agent identity, no ACTIVITY.** `describeResult` returns only `summaryRows` metadata;
   the role, short ID, and the child's tool-call timeline are gone.

`AGENTS.md` requires "ACTIVITY, manager, and the subagent status row must consume one shared
allowlisted tool-call formatter". After this commit only the manager and the status row do;
ACTIVITY no longer exists on the tool surface.

`README.md` (unchanged in this area) still promises "the result updates at approximately
100 ms intervals … renders the last five visual lines of live Markdown … responsive activity
ledgers" and the glyph vocabulary "`→ running`, `✓ done`, `✗ error`, `— queued`, `× aborted`".
Production now shows braille spinner frames and `✓ ! × –` and none of the live content.

---

### H-3 — Result rows lose the tool target and all argument metadata

**Severity: High · Usability regression · Inconsistent with the built-in adapter**

`createAdapter().describeResult` (`src/display/internal-adapters.ts:157`) omits `target`
entirely and replaces argument metadata with `summaryRows(result.details)`. The comparable
`resultDescription` for Pi built-ins (`src/display/builtins.ts:87`) *does* set `target`.

*(measured)*:

```
=== rg CALL ===                            === rg RESULT ===
⠋ Text search needle              0ms      ✓ Text search                     0ms
  pattern=needle · path=src                  status=ok

=== ssh CALL ===                           === ssh RESULT ===
⠋ SSH command                     1ms      ✓ SSH                             0ms
  operation=command · profile=prod           status=ok
  command=ls -la
```

Once a call settles, scrollback shows a column of identical `✓ Text search` / `✓ SSH` rows
with no indication of what was searched or executed. `tests/display/remote-agent.test.mjs`
only asserts the identity regex against the **call** phase, so this is uncovered.

**Suggested fix:** set `target: targetFor(name, context.args)` in `describeResult` and merge
the argument metadata, mirroring `builtins.ts`.

---

### M-1 — Broken backreference in `safeDiagnostic` redaction

**Severity: Medium · Correctness · Untested**

`src/display/builtins.ts:36`:

```ts
.replace(/(?:api[_-]?key|token|password|secret)\s*[=:]\s*\S+/gi, "$1=[REDACTED]")
```

The group is **non-capturing**, so `$1` has no referent and JavaScript emits it literally
*(measured)*:

```
input:  settings invalid: token=abc123 and api_key: zzz
output: settings invalid: $1=[REDACTED] and $1=[REDACTED]
```

The secret is removed (fails safe), but the key name is destroyed and a literal `$1` reaches
the banner, `/display`, and `ctx.ui.setStatus`. `safeDiagnostic` is exported through
`__testables` (`builtins.ts:285`) but has **no test**; `tests/display/conflicts.test.mjs`
asserts only on diagnostic routing.

**Fix:** `/((?:api[_-]?key|token|password|secret)\s*[=:]\s*)\S+/gi` → `"$1[REDACTED]"`, and add
a regression test.

---

### M-2 — `wordWrap` is a fully plumbed but inert configuration option

**Severity: Medium · Documentation accuracy**

`wordWrap` is declared in `DisplayPolicy`, defaulted in `DEFAULT_DISPLAY_POLICY`, listed in
`DISPLAY_POLICY_FIELDS`, accepted by the TypeBox schema (`src/core/config.ts:44`), resolved
with provenance (asserted in `tests/display/policy.test.mjs:178-259`), editable in `/display`
(`manager.ts:84`), and documented in `README.md`. No renderer reads it — `components.ts`,
`layout.ts`, and `diff.ts` always wrap. Setting `wordWrap: false` has no effect.

**Fix:** implement a non-wrapping (truncating) path in `wrapHanging`/`boundedVisualLines`, or
drop the field before the major release locks it into the public config contract.

---

### M-3 — Policy bounds duplicated in the manager, defeating the single source of truth

**Severity: Medium · Drift risk**

`src/display/types.ts` documents itself as the "single source of truth for policy bounds", yet
`src/display/manager.ts:249-255` re-declares them as literals:

```ts
const ranges: Partial<Record<DisplayPolicyField, readonly [number, number]>> = {
  previewLines: [1, 80], expandedMaxLines: [0, 20_000],
  diffSplitMinWidth: [70, 240], diffCollapsedLines: [4, 240],
};
const range = ranges[field]!;
```

Two problems: the values can drift from `DISPLAY_*_MIN`/`DISPLAY_*_MAX`, and the non-null
assertion throws `TypeError: Cannot read properties of undefined (reading '0')` for any future
non-enum policy field added without a matching entry. Import the constants and make the
missing-range case explicit.

---

### M-4 — `README.md` describes the pre-commit subagent presentation

**Severity: Medium · Documentation accuracy**

Beyond H-2, the subagent section retained these now-false claims: ~100 ms live updates, "last
five visual lines of live Markdown", the `→ running` / `— queued` glyph vocabulary, and
"responsive activity ledgers". `AGENTS.md` requires documentation to describe the repository as
it exists. Either restore the behavior (preferred, see H-2) or correct the section.

---

### Low-severity observations

| ID | Location | Issue |
|---|---|---|
| L-1 | `diff.ts` `emphasizePair` | Prefix/suffix comparison indexes UTF-16 code units, so `slice()` can split a surrogate pair or grapheme cluster and emit a lone surrogate for non-BMP content (emoji, CJK ext). |
| L-2 | `diff.ts` `classifyPatch` | `.filter((line) => line.length > 0)` drops zero-length patch lines, which can misalign a diff whose body contains a literal empty line. |
| L-3 | `config-write.ts` `tryReclaimStaleLock` | A lock file with an unparsable payload can never be reclaimed, permanently blocking `/display` saves. `DISPLAY_LOCK_TIMEOUT` does not name the lock path, so the user cannot find the file to remove. |
| L-4 | `sanitize.ts` `truncateCodePoints` | `Array.from(value)` materializes the entire string before capping. *(measured)* expanded preview render cost: 7.3 ms @ 64 KB, 22.1 ms @ 512 KB, 30.0 ms @ 2 MB. The default collapsed path is 0.1 ms and the 1 MB diff guard works correctly, so impact is confined to expanded views. A bounded scan removes it. |
| L-5 | `file-preview.ts` | No text/binary probe; a sub-1 MB binary file yields a projected write diff of escaped control characters. |
| L-6 | `tool-renderer.ts:168-176` | On the guarded early-return path in `describeCallAsync().then()`, `displayAsyncCallPending` is never reset, so preview hydration for that key can never be retried. |
| L-7 | `builtins.ts:36` vs `shell/index.ts:22` | Two divergent `safeDiagnostic` implementations, neither using `src/display/sanitize.ts`, contrary to the new "all pi-square-owned TUI surfaces use `src/display/` sanitization" rule. The shell variant also truncates on UTF-16 units. |
| L-8 | `tool-renderer.ts` `ensureMotion` | If `renderResult` never runs for a tool call, the motion subscription leaks for the remainder of the session. Bounded — `DisplayController.startSession` disposes the scheduler. |
| L-9 | `builtins.ts` `ownSource` | Returns `undefined` if none of the five probe tools are registered, which would mark every built-in as a false ownership conflict. Currently unreachable (all five register unconditionally), but the failure mode is silent. |
| L-10 | `manager.ts` `render` | `Math.max(10, Math.min(30, rows))` forces a 10-row panel on terminals shorter than 10 rows. |
| L-11 | `types.ts` | `DISPLAY_STATUSES` is frozen; `DISPLAY_RESULT_MODES`, `DISPLAY_DIFF_VIEWS`, `DISPLAY_DIFF_INDICATORS`, `DISPLAY_MOTIONS`, `DISPLAY_FAMILIES` are not. Cosmetic inconsistency. |

---

## Test-coverage assessment

The 27 new/updated display suites are thorough on the new module: policy precedence and
provenance, catalog invariants, sanitization, layout at 39/40/63/64/80/99/100/120 columns,
motion downgrade, adapter validation and descriptor restoration, config writer lock/CAS/stale
paths, and built-in conflict routing.

Two structural gaps:

1. **Fidelity gap (from H-1).** `tests/subagents/rendering.test.mjs`,
   `tests/github/rendering.test.mjs`, `tests/todo/rendering.test.mjs`,
   `tests/codegraph/rendering.test.mjs`, `tests/web/context7-rendering.test.mjs`, and
   `tests/ask/rendering.test.mjs` all call the legacy renderers directly. They pass, and they
   were touched by this commit (widening the width matrix), which makes them read as live
   coverage of shipped behavior. They are not. Every one of these suites should either move
   to the decorated definition or be deleted alongside its renderer.
   `tests/subagents/tool.test.mjs:107` is the clearest case: it asserts
   `tool.renderShell === undefined` on a wiring production never uses, where production
   produces `"self"`.
2. **Uncovered new code.** `safeDiagnostic` (M-1) is exported for testing but untested. The
   result-phase `target` omission (H-3) is uncovered because the identity assertion in
   `tests/display/remote-agent.test.mjs` applies only to the call phase.

---

## Contract compliance

| `AGENTS.md` rule | Status |
|---|---|
| Node 24 / Pi 0.80.6 runtime contract | Held — peer and dev deps unchanged at `0.80.6` |
| ESM-only, strict `tsconfig` | Held — `npm run typecheck` clean |
| Exports limited to `.`, `./display`, `./package.json` | Held — `package.json` map + `scripts/verify-pack.mjs` guard |
| Config validated at boundaries; V2 strict | Held — `validateConfigLayer` shared by loader and writer |
| Display precedence: agent defaults/family/tool → project defaults/family/tool | Held — `policy.ts:74-100`, covered by `tests/display/policy.test.mjs` |
| `/display` writes: canonical scope, lock/CAS, symlink/identity, complete-candidate validation, mode preservation, atomic rename, stale review, project trust | Held — `config-write.ts` |
| `footer.mode` deprecated, accepted, no runtime effect | Held — `config.ts` diagnostic + `PiSquareConfig.footer` removed |
| Built-in overrides factory-faithful, active list restored, no `registerTool` patching | Held — `builtins.ts` |
| Projected write preview: workspace-bounded, regular-file, 1 MB, TOCTOU, non-authoritative | Held — `file-preview.ts` + `PROJECTED PREVIEW` banner |
| Adapter v1 bounds (16 fields / 8 segments / 64 / 32 / 80 / queue 128); no auto-scan | Held — `public.ts` |
| Platform-exclusive shells; non-Windows bash owned by `display/builtins.ts` | Held |
| One session scheduler at 5/1/0 FPS; deterministic downgrade | Held — `motion.ts` |
| No secrets in rendering | Held — redaction centralized in `sanitize.ts`; SSH `prompt` masked, `data` excluded, subagent `systemPrompt` excluded |
| **"Do not retain native/legacy renderer branches"** | **Not held — H-1** |
| **ACTIVITY consumes the shared allowlisted formatter** | **Not held — H-2** |
| Documentation describes the repository as it exists | **Not held — M-2, M-4** |
| Defect fixes have regression tests; contract changes have contract coverage | Partially held — see coverage gaps |
| `THIRD_PARTY_NOTICES.md` synchronized | N/A — no dependency, binary, or WASM change |
| One changeset at the correct level | Held — `major`, correct for the removed `footer.mode` runtime effect, the bash ownership move, and the new `exports` map |

---

## Recommended follow-ups, in order

1. **Resolve H-1.** Decide between "migrate and delete" and "retain for child sessions", then
   make `AGENTS.md`, the affected definitions, and the tests agree. Everything else in this
   list is downstream of that decision.
2. **Restore subagent presentation (H-2).** At minimum give `subagent_delegate` /
   `subagent_resume` an `InternalToolDisplayAdapter` that reads `details.timeline`,
   `details.liveText`, `details.agent`, and `details.phase`, and fix the unconditional
   `"Completed"` fallback in `summaryRows` so a non-terminal `phase` never claims completion.
3. **Set `target` and argument metadata in `describeResult` (H-3)**, with a result-phase test.
4. **Fix the `$1` backreference (M-1)** and add the missing `safeDiagnostic` test.
5. **Decide `wordWrap` (M-2)** — implement or remove *before* the major release fixes the
   public config surface.
6. **Import the bound constants in `manager.ts` (M-3)** and remove the `!` assertion.
7. **Correct the `README.md` subagent section (M-4)** once (2) lands.
8. Sweep the low-severity list; L-1, L-3, and L-6 are the ones with user-visible failure modes.

## Manual verification still outstanding

Per `docs/plans/2026-08-04-deep-tui-display-redesign.md`, the following cannot be evidenced
from this Linux environment and are **not** covered by the passing gates:

- Real TUI exercise of `/display`, footer, banner, todo widget, ask wizard, subagent
  manager/notification/status, SSH secure input, shell streaming, diff expansion, and motion
  downgrade under tmux and SSH.
- Windows validation with PowerShell 7 and Windows PowerShell 5.1, covering shell streaming and
  cancellation, `/display` lock and rename cleanup, workspace/symlink preview paths, and
  platform-exclusive registration.
