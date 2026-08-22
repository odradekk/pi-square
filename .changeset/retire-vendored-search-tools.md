---
"@odradekk/pi-square": major
---

Retire the `rg` and `fd` tools and the vendored `bin/` binaries

Local text search and file discovery now use Pi's built-in `grep` and `find`
tools, which pi-square re-registers only to apply the shared operational
display. The `rg` and `fd` extension tools, the `src/search/` module, and the
46 MB `bin/` directory with its six platform targets are removed, so the
package no longer vendors any executable.

This is a breaking change. A subagent definition that lists `rg` or `fd` in
`extensionTools` fails its next run, including the resume of a persisted child,
with a non-retryable `INVALID_ARGUMENT` error; the retired names are not
aliased. Replace them with the built-in `grep` and `find` capabilities in
`tools`. The bundled `explorer`, `oracle`, and `generalist` roles are migrated.

Search now depends on Pi's own executable resolution (its tools directory, then
`PATH`, then a GitHub release download), so search is unavailable in an offline
or proxy-restricted environment that has neither executable, including a session
started with `PI_OFFLINE=1` and Android/Termux. The retired schemas also drop
`filesOnly`, `offset` paging, multiple globs, `types`, `extensions`, `maxDepth`,
and `excludeGlobs`; Pi's `grep` adds `ignoreCase`. See ADR-0010, which supersedes
ADR-0003.

The published tarball drops to roughly 1.5 MB unpacked, and the packaging check
tightens to 1 MiB compressed and 4 MiB unpacked.

Note on test coverage: by maintainer decision this change adds no new test. The
retirement is covered only by the updated tool enumerations in
`tests/contract.test.mjs`, `tests/smoke.mjs`, and
`tests/subagents/tool-policy.test.mjs`, which now assert the absence of `rg` and
`fd`. No dedicated regression test asserts the `INVALID_ARGUMENT` refusal of the
retired names, which deviates from the usual contract-coverage requirement in
`AGENTS.md`.
