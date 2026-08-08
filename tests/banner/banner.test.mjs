import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { visibleWidth } from "@earendil-works/pi-tui";
import jiti from "jiti";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const load = jiti(import.meta.url, { moduleCache: false });
const bannerModule = await load(join(packageRoot, "src", "banner", "index.ts"));
const registerBanner = bannerModule.default;
const { setBannerDisplayDiagnostic } = bannerModule;
const tests = [];

function test(name, fn) { tests.push({ name, fn }); }
function plainTheme() {
  return { fg(_color, text) { return text; }, bold(text) { return text; } };
}

function makePi() {
  const handlers = new Map();
  return { pi: { on(name, handler) { handlers.set(name, handler); } }, handlers };
}

// ═══════════════════════════════════════════════════════════════════

// ─── 1. Enabled TUI session sets compact two-line header ───────────

test("tui session_start with banner enabled sets a compact header", async () => {
  const { pi, handlers } = makePi();
  registerBanner(pi, () => ({ version: 2, banner: { enabled: true } }));
  assert.deepEqual([...handlers.keys()], ["session_start"]);

  const headerCalls = [];
  const ctx = { mode: "tui", ui: { setHeader(factory) { headerCalls.push(factory); } } };
  await handlers.get("session_start")({}, ctx);

  assert.equal(headerCalls.length, 1, "exactly one setHeader call");
  const component = headerCalls[0](undefined, plainTheme());
  for (const width of [39, 40, 63, 64, 80, 99, 100, 120]) {
    const lines = component.render(width);
    assert.ok(lines.every((line) => visibleWidth(line) <= width), `bounded at ${width}`);
    assert.ok(lines.some((line) => line.includes("π²")), `identity at ${width}`);
    assert.ok(lines.some((line) => /pi-square/i.test(line)), `name at ${width}`);
    // Must NOT contain old markup
    assert.ok(!lines.some((line) => /OPERATIONAL CONSOLE/i.test(line)), `no OPERATIONAL CONSOLE at ${width}`);
    assert.ok(!lines.some((line) => /unified local extension/i.test(line)), `no tagline at ${width}`);
    // Must NOT contain full-width decorative rule
    assert.ok(!lines.some((line) => /^─+$/.test(stripVTControlCharacters(line))), `no decorative rule at ${width}`);
  }
});

// ─── 2. Header is at most two lines ────────────────────────────────

test("header renders at most two lines", async () => {
  const { pi, handlers } = makePi();
  registerBanner(pi, () => ({ version: 2, banner: { enabled: true } }));
  const headerCalls = [];
  const ctx = { mode: "tui", ui: { setHeader(factory) { headerCalls.push(factory); } } };
  await handlers.get("session_start")({}, ctx);
  const component = headerCalls[0](undefined, plainTheme());

  // Without diagnostics: exactly 1 line
  setBannerDisplayDiagnostic(undefined);
  for (const width of [39, 40, 63, 64, 80, 99, 100, 120]) {
    const lines = component.render(width);
    assert.equal(lines.length, 1, `one line without diagnostic at ${width}`);
  }

  // With diagnostic: exactly 2 lines
  setBannerDisplayDiagnostic("Settings parse error in scope default");
  for (const width of [39, 40, 63, 64, 80, 99, 100, 120]) {
    const lines = component.render(width);
    assert.ok(lines.length <= 2, `at most two lines with diagnostic at ${width}`);
    assert.ok(lines.length >= 1, `at least one line at ${width}`);
  }
  setBannerDisplayDiagnostic(undefined);
});

// ─── 3. Diagnostic line shows warning marker and is sanitized ─────

test("diagnostic renders as protected warning with sanitization", async () => {
  const { pi, handlers } = makePi();
  registerBanner(pi, () => ({ version: 2, banner: { enabled: true } }));
  const headerCalls = [];
  const ctx = { mode: "tui", ui: { setHeader(factory) { headerCalls.push(factory); } } };
  await handlers.get("session_start")({}, ctx);
  const component = headerCalls[0](undefined, plainTheme());

  setBannerDisplayDiagnostic("api_key=secret-value\x1b]0;owned\x07");
  for (const width of [40, 64, 80, 120]) {
    const lines = component.render(width);
    const text = lines.join("\n");
    assert.match(text, /!/, `warning marker at ${width}`);
    assert.match(text, /api_key=\[REDACTED\]/, `redacted key at ${width}`);
    assert.doesNotMatch(text, /secret-value|owned/, `no leaked secret at ${width}`);
  }
  setBannerDisplayDiagnostic(undefined);
});

