---
status: accepted
---

# Consolidate the model-facing tool namespace

The GitHub-tool portion of this decision is superseded by ADR-0015. The `delegate` and `resume` naming decision — and with it the `fg`/`bg` execution-mode vocabulary this ADR's tool split assumed — is superseded by ADR-0016: the tools are `delegate_subagent` and `resume_subagent`, and background is the only execution mode. ADR-0016 also records why the two-tool split itself survives the rename.

The model-facing tool surface had four github tools (`github_search`, `github_read`, `github_tree`, `github_commit`) and two long subagent tool names (`subagent_delegate`, `subagent_resume`). Every registered schema costs context budget, and the six names together consumed more of that budget than the work they describe warrants.

## Decision

Merge the four github tools into one `github` tool with a required `operation` discriminator (`search`, `read`, `tree`, `commit`). Per-operation field filtering silently discards fields the current operation does not use, so the OpenAI Responses API behavior that populates every declared schema property with non-blank values does not break calls. Each operation's own validation still catches genuine input errors.

Rename `subagent_delegate` to `delegate` and `subagent_resume` to `resume`. The two tools remain separate because the resume-only `id` field must not appear in the delegate schema — GPT models populate every declared property, which would trip the fg/bg validation.

Retire all six old names completely with no aliases. A definition or call that names a retired tool fails its next run with the supported-tool list.

## Why merge github but keep delegate/resume split

The project rule splits a branch into its own tool when a branch-specific field must not appear in sibling branches at all. The resume-only `id` is exactly that case: `delegate` must reject it, and the Responses API populates every declared property, so a shared schema that declares `id` makes `delegate` unusable for those providers.

No github field has this conflict. The `operation` discriminator selects the branch, and the merged schema declares all operation-specific fields as optional. Per-operation field filtering (`ALLOWED_FIELDS`) silently discards any field the current operation does not use, before blank-as-unset removal of empty strings and zeros. A provider that populates every property sends values for unused fields; those are discarded without error. Each `execute*` function's own validation still rejects genuine input errors such as an empty query or an invalid repository name.

## Trade-offs accepted

1. **Loss of catalog granularity.** The four github tools had independent display catalog entries, display adapters, and tool-catalog entries. The merge replaces them with one entry each. Child definitions that previously selected a subset (search-only, read-only) now get all-or-nothing github access. The bundled Librarian profile uses all four operations, so this is not a loss in practice for the shipped roles.

2. **The bare name `resume` shares its word with Pi's session-resume feature.** The tool description and its schema (`id` + `task`) disambiguate for the model; the `/subagent` manager name and the subagent domain concept are unchanged.

## Precedents

- **ADR-0002** (retire low-usage tools): established the retirement mechanic — delete the code, catalog entry, and documented rules; a retired name stays invalid rather than becoming an alias.
- **ADR-0003** (redesign search tool schemas): established schema-budget discipline and the `StringEnum` pattern for provider-compatible discriminator fields, which the `operation` field reuses.
