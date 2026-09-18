---
"@odradekk/pi-square": patch
---

Validate `ssh` tool parameters against the tool's own declared TypeBox schema before any handler runs (`src/ssh/tool.ts`). Models already received that schema, but the harness does not validate arguments, so execution carried a second hand-written copy of the same bounds and accepted a few inputs the schema rejects. Validation now uses `Value.Check`/`Value.Errors` — the same pattern as the core configuration reader — and `validateParams` keeps only what a flat strict object schema cannot express: the per-operation field whitelist, terminal control-character rejection, the 30 s `read` `waitMs` cap, and the presence of operation-required fields (`profile`, `session`, `command`, `data`). Duplicate enum, pattern, length, integer, and range checks are gone. Rejected calls still return `INVALID_ARGUMENT` with `isError: true`, and no other model-facing result changed.

Previously accepted, now rejected (each form was already rejected by the declared schema, so no schema-compliant call changes outcome):

- `newline` that is not a boolean, for example `"yes"`: it was truthy and appended the newline; it now fails schema validation.
- `target`, `label`, `prompt`, and `profile` values that are not strings: the old regular-expression match coerced `target` to text (`target: 123` matched the name pattern) and a numeric `label` or `prompt` was used as-is; all four now fail schema validation.
- `profile` longer than 64 characters: unreachable through real configuration, because the agent configuration schema already caps profile names at 64 characters, but the tool boundary now states and enforces the same bound.

Fixed: `label: null` previously threw a `TypeError` inside `validateParams` that surfaced as an `SSH_ERROR` result carrying `Cannot read properties of null (reading 'length')`; it now returns `INVALID_ARGUMENT` like every other invalid parameter.

The `cursor` property now declares `maximum: Number.MAX_SAFE_INTEGER` instead of leaving its integer bound open. That preserves rejection of unsafe-integer cursors: an oversized cursor would otherwise pass validation and `SshOutputBuffer.read` would silently clamp it to the oldest retained position, replay the whole buffer, and report `cursorExpired: false`.

Patch rather than major: every newly rejected input was already invalid under the published schema, the `INVALID_ARGUMENT`/`isError` contract is unchanged, and the one published-schema edit (`cursor`'s maximum) restores the bound the runtime already enforced rather than narrowing a supported call. No schema-compliant caller loses a previously working outcome, which is the repository's standard for a backward-compatible correction rather than a breaking tool-contract change.
