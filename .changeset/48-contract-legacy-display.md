---
"@odradekk/pi-square": minor
---

Contract the legacy internal display model to the canonical lifecycle.

Removes the flat `DisplayStatus` compatibility contract and the `resolveOperationalState`/`bridgeStatus` bridge that converted it to lifecycle+qualifiers. Every production adapter now resolves directly through the canonical lifecycle-plus-qualifier model.

**Removed (dead code):**
- `DisplayStatus` type, `DISPLAY_STATUSES`, `STATUS_FRAMES`, `PENDING_FRAMES`, `PARTIAL_FRAMES`, and all flat-status frame constants from `src/display/types.ts`
- `resolveOperationalState` function and `bridgeStatus` internal — the compatibility bridge
- `OperationalContext` interface — only consumed by the bridge
- `STATUS_TOKENS` and `styleStatus` from `src/display/theme.ts` — unused in production

**Changed:**
- `DisplayDescriptionV1.status` field removed; `lifecycle` is now the required operational-state field
- `internal-adapters.ts` `statusFor` replaced with `resolveResultLifecycle` returning lifecycle+qualifiers directly
- `subagents/display-adapter.ts` `statusFor` removed; all descriptions set lifecycle directly
- `public.ts` Adapter v1 maps its fields directly to lifecycle (no flat-status intermediary)
- `tool-renderer.ts` `applyRuntimeFields` simplified — no bridge call, `forceError` overrides lifecycle to `"failed"` (preserving `"aborted"`)
- `components.ts` `resolveState` reads lifecycle directly; result-mode gating uses lifecycle predicates
- Stale compatibility-bridge comments updated throughout adapter files

**Tests updated** to use lifecycle directly instead of flat status. The obsolete compatibility-bridge section in `operational-state.test.mjs` is replaced with direct lifecycle assertions.

The contraction does not modify model-facing schemas, execution functions, child tool exposure, security checks, mutation queues, or native-shell exceptions. Public Adapter v1 retains its published API.
