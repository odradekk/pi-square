---
"@odradekk/pi-square": minor
---

Migrate local PDF search to the Claude-like operational interface.

`pdf_search` already shared most of its display integration with the other structural search tools (rg/fd/sg) from earlier migrations: exact-versus-fuzzy match rendering with ranked page numbers and bounded context, the workspace-relative path and query surfaced as call target and header metadata, and a confirmed-empty "No matches" state. This migration closes the remaining gaps found during review:

- Cancelled PDF searches now render the distinct aborted (`×`) marker instead of the failed (`✗`) marker. `pdf_search` models cancellation as a first-class `details.status === "aborted"` outcome (like CodeGraph), and the shared runtime's error-safety override previously always forced the failed marker whenever a result carried `isError: true`, which every pdf_search failure does. A new lifecycle override, verified against `tool.ts`'s error-code mapping to confirm it can never downgrade a genuine hard failure, bypasses that override for the aborted case only.
- The document page count and result budget (whether more matching pages exist beyond the returned/limit-bounded set) are now visible in the expanded result summary, alongside the existing cache-hit and match-count fields.

Distinct rendering for empty matches, textless documents, encrypted documents, oversized or over-page-limit PDFs, timeouts, PDF.js resource-resolution failures, and changed-file consistency errors was already covered by the shared error/errorCode display path; each error code already produces a unique, sanitized message with no partial match content. Model-facing schemas, execution behavior, cancellation semantics, and security boundaries are unchanged.
