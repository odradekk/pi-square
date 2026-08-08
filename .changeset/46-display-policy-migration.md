---
"@odradekk/pi-square": minor
---

Add canonical display policy migration reader for staging legacy configuration.

Introduces `src/display/migration.ts` with a pure-function legacy-input reader that stages a reviewed migration candidate without writing files:

- **`migrateDisplayConfig(input)`**: reads a legacy display configuration object and produces a validated canonical `DisplayLayerConfig` with an explicit record of every behavior change. Performs no writes, rejects malformed or unknown input atomically, and does not create a permanent dual policy runtime.
- **`migrateFooterMode(present)`**: records the reviewed removal of deprecated `footer.mode` as a change entry for the `/display` review screen.
- **Change recording**: `diffIndicators` removal, `footer.mode` removal, and `motion: reduced` meaning change (1 FPS → 120 ms) are each explicitly documented.

Validation matches the existing TypeBox schema bounds: family names validated against the six-family catalog, tool names validated against the name pattern, tool count capped at 128, and all numeric fields bounded by the same constants used in `src/core/config.ts`.

Canonical defaults are confirmed: preview with nine rows, unified diff, full motion at 34 ms, reduced motion at 120 ms, off with no timer.

New tests cover: empty/null input, canonical defaults, complete migration, diffIndicators removal across overlay levels, reduced motion meaning change, atomic rejection of malformed input, unknown fields, invalid enums, out-of-bounds values, family/tool name validation, footer.mode migration, pure-function determinism, and canonical validation of migrated output.
