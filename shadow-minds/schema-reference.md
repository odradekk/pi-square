# Shadow Minds definition schema reference

Normative reference for Shadow definition files (#188). Every runtime claim
below is enforced by the strict parser (`src/shadow-minds/parser.ts`) and the
two-scope discovery (`src/shadow-minds/definitions.ts`); the structured
contract block and the embedded examples at the end of this file are
validated against that production code by contract tests.

## Format

One definition is one Markdown file: a YAML frontmatter block between two
`---` delimiter lines, then the responsibility body. The frontmatter is a
strict YAML subset:

- plain, single-quoted, and double-quoted scalars only;
- one-line flow lists (`[a, b]`) and block lists (`- item`);
- nested maps indent by exactly two spaces;
- whole-line `#` comments are author documentation and are skipped;
- `#` inside or after a value, tabs, anchors, aliases, tags, merge keys,
  block scalars, and duplicate keys are rejected;
- unknown fields are rejected.

The file name stem must equal the `id` (`<id>.md`). One file is one layer;
discovery scans exactly two user-owned scopes — the agent base directory
under the Pi agent directory and the nearest `.pi/shadow-minds` directory
walking up from the workspace. Packaged reference assets are never
discovered. Project participation does not depend on project approval; the
agent-level master switch stays the only enable gate.

## Layering

The agent layer is the base; the project layer overlays it per field.
Omitted fields inherit; an explicit `null` clears where clearing is defined
(`triggerInstructions` keys, `outputSchema`); an explicit empty list replaces
an inherited list; a provided non-empty body replaces the lower body while an
omitted or empty body inherits; `outputSchema` is replaced atomically (never
field-merged) and `null` restores the default summary schema. An effective
definition must be complete (name and non-empty body among layers,
`completionGate` only with a `completion` subscription, `requiredTools`
within the final tool set) or the whole ID fails closed with diagnostics
while unrelated IDs stay active.

## Runtime boundary

Definitions and project text can never expand the fixed read-only Shadow
tool catalog. Required tools that are excluded or unavailable fail before
any model prompt; optional unavailable tools drop with a visible warning.
The catalog is composed of Pi built-in `read`, `grep`, `find`, `ls` plus the
opt-in local evidence tools; shell, writes, SSH, Firecrawl parse, and
delegation are excluded.

## Contract

The block below is machine-checked. Contract tests compare every claim
against the production parser constants and validate each embedded example
through the production parser.

```json shadow-contract
{
  "promptVersion": 1,
  "file": {
    "maxBytes": 65536,
    "commentPolicy": "whole-line-only"
  },
  "fields": {
    "id": {
      "required": true,
      "maxLength": 64,
      "pattern": "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$",
      "equalsFilenameStem": true
    },
    "name": {
      "maxLength": 120,
      "effectiveRequired": true
    },
    "enabled": { "default": false },
    "hidden": { "default": false },
    "priority": { "min": -1000, "max": 1000, "default": 0 },
    "triggers": {
      "maxEntries": 4,
      "unique": true,
      "enum": ["tool_turn", "failure", "mutation", "completion"],
      "default": []
    },
    "triggerInstructions": {
      "keysFromTriggers": true,
      "valueMaxLength": 8000,
      "nullClearsKey": true,
      "merge": "per-key across layers"
    },
    "delivery": {
      "enum": ["steer", "wake", "notify"],
      "default": "steer"
    },
    "completionGate": {
      "default": false,
      "requiresCompletionTrigger": true
    },
    "parentModels": {
      "maxEntries": 32,
      "unique": true,
      "entryPattern": "exact provider/model-id or *"
    },
    "model": {
      "pattern": "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\\/[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$"
    },
    "thinking": {
      "enum": ["off", "minimal", "low", "medium", "high", "xhigh", "max"]
    },
    "timeoutSeconds": { "min": 1, "max": 600 },
    "maxTurns": { "min": 1, "max": 32 },
    "maxToolCalls": { "min": 1, "max": 128 },
    "tools": {
      "maxEntries": 16,
      "unique": true,
      "entryPattern": "^[a-z][a-z0-9_]{0,63}$",
      "default": ["read", "grep", "find", "ls"],
      "emptyListMeans": "no tools",
      "catalogIsFixed": true
    },
    "requiredTools": {
      "maxEntries": 16,
      "unique": true,
      "entryPattern": "^[a-z][a-z0-9_]{0,63}$",
      "subsetOfFinalTools": true
    },
    "debug": { "default": false },
    "outputSchema": {
      "atomicReplace": true,
      "nullRestoresDefault": true,
      "rootMustBeObject": true,
      "additionalPropertiesFalseRequired": true,
      "maxDepth": 6,
      "maxTotalProperties": 64,
      "maxPropertiesPerObject": 32,
      "maxItems": 64,
      "stringMaxLength": 12000,
      "default": {
        "type": "object",
        "properties": {
          "summary": { "type": "string", "minLength": 1, "maxLength": 12000 }
        },
        "required": ["summary"],
        "additionalProperties": false
      }
    },
    "body": {
      "maxChars": 24000,
      "omittedOrEmptyInherits": true,
      "nonEmptyReplaces": true,
      "effectiveRequired": true
    }
  },
  "payload": {
    "maxEncodedChars": 24000,
    "maxFieldErrors": 32
  }
}
```

## Embedded examples

Each `yaml shadow-valid` block below parses cleanly through the production
parser (the contract test derives the file name from the block's `id`).
Each `yaml shadow-invalid` block is rejected.

A minimal complete definition:

```yaml shadow-valid
---
promptVersion: 1
id: minimal-valid
name: Minimal valid
---
Own one responsibility and answer through the default summary schema.
```

An annotated definition with an explicit output schema and no tools:

```yaml shadow-valid
---
# Comments annotate; they never become values.
promptVersion: 1
id: quiet-valid
name: Quiet valid
triggers: [failure]
tools: []
outputSchema:
  type: object
  properties:
    cause:
      type: string
      maxLength: 200
  required: [cause]
  additionalProperties: false
---
Name the failing target in one line.
```

Whole-line comments are skipped, but `#` after a value is rejected:

```yaml shadow-invalid
---
promptVersion: 1
id: trailing-comment
name: Trailing comment # rejected
---
Body.
```

An output schema object without `additionalProperties: false` is rejected:

```yaml shadow-invalid
---
promptVersion: 1
id: open-object
name: Open object
outputSchema:
  type: object
  properties:
    summary:
      type: string
---
Body.
```

A completion gate without a completion subscription fails closed in
discovery's effective-candidate validation:

```yaml shadow-invalid
---
promptVersion: 1
id: gateless
name: Gateless
completionGate: true
---
Body.
```
