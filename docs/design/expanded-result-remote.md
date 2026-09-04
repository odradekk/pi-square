# Remote Expanded Results

Scope: `search`, `fetch`, `libs`, `docs`, `parse`, `ssh`
Parent tools: all seven. Child availability follows the existing catalog: `parse` and `ssh` remain parent-only.
Primary family contract: remote identity and provenance first, bounded remote content second, failures and retries explicit.

## Shared remote grammar

Expanded remote results use this order:

1. Error, auth, confirmation, cancellation, or incomplete state.
2. Request identity and safe query metadata.
3. Result summary, rate/truncation/redirect/retry state.
4. Grouped remote records, page content, repository content, or terminal output.
5. Bounded provider diagnostics.

No API key, PAT, bearer token, or auth header is rendered. URL display neutralizes unsafe schemes and preserves only validated HTTP(S) links.

## search

Expanded sections:

- `ERROR` for missing key, abort, provider, or network failures.
- `QUERY`: all queries, site/language/country filters, cache mode, and limit.
- `SUMMARY`: before/after deduplication, returned count, omissions, and failed query count.
- `RESULTS`: ranked records with title, URL, description, and provenance token.
- `FAILURES`: per-query bounded errors.

Rules:

- Provenance tokens remain visible because they are model-relevant.
- Provider-authored links are sanitized before display; only safe HTTP(S) values remain link-like.
- Partial query failure is a warning section, not a silent omission.

## fetch

Expanded sections:

- `ERROR` for missing key, invalid URL, abort, provider, or network failures.
- `REQUEST`: URL list, readable/full mode, token budget, cache, links, and images flags.
- `SUMMARY`: succeeded, failed, retried, redirect, and truncation counts.
- `PAGES`: per-page sections with title, URL, final URL, description, token/line metadata, and bounded Markdown body.
- `FAILURES`: failed URL records with retry state and bounded error.

Rules:

- Page order follows input order, including failures.
- The structured page offsets remain authoritative for body extraction.
- Thin-content browser retry is visible as metadata, not as hidden mutation of source.
- Unsafe source-authored links are neutralized in display copies only.

## libs

Expanded sections:

- `ERROR` for missing key, abort, provider, or validation failures.
- `QUERY`: library name, query, mode, limit, and search filter state.
- `SUMMARY`: candidate counts, omissions, and provider rank preservation.
- `CANDIDATES`: ranked records with Context7 ID, title, description, benchmark, source reputation, and code-snippet count where available.
- `SOURCES`: validated source records for candidates that expose them.

Rules:

- Context7 IDs remain exact and visually prominent because they are the input to `docs`.
- Invalid provider candidates remain omitted from model and display data.
- Aggregate pressure and omission counts are visible in metadata.

## docs

Expanded sections:

- `ERROR` for missing key, invalid ID, abort, provider, or validation failures.
- `REQUEST`: library ID, query, mode, kind, and local token budget.
- `SUMMARY`: ready/pending state, redirect, snippet counts, and omissions.
- `RULES`: opaque provider rule text in bounded order.
- `CODE`: code snippets with title, token count, language label, and bounded code block.
- `DOCUMENTATION`: info snippets in bounded order.

Rules:

- Code fences use a fence longer than any embedded backtick run and sanitize metadata.
- Provider token counts are not trusted as the only bound; local serialized budgets remain authoritative.
- `202 pending` is a partial state, not a success result.

## parse

Expanded sections:

- `ERROR` for missing key, cancellation, invalid PDF, page bounds, provider, or network failures.
- `REQUEST`: workspace-relative path, sorted pages, mode, timeout, and local token budget.
- `CONFIRMATION`: fixed Firecrawl destination and standard-retention consequence when declined or pending.
- `SUMMARY`: page count, lines, truncated/incomplete/warning state, and remote metadata.
- `MARKDOWN`: bounded parsed Markdown body.
- `DIAGNOSTICS`: one stable HTTP/error code and redacted bounded message.

Rules:

- Confirmation remains required before any upload and is serialized through the parent FIFO coordinator.
- Only the sorted unique selected pages are sent; the display must not imply full-document upload.
- ZDR remains disabled and the standard data-handling consequence stays explicit.
- The tool remains parent-only and absent from child catalogs.

## ssh

Expanded sections:

- `ERROR` for unavailable profile/target, host-key mismatch, auth, transport, channel, or session failures.
- `OPERATION`: operation, profile, target, label, session, cursor/wait metadata, and command identity.
- `CONNECTION`: fingerprint verification, authentication method, limits, and connected/disconnected state.
- `OUTPUT`: bounded latest-visible terminal output for command/read operations.
- `SESSIONS`: bounded session records for list.
- `SECURITY`: endpoint confirmation, secret-input use, and cursor expiry/truncation notices.

Rules:

- Host fingerprint and auth details show method/state, never key material, passphrases, passwords, or masked input.
- Terminal output applies the existing raw-cursor accounting and latest-visible projection; this is not full-screen emulation.
- Connected sessions run commands without per-command confirmation; alternate endpoint confirmation remains once per parent session.
- `parse`-style child exposure is unchanged: SSH remains parent-only.

## Remote regression cases

- Provider error text strips controls and redacts current and previous keys.
- Unsafe URLs never become clickable.
- `parse` cancellation before confirmation performs zero upload.
- SSH command output retains latest visible state after carriage-return progress updates.
- All expanded results remain bounded at 39/40/63/64/80/99/100/120 columns.
