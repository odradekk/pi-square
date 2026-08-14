---
status: accepted
---

# Retire low-usage tools

In the 7.0 release, pi-square will retire the `sg`, `scheme`, and `time` tools. Each was used rarely, and a breaking release is the right moment to remove them rather than carry their cost further.

`sg` and `scheme` are retired under the stronger rule: a tool goes when it has low real usage **and** it carries a security-sensitive native dependency or vendored asset. `sg` pulls the `@ast-grep/cli` platform packages, about 150 MB installed per consumer; `scheme` ships 13 MB of vendored Chez Scheme WASM assets inside the published tarball. That combination makes the cost recurring while the benefit stays occasional.

`time` is retired under the simpler rule: low real usage with no unique capability. A parent session already has a shell and can read the current date without a dedicated tool, so `time` adds only a catalog entry, a display adapter, and tests for that negligible value.

## Considered Options

- **Keep the code dormant** (registered source, removed from the catalog). Rejected: it keeps every cost that motivated the retirement — the dependency, the shipped bytes, and the documented rules — while the test coverage of unused code decays.
- **Deprecate for one major version.** Rejected: a definition that names a retiring tool already fails its run loudly with the supported-tool list, so a deprecation period adds compatibility code without a clearer warning than the failure already gives.

## Consequences

- Structural (AST) search will be unavailable. `codegraph` covers semantic questions and `rg` covers text; neither matches a syntax pattern.
- No sandboxed evaluator will remain. The parent shell and the `shell` capability of `generalist` are the substitutes, and the read-only roles have none.
- No tool will report the current date. A parent session can read it through its shell — `bash` on non-Windows, `pwsh` on Windows — while the read-only roles have no shell.
- A retired name stays invalid rather than becoming an alias, following the `scheme_eval` precedent. A user-owned subagent definition that still lists `sg` or `scheme` will fail its next run with a non-retryable `INVALID_ARGUMENT` error, including the resume of a persisted child.
