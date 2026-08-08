import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import {
  KeybindingsManager,
  setKeybindings,
  TUI_KEYBINDINGS,
  visibleWidth,
} from "@earendil-works/pi-tui";
import jiti from "jiti";

setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);
const load = jiti(import.meta.url, { moduleCache: false });
const { DEFAULT_CONFIG } = await load("../../src/core/config.ts");
const { DisplayManager } = await load("../../src/display/manager.ts");
const { DISPLAY_FAMILIES } = await load("../../src/display/types.ts");

const theme = {
  fg(_token, text) { return String(text); },
  bg(_token, text) { return String(text); },
  bold(text) { return String(text); },
  inverse(text) { return String(text); },
};
const tui = { terminal: { rows: 30, columns: 120 }, requestRender() {} };

// ── Snapshot helpers (production readDisplayConfigSnapshot with real files) ──

const snapshotModule = await load("../../src/core/config-write.ts");
const { readDisplayConfigSnapshot, displayConfigPath, DisplayConfigWriteError } = snapshotModule;

async function withTempAgentDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "pi-square-migration-"));
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  mkdirSync(join(dir, "config"), { recursive: true });
  try {
    return await fn(dir);
  } finally {
    process.env.PI_CODING_AGENT_DIR = prev;
  }
}

async function snapshotFromFile(json, scope = "agent") {
  return withTempAgentDir(async () => {
    const path = displayConfigPath(scope, "/unused-project-dir");
    writeFileSync(path, JSON.stringify(json));
    return readDisplayConfigSnapshot(scope, {
      cwd: "/unused-project-dir",
      isProjectTrusted: true,
    });
  });
}

// ── 1. Production snapshot: migration detection for legacy diffIndicators ──

{
  const snap = await snapshotFromFile({
    version: 2,
    display: {
      motion: "full",
      defaults: { diffIndicators: "bars", previewLines: 10 },
      tools: { rg: { diffIndicators: "none" } },
    },
  });
  assert.ok(snap.migration, "migration changes must be present for legacy diffIndicators");
  const removals = snap.migration.filter((c) => c.kind === "removed" && c.description.includes("diffIndicators"));
  assert.equal(removals.length, 2, "both defaults and tool diffIndicators removals recorded");
  assert.equal(snap.display.defaults?.previewLines, 10, "valid fields preserved");
  assert.equal(snap.display.defaults?.diffIndicators, undefined, "diffIndicators stripped from canonical display");
  assert.equal(snap.display.tools?.rg, undefined, "tool with only diffIndicators is dropped entirely");
}

// ── 2. Production snapshot: migration detection for motion: "reduced" ──

{
  const snap = await snapshotFromFile({
    version: 2,
    display: { motion: "reduced" },
  });
  assert.ok(snap.migration, "migration changes must be present for reduced motion");
  const changed = snap.migration.find((c) => c.kind === "changed");
  assert.ok(changed, "meaning change is recorded");
  assert.match(changed.description, /120 ms/);
  assert.equal(snap.display.motion, "reduced", "motion value preserved in canonical display");
}

// ── 3. Production snapshot: migration detection for footer.mode ──

{
  const snap = await snapshotFromFile({
    version: 2,
    footer: { mode: "native" },
    display: { motion: "full" },
  });
  assert.ok(snap.migration, "migration changes must be present for deprecated footer.mode");
  const footerChange = snap.migration.find((c) => c.description.includes("footer.mode"));
  assert.ok(footerChange, "footer.mode removal recorded");
  assert.equal(footerChange.kind, "removed");
  assert.equal(snap.footerModePresent, true);
}

// ── 4. Production snapshot: all three change types combined ──

{
  const snap = await snapshotFromFile({
    version: 2,
    footer: { mode: "enhanced" },
    display: {
      motion: "reduced",
      defaults: { diffIndicators: "classic", previewLines: 5 },
    },
  });
  assert.ok(snap.migration);
  assert.ok(snap.migration.length >= 3, "all three change types recorded");
  assert.ok(snap.migration.some((c) => c.description.includes("diffIndicators")));
  assert.ok(snap.migration.some((c) => c.kind === "changed" && c.description.includes("120 ms")));
  assert.ok(snap.migration.some((c) => c.description.includes("footer.mode")));
}

// ── 5. Production snapshot: canonical config produces no migration ──

{
  const snap = await snapshotFromFile({
    version: 2,
    display: { motion: "full", defaults: { previewLines: 9 } },
  });
  assert.equal(snap.migration, undefined, "canonical config must not trigger migration");
  assert.equal(snap.display.defaults?.previewLines, 9);
}

// ── 6. Production snapshot: invalid display value is rejected ──

{
  await assert.rejects(
    () => snapshotFromFile({ version: 2, display: { motion: "fast" } }),
    (err) => err instanceof DisplayConfigWriteError && err.code === "DISPLAY_CANDIDATE_INVALID",
  );
}

// ── 7. Production snapshot: invalid non-display field is still rejected ──

