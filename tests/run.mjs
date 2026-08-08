import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const testsDir = dirname(fileURLToPath(import.meta.url));
const suites = [
  "display/catalog.test.mjs",
  "display/policy.test.mjs",
  "display/sanitize.test.mjs",
  "display/layout.test.mjs",
  "display/components.test.mjs",
  "display/motion.test.mjs",
  "display/runtime.test.mjs",
  "display/tool-renderer.test.mjs",
  "display/diff.test.mjs",
  "display/file-preview.test.mjs",
  "display/manager.test.mjs",
  "display/lifecycle.test.mjs",
  "display/local-execution.test.mjs",
  "display/remote-agent.test.mjs",
  "display/builtins.test.mjs",
  "display/conflicts.test.mjs",
  "display/public-adapter.test.mjs",
  "display/integration.test.mjs",
  "display/operational-state.test.mjs",
  "display/attached-content.test.mjs",
  "display/scheme-motion.test.mjs",
  "display/edit-diffs.test.mjs",
  "display/adapter-bridge.test.mjs",
  "display/write-previews.test.mjs",
  "display/path-list.test.mjs",
  "display/text-search.test.mjs",
  "display/structural-search.test.mjs",
  "display/codegraph.test.mjs",
  "display/pdf-search.test.mjs",
  "display/shell-execution.test.mjs",
  "display/web-search-fetch.test.mjs",
  "display/context7-libs-docs.test.mjs",
  "display/firecrawl-parse.test.mjs",
  "display/github-tools.test.mjs",
  "display/github-tree-commit.test.mjs",
  "display/ssh-sessions.test.mjs",
  "display/ssh-confirmation-input.test.mjs",
  "display/todo-transcript.test.mjs",
  "display/ask-workflow.test.mjs",
  "config.test.mjs",
  "confirmation.test.mjs",
  "native-prompt.test.mjs",
  "prompt-manager.test.mjs",
  "release/package.test.mjs",
  "release/display-export.test.mjs",
  "release/installed-display-export.test.mjs",
  "shell/platform.test.mjs",
  "shell/output.test.mjs",
  "shell/spawn.test.mjs",
  "shell/pwsh.test.mjs",
  "ssh/buffer.test.mjs",
  "ssh/terminal-output.test.mjs",
  "ssh/manager.test.mjs",
  "ssh/tool.test.mjs",
  "ssh/secret-input.test.mjs",
  "ssh/integration.test.mjs",
  "todo.test.mjs",
  "todo/widget.test.mjs",
  "contract.test.mjs",
  "ask/ui.test.mjs",
  "ask/integration.test.mjs",
  "ask/tool.test.mjs",
  "banner/banner.test.mjs",
  ...readdirSync(join(testsDir, "footer"))
    .filter((name) => name.endsWith(".test.mjs"))
    .sort()
    .map((name) => `footer/${name}`),
  "scheme/sandbox.test.mjs",
  "scheme/tool.test.mjs",
  "web/context7-client.test.mjs",
  "web/context7-tools.test.mjs",
  "web/search-fetch-tools.test.mjs",
  "web/parse-tool.test.mjs",
  "pdf-search/pdf-search.test.mjs",
  "github/client.test.mjs",
  "github/tools.test.mjs",
  "codegraph/binary.test.mjs",
  "codegraph/tool.test.mjs",
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
