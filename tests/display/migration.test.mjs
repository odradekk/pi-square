import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import jiti from "jiti";

const packageRoot = resolve(import.meta.dirname, "..", "..");
const load = jiti(import.meta.url, { moduleCache: false });
const { migrateDisplayConfig, DisplayMigrationError } = await load(join(packageRoot, "src", "display", "migration.ts"));
const { DEFAULT_DISPLAY_POLICY, MOTION_FULL_INTERVAL_MS, MOTION_REDUCED_INTERVAL_MS } = await load(join(packageRoot, "src", "display", "types.ts"));
const { validateConfigLayer } = await load(join(packageRoot, "src", "core", "config.ts"));

const tests = [];

function test(name, fn) { tests.push({ name, fn }); }

// ─── 1. Empty/undefined input produces empty canonical config ──────

test("undefined input produces empty canonical config with no changes", () => {
  const result = migrateDisplayConfig(undefined);
  assert.deepEqual(result.display, {});
  assert.equal(result.changes.length, 0);
});

test("null input produces empty canonical config with no changes", () => {
  const result = migrateDisplayConfig(null);
  assert.deepEqual(result.display, {});
  assert.equal(result.changes.length, 0);
});

// ─── 2. Canonical defaults are correct ─────────────────────────────

test("canonical defaults are preview, nine rows, unified diff, full motion at 120 ms", () => {
  assert.equal(DEFAULT_DISPLAY_POLICY.resultMode, "preview");
  assert.equal(DEFAULT_DISPLAY_POLICY.previewLines, 9);
  assert.equal(DEFAULT_DISPLAY_POLICY.diffView, "unified");
  assert.equal(MOTION_FULL_INTERVAL_MS, 120);
  assert.equal(MOTION_REDUCED_INTERVAL_MS, 1_000);
});

// ─── 3. Valid legacy input migrates completely ─────────────────────

test("valid legacy input with all fields migrates to canonical config", () => {
  const legacy = {
    motion: "full",
    defaults: {
      resultMode: "preview",
      previewLines: 9,
      expandedMaxLines: 4000,
      showMetadata: true,
      showDuration: true,
      wordWrap: true,
      diffView: "unified",
      diffSplitMinWidth: 120,
      diffCollapsedLines: 24,
    },
    families: {
      search: { previewLines: 12 },
    },
    tools: {
      rg: { wordWrap: false },
    },
  };
  const result = migrateDisplayConfig(legacy);
  assert.equal(result.display.motion, "full");
  assert.equal(result.display.defaults?.previewLines, 9);
  assert.equal(result.display.defaults?.diffView, "unified");
  assert.equal(result.display.families?.search?.previewLines, 12);
  assert.equal(result.display.tools?.rg?.wordWrap, false);
  assert.equal(result.changes.length, 0);
});

// ─── 4. diffIndicators removal is explicitly recorded ──────────────

test("diffIndicators in defaults is removed and recorded as a change", () => {
  const legacy = {
    defaults: { diffIndicators: "bars" },
  };
  const result = migrateDisplayConfig(legacy);
  assert.equal(result.display.defaults?.diffIndicators, undefined);
  assert.equal(result.display.defaults, undefined);
  const removal = result.changes.find((c) => c.kind === "removed" && c.description.includes("diffIndicators"));
  assert.ok(removal, "diffIndicators removal is recorded");
  assert.match(removal.description, /bars/);
});

test("diffIndicators in a family overlay is removed and recorded", () => {
  const legacy = {
    families: {
      filesystem: { diffIndicators: "classic", previewLines: 5 },
    },
  };
  const result = migrateDisplayConfig(legacy);
  assert.equal(result.display.families?.filesystem?.diffIndicators, undefined);
  assert.equal(result.display.families?.filesystem?.previewLines, 5);
  assert.ok(result.changes.some((c) => c.kind === "removed" && c.description.includes("diffIndicators") && c.description.includes("classic")));
});

test("diffIndicators in a tool overlay is removed and recorded", () => {
  const legacy = {
    tools: {
      edit: { diffIndicators: "none" },
    },
  };
  const result = migrateDisplayConfig(legacy);
  assert.equal(result.display.tools?.edit, undefined);
  assert.ok(result.changes.some((c) => c.kind === "removed" && c.description.includes("none")));
});

// ─── 5. Reduced motion meaning change is explicitly recorded ───────

test("motion reduced is migrated and the meaning change is recorded", () => {
  const legacy = { motion: "reduced" };
  const result = migrateDisplayConfig(legacy);
  assert.equal(result.display.motion, "reduced");
  const change = result.changes.find((c) => c.kind === "changed");
  assert.ok(change, "meaning change is recorded");
  assert.match(change.description, /reduced/);
  assert.match(change.description, /120 ms/);
});

test("motion full does not produce a change", () => {
  const result = migrateDisplayConfig({ motion: "full" });
  assert.equal(result.display.motion, "full");
  assert.equal(result.changes.length, 0);
});

test("motion off does not produce a change", () => {
  const result = migrateDisplayConfig({ motion: "off" });
  assert.equal(result.display.motion, "off");
  assert.equal(result.changes.length, 0);
});

// ─── 6. Malformed input is rejected atomically ─────────────────────

