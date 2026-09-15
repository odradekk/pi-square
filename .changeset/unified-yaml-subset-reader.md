---
"@odradekk/pi-square": patch
---

Unify the two strict YAML-subset definition parsers behind one shared reader (`src/core/yaml-subset.ts`, #370). Shadow Minds definition files and subagent definition files are still two formats with different layering semantics, but the structural layer — line scanning, indentation, map nesting, block and flow lists, and block-scalar body extraction with the only-lines-indented-past-the-field rule — now has exactly one implementation, read by both `src/shadow-minds/parser.ts` and `src/subagents/definitions.ts`. The two formats keep their own policy on top: Shadow keeps its typed scalars and named rejections, and subagent definitions keep their field-kind table, clear markers, and scalar rules (inline comments, null spellings, quote stripping). Layering, discovery, and field validation semantics are unchanged, and every previously valid definition still parses to the same fields — a differential probe of 193 definition texts against the previous parsers reports differences only in the rejected-file diagnostics listed below.

User-visible diagnostic changes, all confined to files that were already rejected or to forms the references never documented:

- Subagent definitions: a nested mapping under a field (for example `instructions:` followed by an indented `a: b`) is now rejected with the field's type error (`field 'instructions' must be a string or null`) instead of a generic `unsupported YAML line` per nested line.
- Subagent definitions: a whole-line `#` comment inside a block list no longer terminates the list — comments are transparent everywhere, so items after a comment stay in the list, matching the documented whole-line-comment rule.
- Subagent definitions: a column-zero `- ` item appearing after indented items is now rejected with the indentation message instead of being swallowed as an item, consistent with the column-zero rule the parser already reported at the start of a list.
- Shadow Minds definitions: a file with several independent structural problems now names every one of them instead of stopping at the first, and a tabbed line can carry both its tab error and a structural observation.
