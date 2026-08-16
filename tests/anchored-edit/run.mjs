import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Runs the full vendored upstream suite (pi-hashline-edit-pro @ 2.5.3) with
// the project-local Vitest installation. The suite runs with its working
// directory set to this directory so upstream fixtures that create temp files
// under `process.cwd()/.tmp` stay inside the vendored test tree.
const suiteDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(suiteDir, "..", "..");
const vitestCli = join(repoRoot, "node_modules", "vitest", "vitest.mjs");

const result = spawnSync(
  process.execPath,
  [vitestCli, "run", "--config", join(suiteDir, "vitest.config.ts")],
  {
    cwd: suiteDir,
    stdio: "inherit",
    env: process.env,
  },
);

if (result.error) {
  console.error("Failed to run the vendored anchored-edit suite:", result.error);
  process.exit(1);
}
process.exit(result.status ?? 1);
