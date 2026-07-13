import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const testsDir = dirname(fileURLToPath(import.meta.url));
const suites = [
  "config.test.mjs",
  "native-prompt.test.mjs",
  "prompt-manager.test.mjs",
  "todo.test.mjs",
  "contract.test.mjs",
  "ask/ui.test.mjs",
  "banner/banner.test.mjs",
  "statusline/statusline.test.mjs",
  "scheme/sandbox.test.mjs",
  "web/context7-client.test.mjs",
  "web/context7-tools.test.mjs",
  "web/context7-rendering.test.mjs",
  "web/search-fetch-tools.test.mjs",
  "search/run.mjs",
  ...readdirSync(join(testsDir, "subagents"))
    .filter((name) => name.endsWith(".test.mjs"))
    .sort()
    .map((name) => `subagents/${name}`),
];

let failures = 0;
for (const suite of suites) {
  console.log(`\n==> ${suite}`);
  const result = spawnSync(process.execPath, [join(testsDir, suite)], {
    cwd: dirname(testsDir),
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) failures += 1;
}

console.log(`\n${suites.length} suites, ${failures} failed`);
process.exit(failures > 0 ? 1 : 0);
