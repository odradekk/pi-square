import assert from "node:assert/strict";
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

test("tui session_start with banner enabled sets a bounded operational header", async () => {
  const { pi, handlers } = makePi();
  registerBanner(pi, () => ({ version: 2, banner: { enabled: true } }));
  assert.deepEqual([...handlers.keys()], ["session_start"]);

  const headerCalls = [];
  const ctx = { mode: "tui", ui: { setHeader(factory) { headerCalls.push(factory); } } };
  await handlers.get("session_start")({}, ctx);

  assert.equal(headerCalls.length, 1);
  const component = headerCalls[0](undefined, plainTheme());
  setBannerDisplayDiagnostic("api_key=secret-value\x1b]0;owned\x07");
  for (const width of [39, 40, 63, 64, 80, 99, 100, 120]) {
    const lines = component.render(width);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
    assert.ok(lines.some((line) => line.includes("π²")));
    assert.ok(lines.some((line) => /pi-square/i.test(line)));
    assert.ok(lines.some((line) => line.includes("unified local extension")));
    if (width >= 40) assert.ok(lines.some((line) => line.includes("unified local extension package for Pi")));
    assert.match(lines.join("\n"), /api_key=\[REDACTED\]/);
    assert.doesNotMatch(lines.join("\n"), /secret-value|owned/);
  }
  setBannerDisplayDiagnostic(undefined);
});

test("banner.enabled=false restores the built-in header instead of setting one", async () => {
  const { pi, handlers } = makePi();
  registerBanner(pi, () => ({ version: 2, banner: { enabled: false } }));

  const headerCalls = [];
  const ctx = { mode: "tui", ui: { setHeader(factory) { headerCalls.push(factory); } } };
  await handlers.get("session_start")({}, ctx);

  assert.equal(headerCalls.length, 1);
  assert.equal(headerCalls[0], undefined);
});

test("non-tui sessions never touch the header", async () => {
  const { pi, handlers } = makePi();
  registerBanner(pi, () => ({ version: 2, banner: { enabled: true } }));

  const headerCalls = [];
  const ctx = { mode: "headless", ui: { setHeader(factory) { headerCalls.push(factory); } } };
  await handlers.get("session_start")({}, ctx);

  assert.equal(headerCalls.length, 0);
});

let failed = 0;
for (const { name, fn } of tests) {
  try { await fn(); console.log(`PASS: ${name}`); }
  catch (error) { failed += 1; console.error(`FAIL: ${name} — ${error instanceof Error ? error.stack ?? error.message : String(error)}`); }
}
console.log(`\n${tests.length} tests, ${failed} failed`);
if (failed > 0) process.exit(1);