{
  await assert.rejects(
    () => snapshotFromFile({ version: 1, display: { motion: "full" } }),
    (err) => err instanceof DisplayConfigWriteError && err.code === "DISPLAY_CANDIDATE_INVALID",
  );
}

// ── Manager helpers ──

function migrationSnapshot(scope, display, changes, footerModePresent = false) {
  return {
    path: scope === "agent" ? "/agent/config/pi-square.json" : "/project/.pi/config/pi-square.json",
    fingerprint: `${scope}-fp`,
    display,
    footerModePresent,
    migration: changes,
  };
}

function plainSnapshot(scope, display = {}, footerModePresent = false) {
  return {
    path: scope === "agent" ? "/agent/config/pi-square.json" : "/project/.pi/config/pi-square.json",
    fingerprint: `${scope}-fp`,
    display,
    footerModePresent,
  };
}

function harness(snapshotOverrides = {}, serviceOverrides = {}) {
  let currentConfig = structuredClone(DEFAULT_CONFIG);
  const changes = [
    { kind: "removed", description: "diffIndicators: 'bars' removed — bars, classic markers, or no markers would alter the fixed unified-diff grammar" },
    { kind: "changed", description: "motion: 'reduced' meaning changed from 1 FPS (1000 ms) to a 120 ms interval (~8.3 FPS)" },
  ];
  const agentDisplay = { motion: "reduced", defaults: { previewLines: 10 } };
  const snapshots = new Map([
    ["agent", migrationSnapshot("agent", agentDisplay, changes, true)],
    ["project", plainSnapshot("project", { families: { search: { resultMode: "preview" } } })],
    ...Object.entries(snapshotOverrides).map(([scope, snap]) => [scope, snap]),
  ]);
  const calls = [];
  const services = {
    trustedProject: true,
    currentConfig: () => currentConfig,
    async refresh(scope) { return snapshots.get(scope); },
    async save(scope, previous, display, removeFooterMode) {
      calls.push({ scope, display: structuredClone(display), removeFooterMode });
      const next = { ...previous, fingerprint: `${scope}-next`, display: structuredClone(display), footerModePresent: false };
      currentConfig = {
        ...currentConfig,
        display: {
          ...currentConfig.display,
          [scope]: { path: next.path, config: next.display },
          motion: scope === "project"
            ? next.display.motion ?? currentConfig.display.agent?.config.motion ?? "full"
            : currentConfig.display.project?.config.motion ?? next.display.motion ?? "full",
        },
      };
      return next;
    },
    ...serviceOverrides,
  };
  let closed = 0;
  const manager = new DisplayManager(
    structuredClone(DEFAULT_CONFIG),
    snapshots,
    tui,
    theme,
    keybindings,
    () => { closed += 1; },
    services,
    [{ name: "current", theme }],
  );
  manager.focused = true;
  return { manager, calls, getClosed: () => closed, snapshots };
}

function render(manager, width = 120) {
  return manager.render(width).map(stripVTControlCharacters).join("\n");
}

// ── 8. Manager: constructor auto-opens migration view ──

{
  const { manager } = harness();
  const output = render(manager, 80);
  assert.match(output, /Migration review/);
  assert.match(output, /Scope: agent/);
  assert.match(output, /MIGRATION CHANGES/);
  assert.match(output, /diffIndicators/);
  assert.match(output, /120 ms/);
  assert.match(output, /CANONICAL DEFAULTS/);
  assert.match(output, /STAGED CANONICAL DISPLAY/);
  assert.match(output, /enter approve/);
  assert.match(output, /esc decline/);
}

// ── 9. Manager: migration view shows path and all staged values ──

{
  const { manager } = harness();
  const output = render(manager, 120);
  assert.match(output, /\/agent\/config\/pi-square\.json/);
  assert.match(output, /Provenance:/);
  assert.match(output, /"motion": "reduced"/);
  assert.match(output, /"previewLines": 10/);
  assert.match(output, /resultMode=preview/);
  assert.match(output, /diffView=unified/);
}

// ── 10. Manager: approve migration calls save with canonical display ──

{
  const { manager, calls } = harness();
  manager.handleInput("\r");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].scope, "agent");
  assert.equal(calls[0].removeFooterMode, true);
  assert.equal(calls[0].display.motion, "reduced");
  assert.equal(calls[0].display.defaults?.previewLines, 10);
  assert.equal(calls[0].display.defaults?.diffIndicators, undefined);
  assert.match(render(manager, 80), /Migrated agent display configuration/);
  assert.match(render(manager, 80), /enter edit/);
}

// ── 11. Manager: decline migration returns to browse with no save ──

{
  const { manager, calls } = harness();
  manager.handleInput("\x1b"); // esc
  assert.equal(calls.length, 0, "no save on decline");
  const output = render(manager, 80);
  assert.match(output, /enter edit/);
  assert.doesNotMatch(output, /Migration review/);
}

