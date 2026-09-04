---
"@odradekk/pi-square": major
---

Retire the `codegraph` and authenticated `github` extension tools

- The `codegraph` and `github` tools are removed completely: no parent registration, no child catalog entry, no Shadow-safe catalog entry, no display adapter, no alias, and no compatibility renderer for persisted calls in resumed sessions. Both names are now Retired tools: a subagent definition that requests either one fails through the ordinary unsupported-extension-tool error with the supported-name list.
- The `@colbymchenry/codegraph` runtime dependency and its six platform packages are removed, along with the `eval:codegraph` command and the now-unused bounded process runner in `src/core/`.
- User-owned `.codegraph/` index data is not deleted, migrated, or inspected; the existing Git ignore rule is retained as legacy data so an upgrade never exposes a large untracked directory. Deleting that data remains each user's decision.
- The visible bundled subagent catalog is reduced to `explorer`, `generalist`, and `crawler`; the bundled `oracle` and `librarian` definitions are removed while the hidden `example_profile` reference definition is retained with an empty extension-tools example. Agent and project overlays remain free to define roles named `oracle` or `librarian`.
- `explorer` and `generalist` lose `codegraph` with no replacement; `crawler` loses only the sentence that delegated repository research to the bundled Librarian and keeps its public-web scope, including public GitHub pages through `search` and `fetch`.
- General-purpose credential and PAT-shaped redaction is unchanged.
