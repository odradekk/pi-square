import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const testsDir = dirname(fileURLToPath(import.meta.url));
const suites = [
  "config.test.mjs",
  "native-prompt.test.mjs",
  "prompt-manager.test.mjs",
  "release/package.test.mjs",
  "shell/platform.test.mjs",
  "shell/output.test.mjs",
  "shell/spawn.test.mjs",
  "shell/pwsh.test.mjs",
  "shell/rendering.test.mjs",
  "ssh/buffer.test.mjs",
  "ssh/manager.test.mjs",
  "ssh/tool.test.mjs",
  "ssh/rendering.test.mjs",
  "ssh/integration.test.mjs",
  "todo.test.mjs",
  "todo/widget.test.mjs",
  "todo/rendering.test.mjs",
  "contract.test.mjs",
  "ask/ui.test.mjs",
  "ask/integration.test.mjs",
  "ask/tool.test.mjs",
  "ask/rendering.test.mjs",
  "banner/banner.test.mjs",
  ...readdirSync(join(testsDir, "footer"))
    .filter((name) => name.endsWith(".test.mjs"))
    .sort()
    .map((name) => `footer/${name}`),
  "scheme/sandbox.test.mjs",
  "scheme/tool.test.mjs",
  "scheme/rendering.test.mjs",
  "web/context7-client.test.mjs",
  "web/context7-tools.test.mjs",
  "web/context7-rendering.test.mjs",
  "web/search-fetch-tools.test.mjs",
  "web/parse-tool.test.mjs",
  "pdf-search/pdf-search.test.mjs",
  "github/client.test.mjs",
  "github/tools.test.mjs",
  "github/rendering.test.mjs",
  "codegraph/binary.test.mjs",
  "codegraph/tool.test.mjs",
  "codegraph/rendering.test.mjs",
  "codegraph/integration.test.mjs",
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
