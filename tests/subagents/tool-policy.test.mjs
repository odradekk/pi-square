import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import jiti from "jiti";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, "..", "..");
const subagentsDir = join(packageRoot, "subagents");
const load = jiti(import.meta.url, { moduleCache: false });
const { resolveSubagentTools } = await load(join(packageRoot, "src", "subagents", "tool-policy.ts"));

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

function loadYaml(name) {
  return readFileSync(join(subagentsDir, name), "utf8");
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const matrix = {
  "explorer.yaml": {
    tools: ["read", "ls"],
    extensionTools: ["rg", "fd", "codegraph"],
    skills: ["none"],
  },
  "oracle.yaml": {
    tools: ["read", "ls"],
    extensionTools: ["rg", "fd", "codegraph"],
    skills: ["none"],
  },
  "crawler.yaml": {
    tools: ["read"],
    extensionTools: ["search", "fetch", "libs", "docs"],
    skills: ["none"],
  },
  "librarian.yaml": {
    tools: ["none"],
    extensionTools: ["github"],
    skills: ["none"],
  },
  "generalist.yaml": {
    tools: ["read", "write", "edit", "shell", "ls"],
    extensionTools: ["rg", "fd", "codegraph", "search", "fetch", "libs", "docs"],
    skills: [],
  },
};

test("bundled role tool and skill capabilities match the least-privilege matrix", () => {
  for (const [file, expected] of Object.entries(matrix)) {
    const yaml = loadYaml(file);
    assert.deepEqual(parseList(yaml, "tools"), expected.tools, `${file} built-in tools`);
    assert.deepEqual(parseList(yaml, "extensionTools"), expected.extensionTools, `${file} extension tools`);
    assert.deepEqual(parseList(yaml, "skills"), expected.skills, `${file} skills`);
  }
});

test("none disables every built-in while preserving explicit extension tools", () => {
  const resolved = resolveSubagentTools({
    tools: ["none"],
    extensionTools: ["github"],
  }, "linux");
  assert.deepEqual(resolved.errors, []);
  assert.deepEqual(resolved.builtInTools, []);
  assert.deepEqual(resolved.extensionTools, ["github"]);
  assert.deepEqual(resolved.persistedTools, ["none"]);
  assert.deepEqual(resolved.persistedExtensionTools, ["github"]);
});

test("none is case-insensitive, mutually exclusive, and fails closed", () => {
  const resolved = resolveSubagentTools({ tools: ["NONE", "read"] }, "linux");
  assert.deepEqual(resolved.builtInTools, []);
  assert.deepEqual(resolved.extensionTools, []);
  assert.deepEqual(resolved.persistedTools, ["none"]);
  assert.ok(resolved.errors.some((error) => error.includes("must be the only entry")));
});

test("omitted tools retain portable runtime defaults", () => {
  const linux = resolveSubagentTools({}, "linux");
  const windows = resolveSubagentTools({}, "win32");
  assert.ok(linux.builtInTools.includes("bash"));
  assert.ok(!linux.extensionTools.includes("pwsh"));
  assert.ok(!windows.builtInTools.includes("bash"));
  assert.ok(windows.extensionTools.includes("pwsh"));
  assert.ok(linux.persistedTools.includes("shell"));
  assert.ok(windows.persistedTools.includes("shell"));
});

test("no bundled subagent requests legacy, platform-specific, or misplaced tools", () => {
  const files = readdirSync(subagentsDir).filter((file) => file.endsWith(".yaml"));
  for (const file of files) {
    const yaml = loadYaml(file);
    const extensionTools = parseList(yaml, "extensionTools");
    assert.ok(!yaml.includes("docs_search"), `${file} must not contain docs_search`);
    for (const forbidden of ["bash", "pwsh", "shell", "none"]) {
      assert.ok(!extensionTools.includes(forbidden), `${file} must not place ${forbidden} in extensionTools`);
    }
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
