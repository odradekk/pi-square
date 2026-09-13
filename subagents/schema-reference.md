# Subagent definition schema reference

Normative reference for subagent definition files (#334). Every runtime claim
below is enforced by the strict subset parser and layered discovery in
`src/subagents/definitions.ts` and by the child tool resolution in
`src/subagents/tool-policy.ts`; the structured contract block and the embedded
examples at the end of this file are validated against that production code by
tests. The annotated `example_profile.yaml` beside this file is the packaged
reference definition — hidden, never delegatable. The package layer ships no
roles; every delegatable definition lives in the agent or project layer.

## Format

One definition is one `.yaml` or `.yml` file. The file name is free — the
`name` field is the identity and must match `^[A-Za-z0-9][A-Za-z0-9._-]*$`.
The body is a strict YAML subset:

- plain, single-quoted, and double-quoted scalars;
- one-line flow lists (`[a, b]`) and indented block lists (`- item`);
- plain `|` and `>` block scalars; a line is body only when indented past its
  own field, so a block scalar with no indented body never swallows the next
  field;
- whole-line `#` comments;
- exact lowercase `null` and ASCII `~` as clear markers, case-sensitive in
  every position: scalar values, block list items, and inline array elements
  behave identically.

Rejected with a named error, never silently misread:

- block scalar chomping or indentation indicators (`|-`, `>+`, `|2`) — use `|`
  or `>` alone;
- inline comments — a `#` that begins a value or follows a space outside
  quotes; quote the value to keep a literal `#` (an issue number, say) or move
  the comment to its own line;
- every casing of `null` except the exact lowercase word, and tilde lookalikes
  such as `～`;
- blank lines inside a block list, before the first item or between items;
- column-zero list items — list items must be indented under their field;
- unknown, duplicate, or wrongly typed fields; missing `name`; any
  `promptVersion` other than `2`.

One field error invalidates the whole file: no warning level, no value
fallback, no partial effect. A rejected file is a first-class invalid entry in
the `/subagent` manager — identity, source file, and every error — even when
valid definitions exist beside it.

Discovery scans three scopes in precedence order package < agent < nearest
project: the packaged `subagents/` directory (read-only at runtime), the agent
directory (`<agentDir>/subagents/`), and the nearest `.pi/subagents/` walking
up from the workspace. Same-name files across scopes are field overlays, not
whole-definition replacements; duplicate names within one scope are rejected.

## Layering

Each field overlays independently: a higher layer replaces only the fields it
declares. A field has three states across layers:

- omitted — inherits the value from the next lower layer that declares it;
- `null` — clears: the field is absent from the effective definition;
- a value — replaces the lower value.

Lists follow the same rule with `[]` as the explicit clear: `[]` replaces an
inherited list with an empty one while omitted inherits it. `[]` and omission
are equivalent in final runtime behavior — omitted or empty `tools` selects
the runtime defaults, omitted or empty `skills` loads all discovered skills,
omitted or empty `extensionTools` requests none — but they are not equivalent
in overlay precedence: `[]` clears an inherited list, omission keeps it.

`description` is required only in the effective definition. A single layer may
omit it whenever a lower layer provides one; an effective definition with no
description across all layers fails the merge and surfaces as an invalid entry
whose sources are every contributing layer.

`visible: false` removes the effective definition from the parent catalog and
tool lookup without touching lower layers; a higher layer may set `true` or
`null` (clears to the default `true`) to reveal it again. Every effective
field retains its source scope, file path, and content hash for manager
display and prompt drift checks.

## Validation stages

A file that parses and saves is not yet a working configuration. Validation
happens in three stages, and only the first depends on the file alone:

- Parse time, at every discovery (session start, `/subagent`, guide build):
  the subset rules and field shapes above, plus the overlay merge. Rejected
  files and failed merges become invalid entries; everything else composes
  effective definitions.
- Startup time, when a delegation creates the child session and before any
  model call: the tool selection resolves. Unsupported built-in names, `none`
  beside any other entry, the anchored `replace`/`insert` names (granted only
  through the `edit` capability), the virtual `shell` under `extensionTools`,
  and platform mismatches each fail the run with a structured error naming
  the supported set. There is no static extension-tool list to copy: names
  are validated against the child tool catalog available in the session.
- Session time, while the child session is assembled: `model` must resolve in
  the model registry (`provider/model-id` form or omitted to inherit),
  `effort` must be one of the allowed values, and every requested skill must
  exist among the skills discovered for the child. A miss fails the run
  before the child's first turn.

## Contract

The block below is machine-checked. Contract tests compare every field, tool,
and effort claim against the production constants and validate each embedded
example through the production parser, discovery, and tool resolution.

```json subagent-contract
{
  "promptVersion": 2,
  "fields": {
    "description": { "type": "string", "required": "after merge", "default": "none — must survive the overlay merge" },
    "model": { "type": "string", "required": "no", "default": "inherit parent at fresh-run startup" },
    "effort": { "type": "string", "required": "no", "default": "inherit parent at fresh-run startup" },
    "policy": { "type": "string", "required": "no", "default": "none" },
    "instructions": { "type": "string", "required": "no", "default": "none" },
    "output": { "type": "string", "required": "no", "default": "none" },
    "inheritParentSystem": { "type": "boolean", "required": "no", "default": "true" },
    "tools": { "type": "string list", "required": "no", "default": "omitted or [] selects the runtime defaults; [none] disables every built-in tool" },
    "extensionTools": { "type": "string list", "required": "no", "default": "omitted or [] requests none" },
    "skills": { "type": "string list", "required": "no", "default": "omitted or [] loads all discovered skills; [none] disables them" },
    "visible": { "type": "boolean", "required": "no", "default": "true" }
  },
  "builtInToolNames": ["read", "bash", "edit", "write", "grep", "find", "ls"],
  "portableShellCapability": "shell",
  "noBuiltInToolsSentinel": "none (must be the only entry)",
  "allowedEfforts": ["off", "minimal", "low", "medium", "high", "xhigh", "max"]
}
```

## Embedded examples

Each `yaml subagent-valid` block below becomes an effective definition through
production discovery (the test derives the file name from the block's `name`).
Each `yaml subagent-invalid` block is rejected whole and appears as an invalid
entry. Each `yaml subagent-startup-invalid` block parses and merges cleanly —
its tools fail later, at child-session startup, through production tool
resolution. The `yaml subagent-overlay-agent` and `yaml subagent-overlay-project`
blocks are one name in two scopes and merge into a single effective definition.

A minimal complete definition:

```yaml subagent-valid
promptVersion: 2
name: minimal-valid
description: >
  Smallest complete definition: identity plus an effective description.
```

Every supported scalar and list form in one definition:

```yaml subagent-valid
promptVersion: 2
name: forms-valid
description: "Quoted # scalar keeps its hash"
policy: |
  One policy line.
tools: [read, grep]
skills:
  - none
inheritParentSystem: true
visible: true
```

One name in two scopes — the agent base carries the inherited fields and the
project overlay exercises the three states (`[]` clears the inherited tool
list, `null` clears the scalar, `visible` replaces):

```yaml subagent-overlay-agent
promptVersion: 2
name: overlay-demo
description: >
  Base layer carrying the inherited fields.
policy: |
  Base policy.
tools:
  - read
  - grep
  - find
skills:
  - none
```

```yaml subagent-overlay-project
promptVersion: 2
name: overlay-demo
tools: []
model: null
visible: false
```

A block scalar chomping indicator is rejected, not stored as the literal
string `|-`:

```yaml subagent-invalid
promptVersion: 2
name: chomping-invalid
description: |-
  Body of the rejected block.
```

An inline comment is rejected — quote the value or move the comment to its
own line:

```yaml subagent-invalid
promptVersion: 2
name: comment-invalid
description: fix bug #334
```

An uppercase null spelling is rejected instead of becoming a literal string;
exact lowercase `null` and ASCII `~` clear:

```yaml subagent-invalid
promptVersion: 2
name: null-invalid
description: Works.
model: NULL
```

A blank line inside a block list is rejected instead of silently truncating
it — before the first item or between items alike:

```yaml subagent-invalid
promptVersion: 2
name: blank-list-invalid
description: Works.
tools:

  - read
```

A column-zero list item reports the indentation rule directly:

```yaml subagent-invalid
promptVersion: 2
name: flush-list-invalid
description: Works.
tools:
- read
```

A definition whose effective description never exists fails the merge — the
invalid entry carries every contributing layer as its source:

```yaml subagent-invalid
promptVersion: 2
name: descriptionless-invalid
visible: false
```

`none` beside another entry parses but fails tool resolution at child-session
startup:

```yaml subagent-startup-invalid
promptVersion: 2
name: none-mixed-invalid
description: Parses; fails at child-session startup.
tools: [none, read]
```

The anchored `replace` and `insert` names cannot be requested directly — the
`edit` capability grants them:

```yaml subagent-startup-invalid
promptVersion: 2
name: anchored-name-invalid
description: Parses; fails at child-session startup.
tools: [read, replace]
```
