import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fakeClock, simulatedCacheAdapter } from "./fake-provider.mjs";
import { runExperiment } from "./runner.mjs";

/**
 * The provider-cache experiment command (#225):
 *
 *   npm run experiment:provider-cache [-- --dry-run] [--json]
 *
 * Dry-run is the default and the only mode this slice ships. Credentialed
 * execution against a real provider belongs to #227, which provides the real
 * adapter; `--real` refuses here rather than silently degrading. The report is
 * written under a git-ignored directory beside this file, following the #223
 * qualification pattern, and everything under `tests/` stays outside the npm
 * package.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORT_DIR = join(HERE, "report");
const USAGE = "usage: npm run experiment:provider-cache [-- --dry-run] [--json]";

async function main() {
  const args = process.argv.slice(2);
  const unknown = args.filter((arg) => arg !== "--dry-run" && arg !== "--json" && arg !== "--real");
  if (args.includes("--real")) {
    console.error(
      "This slice (#225) ships no credentialed provider adapter. Real-provider execution is #227,"
        + " which supplies the adapter and the credentials. Run with --dry-run (the default).",
    );
    process.exitCode = 2;
    return;
  }
  if (unknown.length > 0) {
    console.error(`${USAGE}\nunknown argument: ${unknown[0]}`);
    process.exitCode = 2;
    return;
  }

  const clock = fakeClock();
  const adapter = simulatedCacheAdapter({ clock, ttlMs: 300_000 });
  const { json, humanText, exitCode } = await runExperiment({ adapter, clock });

  mkdirSync(REPORT_DIR, { recursive: true });
  const jsonPath = join(REPORT_DIR, "provider-cache-experiment.json");
  writeFileSync(jsonPath, json.endsWith("\n") ? json : `${json}\n`);
  writeFileSync(join(REPORT_DIR, "provider-cache-experiment.txt"), `${humanText}\n`);
  console.log(humanText);
  console.log(`report: ${jsonPath}`);
  if (args.includes("--json")) console.log(json);
  process.exitCode = exitCode;
}

await main();
