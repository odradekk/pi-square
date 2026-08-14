import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const SUITES = [
  "binary.test.mjs",
  "arguments.test.mjs",
  "runner.test.mjs",
  "rg-output.test.mjs",
  "fd-output.test.mjs",
  "tool-contract.test.mjs",
  "tool-execution.test.mjs",
  "rg-files-only.test.mjs",
];

let failed = 0;

for (const suite of SUITES) {
  console.log(`\n=== ${suite} ===`);
  const result = spawnSync("node", [join(__dirname, suite)], { stdio: "inherit" });
  if (result.status !== 0) {
    failed += 1;
    const detail = result.signal ? `signal ${result.signal}` : `exit ${result.status}`;
    console.error(`${suite} FAILED (${detail})`);
  }
}

console.log(`\n${SUITES.length} suites, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
