import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import jiti from "jiti";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const load = jiti(import.meta.url, { moduleCache: false });
const registerBanner = (await load(join(packageRoot, "src", "banner", "index.ts"))).default;
const tests = [];

function test(name, fn) { tests.push({ name, fn }); }
function plainTheme() {
  return { fg(_color, text) { return text; }, bold(text) { return text; } };
}

function makePi() {
  const handlers = new Map();
  return { pi: { on(name, handler) { handlers.set(name, handler); } }, handlers };
}

test("tui session_start with banner enabled sets a header that renders the π² mark", async () => {
  const { pi, handlers } = makePi();
  registerBanner(pi, () => ({ version: 2, footer: { mode: "enhanced" }, banner: { enabled: true } }));
  assert.deepEqual([...handlers.keys()], ["session_start"]);

  const headerCalls = [];
  const ctx = { mode: "tui", ui: { setHeader(factory) { headerCalls.push(factory); } } };
  await handlers.get("session_start")({}, ctx);

  assert.equal(headerCalls.length, 1);
  const component = headerCalls[0](undefined, plainTheme());
  const lines = component.render(80);
  assert.ok(lines.some((line) => line.includes("π²")));
  assert.ok(lines.some((line) => line.includes("pi-square")));
  assert.ok(lines.some((line) => line.includes("unified local extension package for Pi")));
});

test("banner.enabled=false restores the built-in header instead of setting one", async () => {
  const { pi, handlers } = makePi();
  registerBanner(pi, () => ({ version: 2, footer: { mode: "enhanced" }, banner: { enabled: false } }));

  const headerCalls = [];
  const ctx = { mode: "tui", ui: { setHeader(factory) { headerCalls.push(factory); } } };
  await handlers.get("session_start")({}, ctx);

  assert.equal(headerCalls.length, 1);
  assert.equal(headerCalls[0], undefined);
});

test("non-tui sessions never touch the header", async () => {
  const { pi, handlers } = makePi();
  registerBanner(pi, () => ({ version: 2, footer: { mode: "enhanced" }, banner: { enabled: true } }));

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
