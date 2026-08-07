---
"@odradekk/pi-square": minor
---

Migrate Jina web search and fetch to the Claude-like operational interface.

Web search and fetch already shared display integration through the generic `createRemoteAdapter` (Request/Summary/Results sections, lifecycle via compatibility bridge). This migration closes the display bugs found during review:

- **Header metadata duplication fixed**: the base adapter's generic `metadataForArgs` and the remote adapter's `requestFields` independently computed overlapping fields. For search, `queries`/`limit` appeared twice; for fetch, raw arg-key labels (`max_tokens`, `include_links`, `describe_images`, `no_cache`) appeared alongside their human-readable counterparts (`maxTokens`, `links`, `images`, `cache`). New `mergeMetadata` with label-based dedup and a `REMOTE_SUPPRESS` set for raw-key labels eliminates the duplication.

- **Error text triplication fixed**: the dedicated ERROR section duplicated both the Output section and `description.error`. The ERROR section is removed; `description.error` is the sole carrier when `isError: true`. When `isError` is false but `details.error` exists (the actual search/fetch tool behavior for cancellation, timeout, and provider failures — these tools never set `isError: true`), a compact warning-styled Result section now carries the message visibly, preventing a silent information-loss regression.

- **Request section source fixed**: uses `args` (not `{...args, ...details}`) so identity fields stay accurate to what the model requested.

- **Preview suppression corrected**: the raw text preview is suppressed when expanded (structured sections carry content) or when an error is present, and shown when collapsed without error (content visible alongside identity in the header).

Model-facing schemas, execution behavior, result details, cancellation semantics, and security boundaries are unchanged. The changes affect the shared `createRemoteAdapter` path, so sibling remote tools (libs, docs, parse, github_*, ssh) also benefit from the metadata dedup and error-section fixes.