test("non-object input is rejected", () => {
  assert.throws(() => migrateDisplayConfig("invalid"), (e) => e instanceof DisplayMigrationError && e.code === "DISPLAY_MIGRATION_INVALID");
  assert.throws(() => migrateDisplayConfig(42), (e) => e instanceof DisplayMigrationError);
  assert.throws(() => migrateDisplayConfig([]), (e) => e instanceof DisplayMigrationError);
});

test("unknown top-level field is rejected", () => {
  assert.throws(
    () => migrateDisplayConfig({ unknownField: true }),
    (e) => e instanceof DisplayMigrationError && e.message.includes("unknownField"),
  );
});

test("invalid motion value is rejected", () => {
  assert.throws(
    () => migrateDisplayConfig({ motion: "fast" }),
    (e) => e instanceof DisplayMigrationError && e.message.includes("motion"),
  );
});

test("invalid diffIndicators value is rejected", () => {
  assert.throws(
    () => migrateDisplayConfig({ defaults: { diffIndicators: "fancy" } }),
    (e) => e instanceof DisplayMigrationError && e.message.includes("diffIndicators"),
  );
});

test("out-of-bounds previewLines is rejected", () => {
  assert.throws(
    () => migrateDisplayConfig({ defaults: { previewLines: 0 } }),
    (e) => e instanceof DisplayMigrationError,
  );
  assert.throws(
    () => migrateDisplayConfig({ defaults: { previewLines: 81 } }),
    (e) => e instanceof DisplayMigrationError,
  );
});

test("invalid resultMode is rejected", () => {
  assert.throws(
    () => migrateDisplayConfig({ defaults: { resultMode: "compact" } }),
    (e) => e instanceof DisplayMigrationError,
  );
});

test("unknown overlay field is rejected", () => {
  assert.throws(
    () => migrateDisplayConfig({ defaults: { customField: true } }),
    (e) => e instanceof DisplayMigrationError && e.message.includes("customField"),
  );
});

test("overlay that is not an object is rejected", () => {
  assert.throws(
    () => migrateDisplayConfig({ defaults: "invalid" }),
    (e) => e instanceof DisplayMigrationError,
  );
});

// ─── 7. Migration performs no writes ───────────────────────────────

test("migration is a pure function — same input always produces same output", () => {
  const legacy = { motion: "reduced", defaults: { diffIndicators: "bars", previewLines: 5 } };
  const result1 = migrateDisplayConfig(legacy);
  const result2 = migrateDisplayConfig(legacy);
  assert.deepEqual(result1.display, result2.display);
  assert.deepEqual(result1.changes, result2.changes);
});

// ─── 8. Multiple diffIndicators across overlay levels ─────────────

test("multiple diffIndicators across overlay levels are all recorded", () => {
  const legacy = {
    defaults: { diffIndicators: "bars" },
    families: { search: { diffIndicators: "none" } },
    tools: { rg: { diffIndicators: "classic" } },
  };
  const result = migrateDisplayConfig(legacy);
  const removals = result.changes.filter((c) => c.kind === "removed" && c.description.includes("diffIndicators"));
  assert.equal(removals.length, 3);
});

// ─── 9. Validated output matches canonical DisplayLayerConfig ──────

test("migrated display passes canonical validation", () => {
  const legacy = {
    motion: "full",
    defaults: { resultMode: "preview", previewLines: 9 },
    families: { search: { wordWrap: true } },
    tools: { rg: { previewLines: 12 } },
  };
  const result = migrateDisplayConfig(legacy);
  const candidate = { version: 2, display: result.display };
  const error = validateConfigLayer(candidate, "agent");
  assert.equal(error, undefined, `migrated config should be valid: ${error}`);
});

// ─── 10. Unknown family/tool names are rejected ────────────────────

test("unknown family name is rejected", () => {
  assert.throws(
    () => migrateDisplayConfig({ families: { serach: { previewLines: 5 } } }),
    (e) => e instanceof DisplayMigrationError && e.message.includes("serach"),
  );
});

test("invalid tool name is rejected", () => {
  assert.throws(
    () => migrateDisplayConfig({ tools: { "bad-name!": { previewLines: 5 } } }),
    (e) => e instanceof DisplayMigrationError && e.message.includes("bad-name!"),
  );
});

test("too many tools are rejected", () => {
  const tools = {};
  for (let i = 0; i < 129; i++) tools[`tool${i}`] = { previewLines: 5 };
  assert.throws(
    () => migrateDisplayConfig({ tools }),
    (e) => e instanceof DisplayMigrationError && e.message.includes("maximum"),
  );
});

// ─── 11. footer.mode migration ────────────────────────────────────

test("footer.mode removal is recorded when present", () => {
  const mod = load(join(packageRoot, "src", "display", "migration.ts"));
  const change = mod.migrateFooterMode(true);
  assert.ok(change);
  assert.equal(change.kind, "removed");
  assert.match(change.description, /footer\.mode/);
  assert.match(change.description, /deprecated/);
});

test("footer.mode migration returns undefined when absent", () => {
  const mod = load(join(packageRoot, "src", "display", "migration.ts"));
  assert.equal(mod.migrateFooterMode(false), undefined);
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`PASS: ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL: ${name} — ${error instanceof Error ? error.message : String(error)}`);
  }
}
console.log(`\n${tests.length} tests, ${failed} failed`);
if (failed > 0) process.exit(1);
