import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import jiti from "jiti";

const packageRoot = resolve(import.meta.dirname, "..", "..");
const load = jiti(import.meta.url, { moduleCache: false });
const { codeGraphPlatformPackage, resolveCodeGraphBinary } = await load(resolve(packageRoot, "src", "codegraph", "binary.ts"));

const expected = new Map([
  ["linux-x64", "@colbymchenry/codegraph-linux-x64"],
  ["linux-arm64", "@colbymchenry/codegraph-linux-arm64"],
  ["darwin-x64", "@colbymchenry/codegraph-darwin-x64"],
  ["darwin-arm64", "@colbymchenry/codegraph-darwin-arm64"],
  ["win32-x64", "@colbymchenry/codegraph-win32-x64"],
  ["win32-arm64", "@colbymchenry/codegraph-win32-arm64"],
]);
for (const [target, packageName] of expected) {
  const [platform, arch] = target.split("-");
  assert.equal(codeGraphPlatformPackage(platform, arch), packageName);
}
assert.throws(() => codeGraphPlatformPackage("freebsd", "x64"), /Unsupported CodeGraph platform/);

const binary = resolveCodeGraphBinary(process.platform, process.arch, packageRoot);
assert.equal(binary.version, "1.4.1");
assert.ok(existsSync(binary.command));
assert.equal(binary.prefixArgs[0], "--liftoff-only");
assert.ok(existsSync(binary.prefixArgs[1]));
assert.match(binary.packageName, new RegExp(`codegraph-${process.platform}-${process.arch}$`));
console.log("codegraph binary tests: OK");
