---
"@odradekk/pi-square": minor
---

Migrate GitHub search, read, tree, and commit to the operational interface.

GitHub tools already shared display integration through `createRemoteAdapter`. This closes the error-marker, rate-limit, and summary-visibility gaps found during review:

- **Error marker fixed**: GitHub tools (`missingToken`, `invalidInput`, `failed`) set `details.errorCode` + `details.error` without `isError: true`, so they previously rendered as ✓ (success). Added `errorCode` detection in `statusFor()` so these render as ✗ (failed). Safe for all tools: pdf_search and parse always pair `errorCode` with `isError: true` (which fires first), codegraph uses `code` not `errorCode`, and search/fetch/libs/docs never use `errorCode`.

- **Rate limit enriched**: Changed from raw `rateRemaining=N` to `rate=N/M` (remaining/limit format). Added `retryAfter=Ns` for rate-limited responses. When `remaining === 0`, the rate field gets `error` tone.

- **Summary enriched**: Added GitHub-specific fields detected by field presence: `kind`, `sha`, `binary` (warning), `lines` (returnedLines/totalLines), `truncatedLines`, `author`, `verified`, `additions` (+N, success tone), `deletions` (-N, error tone), `changes`, `patches` (omitted count, warning), `requestBudget` (exhausted, warning), `hasMore`. Removed duplicate `remoteTruncated` field.

Model-facing schemas, execution behavior, result details, authentication boundaries, and security redaction are unchanged.
