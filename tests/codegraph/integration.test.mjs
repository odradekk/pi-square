import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import jiti from "jiti";

const packageRoot = resolve(import.meta.dirname, "..", "..");
const load = jiti(import.meta.url, { moduleCache: false });
const { createCodeGraphDefinition } = await load(join(packageRoot, "src", "codegraph", "index.ts"));
const root = mkdtempSync(join(tmpdir(), "pi-codegraph-integration-"));
mkdirSync(join(root, "src"));
writeFileSync(join(root, "package.json"), JSON.stringify({ name: "codegraph-fixture", private: true, type: "module" }));
writeFileSync(join(root, "src", "service.ts"), [
  "export function formatName(name: string): string {",
  "  return name.trim().toUpperCase();",
  "}",
  "",
  "export function greet(name: string): string {",
  "  return `Hello ${formatName(name)}`;",
  "}",
  "",
].join("\n"));

const ctx = {
  cwd: root,
  hasUI: true,
  ui: { confirm: async () => true },
};

try {
  const definition = createCodeGraphDefinition(true);
  const updates = [];
  const initialized = await definition.execute("init", { operation: "init" }, undefined, (value) => updates.push(value), ctx);
  assert.equal(initialized.details.phase, "done", initialized.content?.[0]?.text);
  assert.equal(initialized.details.status.initialized, true);
  assert.ok(initialized.details.status.fileCount >= 1);
  assert.ok(updates.length >= 1);

  const status = await definition.execute("status", { operation: "status" }, undefined, undefined, ctx);
  assert.equal(status.details.phase, "done");
  assert.equal(status.details.status.initialized, true);

  writeFileSync(join(root, "src", "service.ts"), [
    "export function formatName(name: string): string {",
    "  return name.trim().toUpperCase();",
    "}",
    "",
    "export function greet(name: string): string {",
    "  const formatted = formatName(name);",
    "  return `Welcome ${formatted}`;",
    "}",
    "",
  ].join("\n"));

  const explored = await definition.execute(
    "explore",
    { operation: "explore", query: "How does greet format a name?", maxFiles: 3 },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(explored.details.phase, "done", explored.content?.[0]?.text);
  assert.equal(explored.details.autoSynced, true);
  assert.match(explored.content[0].text, /greet|formatName/);
  assert.doesNotMatch(explored.content[0].text, /\x1b/);
  console.log("codegraph real CLI integration tests: OK");
} finally {
  rmSync(root, { recursive: true, force: true });
}