// ─── 4. Diagnostic is never hidden or mistaken for success ────────

test("diagnostic line is distinct from the success identity line", async () => {
  const { pi, handlers } = makePi();
  registerBanner(pi, () => ({ version: 2, banner: { enabled: true } }));
  const headerCalls = [];
  const ctx = { mode: "tui", ui: { setHeader(factory) { headerCalls.push(factory); } } };
  await handlers.get("session_start")({}, ctx);
  const component = headerCalls[0](undefined, plainTheme());

  setBannerDisplayDiagnostic("Ownership conflict detected");
  const lines = component.render(80);
  // Line 1 has ✓ (success rail), line 2 has ! (warning marker)
  assert.match(lines[0], /✓/, "identity line has success rail");
  assert.match(lines[1], /!/, "diagnostic line has warning marker");
  assert.match(lines[1], /Ownership conflict detected/, "diagnostic text visible");
  // Diagnostic line must NOT have ✓
  assert.doesNotMatch(lines[1], /✓/, "diagnostic not mistaken for success");
  setBannerDisplayDiagnostic(undefined);
});

// ─── 5. banner.enabled=false restores built-in header ─────────────

test("banner.enabled=false restores the built-in header instead of setting one", async () => {
  const { pi, handlers } = makePi();
  registerBanner(pi, () => ({ version: 2, banner: { enabled: false } }));

  const headerCalls = [];
  const ctx = { mode: "tui", ui: { setHeader(factory) { headerCalls.push(factory); } } };
  await handlers.get("session_start")({}, ctx);

  assert.equal(headerCalls.length, 1);
  assert.equal(headerCalls[0], undefined);
});

// ─── 6. Non-TUI sessions never touch the header ───────────────────

test("non-tui sessions never touch the header", async () => {
  const { pi, handlers } = makePi();
  registerBanner(pi, () => ({ version: 2, banner: { enabled: true } }));

  const headerCalls = [];
  const ctx = { mode: "headless", ui: { setHeader(factory) { headerCalls.push(factory); } } };
  await handlers.get("session_start")({}, ctx);

  assert.equal(headerCalls.length, 0);
});

// ─── 7. No diagnostic = single identity line ───────────────────────

test("no diagnostic renders only the identity line", async () => {
  const { pi, handlers } = makePi();
  registerBanner(pi, () => ({ version: 2, banner: { enabled: true } }));
  const headerCalls = [];
  const ctx = { mode: "tui", ui: { setHeader(factory) { headerCalls.push(factory); } } };
  await handlers.get("session_start")({}, ctx);
  const component = headerCalls[0](undefined, plainTheme());

  setBannerDisplayDiagnostic(undefined);
  const lines = component.render(80);
  assert.equal(lines.length, 1, "single line without diagnostic");
  assert.match(lines[0], /✓.*π².*pi-square/i, "identity line content");
});

// ─── 8. Bounded at all supported widths with diagnostic ───────────

test("header with diagnostic bounded at all supported widths", async () => {
  const { pi, handlers } = makePi();
  registerBanner(pi, () => ({ version: 2, banner: { enabled: true } }));
  const headerCalls = [];
  const ctx = { mode: "tui", ui: { setHeader(factory) { headerCalls.push(factory); } } };
  await handlers.get("session_start")({}, ctx);
  const component = headerCalls[0](undefined, plainTheme());

  setBannerDisplayDiagnostic("Built-in display ownership conflict: my-extension, other-extension; reload after removing the earlier renderer");
  for (const width of [39, 40, 63, 64, 80, 99, 100, 120]) {
    const lines = component.render(width);
    assert.ok(lines.every((line) => visibleWidth(line) <= width), `bounded at ${width}`);
    assert.ok(lines.length <= 2, `at most 2 lines at ${width}`);
  }
  setBannerDisplayDiagnostic(undefined);
});

let failed = 0;
for (const { name, fn } of tests) {
  try { await fn(); console.log(`PASS: ${name}`); }
  catch (error) { failed += 1; console.error(`FAIL: ${name} — ${error instanceof Error ? error.stack ?? error.message : String(error)}`); }
}
console.log(`\n${tests.length} tests, ${failed} failed`);
if (failed > 0) process.exit(1);
