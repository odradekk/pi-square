---
"@odradekk/pi-square": patch
---

Unify the two strict YAML-subset definition parsers behind one shared reader (`src/core/yaml-subset.ts`, #370). Shadow Minds definition files and subagent definition files are still two formats with different layering semantics, but the structural layer — line scanning, indentation, map nesting, block and flow lists, and block-scalar body extraction with the only-lines-indented-past-the-field rule — now has exactly one implementation, read by both `src/shadow-minds/parser.ts` and `src/subagents/definitions.ts` (whose field-kind profile and scalar policy live beside the parser). The two formats keep their own policy on top: Shadow keeps its typed scalars and named rejections, and subagent definitions keep their field-kind table, clear markers, and scalar rules (inline comments, null spellings, quote stripping). Layering, discovery, and field validation semantics are unchanged. A differential probe of 195 definition texts against the previous parsers confirms every definition that loaded before still loads with the same fields, and reports differences only in the cases listed below.

Subagent definitions, tightened (previously accepted, now rejected; each now matches the `- item` spelling both references document):

- A `-item` line without the space after the dash no longer counts as a block-list item — neither to open a list nor after items started; the line reports as an unsupported YAML line. At the first position this rejection is unchanged; mid-list it replaces a silent misread.
- A column-zero `- ` item appearing after indented items is now rejected with the indentation message instead of being swallowed into the list, consistent with the column-zero rule the parser already reported at the start of a list.

Subagent definitions, loosened (previously rejected, now accepted):

- A whole-line `#` comment inside a block list no longer terminates the list — items on both sides of a comment line stay in the list, matching the documented whole-line-comment rule. A blank line before such a continuation is still the named blank-line-in-list error.

Subagent definitions, diagnostics on files that were already rejected:

- A nested mapping under a field (for example `instructions:` followed by an indented `a: b`) now reports the field's type error (`field 'instructions' must be a string or null`) instead of a generic `unsupported YAML line` per nested line.

Shadow Minds definitions:

- A file with several independent structural problems now names every one of them instead of stopping at the first, and a tabbed line can carry both its tab error and a structural observation. Valid definitions, including block lists that span blank lines and whole-line comments, load exactly as before.
