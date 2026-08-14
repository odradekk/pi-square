---
status: accepted
---

# Redesign the local search tool schemas

In the 7.0 release, pi-square will reduce the `rg` and `fd` parameter schemas to the fields that have the largest effect on the result, and remove the rest. The goal is a smaller model-facing surface that still covers every common search through a documented replacement.

`rg` goes from 15 fields to 8: `pattern`, `path`, `globs`, `literal`, `context`, `filesOnly`, `offset`, `limit`. `fd` goes from 13 fields to 8: `pattern`, `path`, `excludeGlobs`, `types`, `extensions`, `maxDepth`, `offset`, `limit`. Every removed parameter has a replacement the model can use: an inline regex flag `(?i)` for case, a `\b` boundary for word matching, a glob for the ripgrep file-type filter, and a narrower `path` for depth, hidden, and ignore control. The caller must name the path to reach hidden or ignored content; a repository-wide sweep that also walks `node_modules` or `.env` is deliberately not available, because that is the noisy case the bound exists to prevent.

Accuracy is preserved through the explicit `path` and inline regex flags. The result stays bounded by the existing paging contract, the 12,000-byte content budget, the 300-byte line-excerpt cap, and a lowered `rg` page maximum of 25 (from 100), because an `rg` page carries match text plus context while an `fd` page carries short paths. The `filesOnly` shape returns matching file paths with per-file counts instead of match text, giving the cheapest first exploration. The fixed wrapper flags (`--no-config`, `--json`, `--sort path`, `--color never`, `-S` for rg; `--print0`, `--color never` for fd) and the `--` separator stay, so no model value can become a command-line option.

## Considered Options

- **One `args` string with a free-form CLI call.** Rejected: it gives arbitrary command execution to roles whose tool list denies a shell (`fd -x`, `rg --pre`), and it breaks the NDJSON and NUL-delimited output contract that paging and budgets depend on.
- **One `args` string with a strict allowlist.** Rejected: the tokenizer, the per-flag arity table, and the injection tests are larger than the schema they delete, and the validation moves from provider-enforced JSON Schema into hand-written code that must be tested.
- **Merge `rg` and `fd` into one tool with a mode discriminator.** Rejected: the name `search` is taken by the web tool, `grep` and `find` are Pi built-in names, and the `types` field means two different things across the two tools (ripgrep file types versus entry kinds). The `AGENTS.md` schema rule also forbids a shared schema when a branch-specific field must be rejected by a sibling branch.

## Consequences

- A caller that needs case-insensitive search, word-boundary matching, or a file-type filter must express it in the pattern or the globs, not through a dedicated parameter.
- A caller that needs hidden or ignored content must name the path explicitly; there is no flag to broaden the sweep.
- The `filesOnly` shape has its own result type and display rendering, but obeys the same paging and budget rules.
