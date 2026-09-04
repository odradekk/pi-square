import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
const changesets = JSON.parse(readFileSync(join(packageRoot, ".changeset/config.json"), "utf8"));
const ciWorkflow = readFileSync(join(packageRoot, ".github/workflows/ci.yml"), "utf8");
const releaseWorkflow = readFileSync(join(packageRoot, ".github/workflows/release.yml"), "utf8");

assert.equal(pkg.name, "@odradekk/pi-square");
assert.equal(pkg.private, undefined);
assert.deepEqual(pkg.engines, { node: ">=24 <25" });
assert.deepEqual(pkg.publishConfig, {
  access: "public",
  provenance: true,
  registry: "https://registry.npmjs.org/",
});
assert.deepEqual(pkg.exports, {
  ".": "./src/index.ts",
  "./display": "./src/display-api.ts",
  "./package.json": "./package.json",
});
assert.ok(existsSync(join(packageRoot, "src", "display-api.ts")));
assert.equal(pkg.scripts["version-packages"], "changeset version && npm install --package-lock-only --ignore-scripts");
assert.equal(pkg.scripts.release, "changeset publish");
assert.deepEqual(pkg.peerDependencies, {
  "@earendil-works/pi-ai": "0.84.2",
  "@earendil-works/pi-coding-agent": "0.84.2",
  "@earendil-works/pi-tui": "0.84.2",
  typebox: "1.3.7",
});
assert.equal(changesets.access, "public");
assert.equal(changesets.privatePackages, undefined);
assert.ok(pkg.files.includes("src"));
assert.ok(!pkg.files.includes("bin"));
assert.ok(pkg.files.includes("CHANGELOG.md"));
assert.ok(!pkg.files.includes("tests"));
assert.ok(existsSync(join(packageRoot, "LICENSE")));
assert.match(ciWorkflow, /npm run package:check/);
assert.match(releaseWorkflow, /environment:\n      name: npm/);
assert.match(releaseWorkflow, /id-token: write/);
assert.match(releaseWorkflow, /npm install --global npm@11\.18\.0/);
assert.match(releaseWorkflow, /version: npm run version-packages/);
assert.match(releaseWorkflow, /publish: npm run release/);
assert.doesNotMatch(releaseWorkflow, /NPM_TOKEN/);

const requiredPackFiles = [
  "LICENSE",
  "README.md",
  "THIRD_PARTY_NOTICES.md",
  "package.json",
  "src/index.ts",
  "src/display-api.ts",
  "shadow-minds/example.md",
  "shadow-minds/schema-reference.md",
  "subagents/crawler.yaml",
  "subagents/example_profile.yaml",
  "subagents/explorer.yaml",
  "subagents/generalist.yaml",
];
const rejectedShadowAsset = spawnSync(
  process.execPath,
  [join(packageRoot, "scripts", "verify-pack.mjs")],
  {
    input: JSON.stringify([{
      name: "@odradekk/pi-square",
      size: 1,
      unpackedSize: 1,
      entryCount: requiredPackFiles.length + 1,
      files: [...requiredPackFiles, "shadow-minds/unexpected.md"].map((path) => ({ path })),
    }]),
    encoding: "utf8",
  },
);
assert.notEqual(rejectedShadowAsset.status, 0, "the publication verifier rejects a third Shadow reference asset");
assert.match(rejectedShadowAsset.stderr, /unexpected publication file: shadow-minds\/unexpected\.md/);
for (const name of readdirSync(join(packageRoot, ".changeset"))) {
  if (!name.endsWith(".md") || name === "README.md") continue;
  const content = readFileSync(join(packageRoot, ".changeset", name), "utf8");
  assert.match(content, /^---\n"@odradekk\/pi-square": (patch|minor|major)\n---\n/);
}

console.log("release package metadata tests passed");