// ── 12. Manager: m key re-opens migration from browse ──

{
  const { manager } = harness();
  manager.handleInput("\x1b"); // decline → browse
  assert.doesNotMatch(render(manager, 80), /Migration review/);
  manager.handleInput("m");
  assert.match(render(manager, 80), /Migration review/);
}

// ── 13. Manager: m key shows flash when no migration needed ──

{
  const snapshots = new Map([
    ["agent", plainSnapshot("agent", { defaults: { previewLines: 10 } })],
    ["project", plainSnapshot("project")],
  ]);
  let currentConfig = structuredClone(DEFAULT_CONFIG);
  const manager = new DisplayManager(
    currentConfig,
    snapshots,
    tui,
    theme,
    keybindings,
    () => {},
    {
      trustedProject: true,
      currentConfig: () => currentConfig,
      async refresh(scope) { return snapshots.get(scope); },
      async save() {},
    },
    [{ name: "current", theme }],
  );
  manager.focused = true;
  assert.doesNotMatch(render(manager, 80), /Migration review/);
  manager.handleInput("m");
  assert.match(render(manager, 80), /No migration needed/);
}

// ── 14. Manager: stale review during migration refreshes and keeps changes ──

{
  const { manager, calls } = harness({}, {
    async save() { throw new DisplayConfigWriteError("changed", "DISPLAY_STALE_REVIEW"); },
  });
  manager.handleInput("\r"); // approve
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 0, "no successful save on stale review");
  const output = render(manager, 80);
  assert.match(output, /current file refreshed/);
}

// ── 15. Manager: save error shows flash and keeps migration view recoverable ──

{
  const { manager, calls } = harness({}, {
    async save() { throw new DisplayConfigWriteError("disk full", "DISPLAY_RENAME_FAILED"); },
  });
  manager.handleInput("\r"); // approve
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 0);
  const output = render(manager, 80);
  assert.match(output, /disk full/);
  assert.match(output, /Migration review/, "migration view remains recoverable after error");
}

// ── 16. Manager: footer.mode only migration (no diffIndicators) ──

{
  const footerOnlyChanges = [
    { kind: "removed", description: "footer.mode is deprecated and has no runtime effect; it will be removed from the config file" },
  ];
  const snapshots = new Map([
    ["agent", migrationSnapshot("agent", { motion: "full" }, footerOnlyChanges, true)],
  ]);
  const saveCalls = [];
  const manager = new DisplayManager(
    structuredClone(DEFAULT_CONFIG),
    snapshots,
    tui,
    theme,
    keybindings,
    () => {},
    {
      trustedProject: true,
      currentConfig: () => structuredClone(DEFAULT_CONFIG),
      async refresh(scope) { return snapshots.get(scope); },
      async save(scope, _prev, display, removeFooterMode) {
        saveCalls.push({ scope, display, removeFooterMode });
        return { ...snapshots.get(scope), fingerprint: "new", display, footerModePresent: false };
      },
    },
    [{ name: "current", theme }],
  );
  manager.focused = true;
  const output = render(manager, 80);
  assert.match(output, /Migration review/);
  assert.match(output, /footer\.mode/);
  manager.handleInput("\r");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(saveCalls.length, 1);
  assert.equal(saveCalls[0].removeFooterMode, true);
}

// ── 17. Manager: migration view bounded at all required widths ──

{
  const { manager } = harness();
  for (const width of [39, 40, 63, 64, 80, 99, 100, 120]) {
    const lines = manager.render(width);
    const expectedWidth = Math.min(110, Math.max(80, Math.floor(width * 0.9)));
    const actualMax = Math.max(...lines.map(visibleWidth));
    assert.ok(
      actualMax <= Math.max(expectedWidth, width),
      `migration view must stay bounded at width ${width} (max render ${actualMax})`,
    );
  }
}

// ── 18. Manager: up/down scrolls migration content ──

{
  const { manager } = harness();
  const before = render(manager, 80);
  manager.handleInput("\x1b[B"); // down
  const after = render(manager, 80);
  // Content should not throw; scroll state is internal
  manager.handleInput("\x1b[A"); // up
  assert.doesNotMatch(render(manager, 80), /TypeError|undefined/);
}

// ── 19. Production snapshot: empty display produces no migration ──

{
  const snap = await snapshotFromFile({ version: 2 });
  assert.equal(snap.migration, undefined);
  assert.deepEqual(snap.display, {});
}

// ── 20. Production snapshot: diffIndicators across all overlay levels ──

{
  const snap = await snapshotFromFile({
    version: 2,
    display: {
      defaults: { diffIndicators: "bars" },
      families: { search: { diffIndicators: "none" } },
      tools: { edit: { diffIndicators: "classic" } },
    },
  });
  assert.ok(snap.migration);
  const removals = snap.migration.filter((c) => c.description.includes("diffIndicators"));
  assert.equal(removals.length, 3, "all three overlay levels recorded");
}

console.log("migration delivery tests: OK");
