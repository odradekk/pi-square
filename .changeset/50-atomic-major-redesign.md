---
"@odradekk/pi-square": major
---

Atomic major redesign: Claude-like operational interface across all display surfaces.

This single atomic major release replaces the entire internal display model, persistent chrome, and interactive workflow presentation with one coherent, renderer-owned Claude-like operational interface. No published version retains the old visual grammar, legacy internal renderer route, or old/new dual stack.

## Breaking changes

**Internal display model contracted to lifecycle:**
- Removed the flat `DisplayStatus` type (`pending`, `partial`, `success`, `warning`, `error`, `aborted`), the `resolveOperationalState`/`bridgeStatus` compatibility bridge, `OperationalContext`, `STATUS_FRAMES`, `PENDING_FRAMES`, `PARTIAL_FRAMES`, all flat-status frame constants, `STATUS_TOKENS`, and `styleStatus`.
- `DisplayDescriptionV1.status` field removed; `lifecycle` is now the required operational-state field.
- Every production adapter (internal-adapters, builtins, public Adapter v1, subagents) sets lifecycle directly.

**Configuration migration:**
- The deprecated `diffIndicators` field is removed from the display schema; existing configurations containing it are detected and migrated through the `/display` review.
- `footer.mode` is deprecated, has no runtime effect, and is removed through the `/display` migration review.
- `motion: "reduced"` meaning changed from 1 FPS (1000 ms) to a 120 ms interval (~8.3 FPS).

**Theme color relationship:**
- Bundled dark and light themes tuned from cool blue-gray accents to Claude's rust-orange emphasis, with green success, red failure, and amber warning.

## Migration path

1. Open `/display`. If legacy configuration is detected, a migration review auto-opens.
2. Review the detected changes (diffIndicators removal, footer.mode removal, reduced-motion meaning change).
3. Approve to write one atomic canonical candidate, or decline to keep editing.
4. The canonical reader accepts legacy fields as migration input only; the runtime does not retain a permanent old/new dual stack.

## Preserved contracts

- **Public Adapter v1** retains its published API (`./display` entry point) and bridges directly into the canonical lifecycle model.
- **Model-facing schemas** are unchanged.
- **Execution functions, child tool exposure, security checks, mutation queues, and native-shell exceptions** are unchanged.
- **Canonical defaults** remain: preview with nine rows, unified diff, full motion at 34 ms intervals.

## Verification

- 46 display test suites pass, covering all 29 catalog tools across lifecycle states, result modes, and boundary widths.
- The full integration matrix covers widths 39/40/63/64/80/99/100/120 in bundled dark, light, and third-party themes.
- Sanitization, redaction, privacy budgets, output bounds, ownership conflicts, and session lifecycle are verified end to end.
- Type checking and smoke tests pass.
