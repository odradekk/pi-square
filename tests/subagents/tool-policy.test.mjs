import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const subagentsDir = resolve(__dirname, "..", "..", "resources", "subagents");

// Minimal YAML parser sufficient for extracting tool lists from our flat YAML.
// Our YAML files use simple `key:` / `- value` syntax under `extensionTools:`.
function parseExtensionTools(yamlText) {
  const lines = yamlText.split("\n");
  const tools = [];
  let inExtensionTools = false;
  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (/^extensionTools:\s*$/.test(trimmed)) {
      inExtensionTools = true;
      continue;
    }
    if (inExtensionTools) {
      if (/^  -\s+\S/.test(line)) {
        const match = line.match(/^  -\s+(\S+)/);
        if (match) tools.push(match[1]);
      } else if (/^\S/.test(line) && !line.startsWith("#") && !line.startsWith(" ")) {
        inExtensionTools = false;
      }
    }
  }
  return tools;
}

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

test("worker has search, fetch, libs, docs but not docs_search", () => {
  const yaml = loadYaml("worker.yaml");
  const tools = parseExtensionTools(yaml);
  for (const required of ["search", "fetch", "libs", "docs"]) {
    assert.ok(tools.includes(required), `worker should include ${required} in extensionTools`);
  }
  assert.ok(!tools.includes("docs_search"), "worker must not include docs_search");
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
