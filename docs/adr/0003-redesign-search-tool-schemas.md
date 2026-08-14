---
status: accepted
---

# Redesign search tool schemas

The `rg` and `fd` tools had grown parameter schemas that mixed rarely used options with core search controls. The previous `rg` schema was already reduced to seven fields; this ADR records the complete redesign that finishes that work for both tools and adds a `filesOnly` mode to `rg`.

## rg: 8-field schema with filesOnly

The final `rg` schema is eight fields: `pattern` (required), `path`, `globs`, `literal`, `context`, `filesOnly`, `offset`, `limit`.

- `filesOnly` is a new boolean. When true, `rg` returns file paths with match counts instead of individual match lines. The tool feeds the full match stream through the accumulator without early-stop so every matching file is counted, then pages the file list with `offset`/`limit`. The result detail uses `RgFileOnlyDetail` (path, encoding, optional rawBase64, matchCount) instead of `RgFileDetail` (path, lines, continuation).
- Smart case (`-S`) remains a fixed wrapper flag, and `context` remains symmetric (the accumulator receives the same value for `beforeContext` and `afterContext`).
- The `limit` maximum stays at 25 (lowered from 100 in the prior reduction).

## fd: 8-field schema with StringEnum

The final `fd` schema is eight fields: `pattern` (optional, regex only), `path`, `excludeGlobs`, `types`, `extensions`, `maxDepth`, `offset`, `limit`.

Removed parameters and their replacements:
- `case` — smart case is now the only mode; use inline regex flags if needed.
- `matchMode` — `fd` is regex-only now. Glob and fixed-string matching are removed; a model can use `rg` with `literal=true` for literal text or `globs` for pattern inclusion.
- `hidden` / `noIgnore` — use a more specific `path` or rely on the project's standard ignore behavior.
- `minDepth` — use a narrower `path`.

The `types` array items use `StringEnum` from `@earendil-works/pi-ai` instead of `Type.Union` with `Type.Literal`. `StringEnum` produces `{ type: "string", enum: [...] }`, which is compatible with Google's API and other providers that do not support `anyOf`/`const` patterns.

## Dead constants removed

`DEFAULT_PATH`, `DEFAULT_FD_PATTERN`, `DEFAULT_CASE`, and `DEFAULT_FD_MATCH_MODE` were dead constants referenced only by the removed parameter types. They are deleted along with the `CaseMode` and `FdMatchMode` type aliases. `MAX_LIMIT_RG` (25) is the rg-specific limit bound.

## Considered Options

- **Keep the old fd parameters behind deprecation.** Rejected: the parameters complicate the schema for models, carry security considerations (`hidden` and `noIgnore` can scan large directories), and a breaking major version is the correct release boundary.
- **Split `filesOnly` into a separate tool.** Rejected: it shares the same argument construction, binary resolution, and execution path as `rg`. A boolean flag keeps one definition, one catalog entry, and one display adapter, with the accumulator selecting the output format.
- **Use `Type.Union` for fd `types` instead of `StringEnum`.** Rejected: the project rule requires provider-compatible schemas. `StringEnum` avoids `anyOf`/`const` patterns that some providers do not support.

## Consequences

- Models that previously called `rg` with `case`, `word`, `includeGlobs`, `excludeGlobs`, `types`, `beforeContext`, `afterContext`, `hidden`, `noIgnore`, or `maxDepth` will get validation errors on those removed parameters.
- Models that previously called `fd` with `case`, `matchMode`, `hidden`, `noIgnore`, or `minDepth` will get validation errors.
- The `fd` matchMode removal means `fd` no longer supports glob or fixed-string matching directly; `rg` with `globs` or `literal=true` covers those use cases.
- The display adapters and display catalog entries are updated to read only the new fields.
