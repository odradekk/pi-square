import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const subagentsDir = resolve(__dirname, "..", "..", "resources", "subagents");

// Minimal YAML parser sufficient for extracting lists from our flat YAML.
function parseList(yamlText, key) {
  const lines = yamlText.split("\n");
  const values = [];
  let inList = false;
  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (new RegExp(`^${key}:\\s*$`).test(trimmed)) {
      inList = true;
      continue;
    }
    if (inList) {
      if (/^  -\s+\S/.test(line)) {
        const match = line.match(/^  -\s+(\S+)/);
        if (match) values.push(match[1]);
      } else if (/^\S/.test(line) && !line.startsWith("#") && !line.startsWith(" ")) {
        inList = false;
      }
    }
  }
  return values;
}

const parseExtensionTools = (yamlText) => parseList(yamlText, "extensionTools");

function loadYaml(name) {
  const path = join(subagentsDir, name);
  return readFileSync(path, "utf8");
}

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

test("librarian has search, fetch, libs, docs but not docs_search", () => {
  const yaml = loadYaml("librarian.yaml");
  const tools = parseExtensionTools(yaml);
  for (const required of ["search", "fetch", "libs", "docs"]) {
    assert.ok(tools.includes(required), `librarian should include ${required} in extensionTools`);
  }
  assert.ok(!tools.includes("docs_search"), "librarian must not include docs_search");
});

test("worker uses the portable shell capability and keeps shell names out of extensionTools", () => {
  const yaml = loadYaml("worker.yaml");
  const tools = parseList(yaml, "tools");
  const extensionTools = parseExtensionTools(yaml);
  assert.ok(tools.includes("shell"), "worker should request the platform shell capability");
  assert.ok(!tools.includes("bash"), "worker should not hard-code bash");
  for (const required of ["search", "fetch", "libs", "docs"]) {
    assert.ok(extensionTools.includes(required), `worker should include ${required} in extensionTools`);
  }
  for (const forbidden of ["docs_search", "pwsh", "bash", "shell"]) {
    assert.ok(!extensionTools.includes(forbidden), `worker extensionTools must not include ${forbidden}`);
  }
});

test("no subagent YAML contains docs_search", () => {
  const files = readdirSync(subagentsDir).filter((f) => f.endsWith(".yaml"));
  for (const file of files) {
    const yaml = loadYaml(file);
    assert.ok(!yaml.includes("docs_search"), `${file} must not contain docs_search`);
  }
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    console.log(`PASS: ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL: ${name} — ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log(`\n${tests.length} tests, ${failed} failed`);
if (failed > 0) process.exit(1);
