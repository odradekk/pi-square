---
status: accepted
---

# Retire the vendored search tools

In the 11.0 release, pi-square retires the `rg` and `fd` extension tools and
deletes the `bin/` directory that vendored their executables. Local text search
and file discovery become the responsibility of Pi's own built-in `grep` and
`find` tools, which pi-square continues to re-register only to apply the shared
operational display.

The retirement follows the ADR-0002 rule: a tool goes when it has low unique
value **and** it carries a security-sensitive vendored asset. Pi 0.84.2 exposes
`createGrepToolDefinition` and `createFindToolDefinition` as public factories,
so the wrappers no longer supply a capability that the platform lacks, while
`bin/` costs 46 MB of Git-tracked, security-sensitive binaries in every consumer
install.

## Supply model

This ADR deliberately reverses the rule that ADR-0003 and the former `src/search/`
module recorded: "`rg` and `fd` use Git-tracked binaries without PATH fallback".
Pi resolves the executables in the opposite way — its own tools directory, then
`PATH`, then a download of the current release from `api.github.com` and
`github.com` on first use, with no pinned version. That model is accepted here
as the cost of removing the vendored assets, and it is the substantive
trade-off of this decision rather than an implementation detail.

## Considered Options

- **Retire `rg` only and keep `fd`.** Rejected: Pi's `find` is weaker than `fd`
  (3 fields against 8), so keeping `fd` would preserve the whole cost that
  motivated the retirement — the `bin/` directory, its six platform targets, its
  notices, and its resolution code — to save one filter set.
- **Keep a reduced pi-square tool for the gap fields.** Rejected: the same cost
  argument applies, and the gaps (`filesOnly`, `offset`, multiple globs,
  `types`, `extensions`, `maxDepth`, `excludeGlobs`) are paging and filtering
  conveniences rather than capabilities that no other tool can reach.
- **Alias the retired names to `grep` and `find`.** Rejected: the schemas are
  not equivalent, and ADR-0002 already set the precedent that a retired name
  stays invalid rather than becoming an alias.
- **Deprecate for one minor release before removal.** Rejected: a definition
  that names a retiring tool already fails its run loudly with the supported-tool
  list, so a deprecation period adds compatibility code without a clearer warning.

## Consequences

- Text search and file discovery lose `filesOnly` (file paths with match
  counts), `offset` paging, and multiple/negated globs; file discovery
  additionally loses `types`, `extensions`, `maxDepth`, and `excludeGlobs`. Pi's
  `grep` adds `ignoreCase`, which the retired `rg` did not expose.
- Search is unavailable where neither executable is present and GitHub is
  unreachable: `PI_OFFLINE=1`, air-gapped or proxy-restricted machines, and
  Android/Termux, where Pi never downloads. Such an environment must install
  ripgrep and fd through its own package manager.
- The published package drops from about 46 MB of vendored binaries to roughly
  1.5 MB unpacked, and `scripts/verify-pack.mjs` tightens its limits to 1 MiB
  compressed and 4 MiB unpacked. The repository vendors no executable at all.
- `explorer`, `oracle`, and `generalist` declare the built-in `grep` and `find`
  capabilities instead of the retired extension tools. A user-owned agent or
  project definition that still lists `rg` or `fd` fails its next run, including
  the resume of a persisted child, with a non-retryable `INVALID_ARGUMENT`
  error, following the ADR-0002 precedent.
- The display catalog keeps its independent `grep` and `find` entries, so the
  built-in rendering path is unchanged. `src/display/search-adapters.ts` remains
  in service for `pdf_search` and `codegraph`, with the rg/fd branches removed.
- ADR-0003, which defined the eight-field `rg` and `fd` schemas, is superseded.
