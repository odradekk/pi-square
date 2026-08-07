---
"@odradekk/pi-square": minor
---

Migrate Firecrawl PDF parsing and upload confirmation to the operational interface.

Firecrawl parse already shared display integration through `createRemoteAdapter`. This closes the metadata, lifecycle, and summary gaps found during review:

- **Metadata duplication fixed**: `max_tokens` (raw arg-key) appeared alongside `maxTokens` (renamed) in the header. Added `max_tokens` to `REMOTE_SUPPRESS` for parse.

- **Declined lifecycle fixed**: parse's `declined()` returns `status: "declined"` without `isError: true`. Previously fell through to "success" (✓) in `statusFor`. Added `"declined"` to the aborted-status mapping so it renders as × (user chose not to upload).

- **Aborted lifecycle fixed**: parse's `failure()` sets `isError: true` even for aborted results. The base adapter's `statusFor` checks `isError` first and returns "error" (✗), overriding "aborted". Added `remoteLifecycle()` override that sets `lifecycle: "aborted"` explicitly when `name === "parse" && isError && details.status === "aborted"`, so `resolveOperationalState` renders × before the error-force bridge fires. Scoped to parse only; all other remote tools are unchanged.

- **Summary enriched**: Added parse-specific fields — `uploaded` (uploadBytes as human-readable size, privacy-relevant: shows how much data left the workspace), `sourceSize` (sourceBytes), and `errorCode` (muted tone for diagnostics). Token budget (`tokens=estimated/maxTokens`) already worked via the shared `estimatedTokens`/`maxTokens` detection.

Model-facing schemas, execution behavior, confirmation content, cancellation semantics, privacy budgets, and security boundaries are unchanged.
