import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fakeClock, simulatedCacheAdapter } from "./fake-provider.mjs";
import { runExperiment } from "./runner.mjs";

/**
 * The provider-cache experiment command (#225, adapters from #248):
 *
 *   npm run experiment:provider-cache [-- --dry-run] [--json] [--adapter <adapter-module.mjs>]
 *
 * Dry-run is the default: the simulated prefix-cache adapter and a fake clock,
 * no credential, no network call. Credentialed execution passes
 * `--adapter <module.mjs>` pointing at an adapter implementing the contract
 * validated by `runner.mjs` (see `adapters/cache-provider.mjs`); the command
 * then verifies the adapter's declared `requiredEnv` variable *names* are
 * present (never their values) and runs with a real clock. Executing that
 * adapter against the real gateway — the credentials, the run, and the
 * verdict — belongs to #227 and the maintainer; `--real` still refuses here
 * rather than silently degrading. The report is written under a git-ignored
 * directory beside this file, following the #223 qualification pattern, and
 * everything under `tests/` stays outside the npm package.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORT_DIR = join(HERE, "report");
const USAGE = "usage: npm run experiment:provider-cache [-- --dry-run] [--json] [--adapter <adapter-module.mjs>]";

function parseArgs(argv) {
  const options = { json: false, adapterPath: null };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--dry-run") continue;
    else if (flag === "--json") options.json = true;
    else if (flag === "--real") {
      console.error(
        "Credentialed execution is #227, which supplies the credentials and the verdict. This command ships the"
          + " adapter module (#248): run it with --adapter <adapter-module.mjs> from the #227 environment,"
          + " or use --dry-run (the default).",
      );
      process.exit(2);
    } else if (flag === "--adapter") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        console.error("--adapter requires a module path");
        process.exit(2);
      }
      options.adapterPath = value;
      index += 1;
    } else {
      console.error(`${USAGE}\nunknown argument: ${flag}`);
      process.exit(2);
    }
  }
  return options;
}

async function loadAdapter(path) {
  const module = await import(pathToFileURL(path).href);
  const adapter = module.default ?? module.adapter;
  if (!adapter || typeof adapter.send !== "function" || typeof adapter.describePins !== "function") {
    console.error(`adapter module ${path} must default-export an adapter (see fake-provider.mjs for the contract)`);
    process.exit(2);
  }
  return adapter;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  let adapter;
  let clock;
  if (options.adapterPath !== null) {
    adapter = await loadAdapter(options.adapterPath);
    const required = adapter.requiredEnv ?? [];
    const missing = required.filter((name) => !process.env[name]);
    if (missing.length > 0) {
      console.error(`the adapter requires environment variables that are not set: ${missing.join(", ")}`);
      console.error("the command never prints credential values; set them and re-run");
      process.exit(2);
    }
    clock = { now: Date.now, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };
  } else {
    clock = fakeClock();
    adapter = simulatedCacheAdapter({ clock, ttlMs: 300_000 });
  }
  const { json, humanText, exitCode } = await runExperiment({ adapter, clock });

  mkdirSync(REPORT_DIR, { recursive: true });
  const jsonPath = join(REPORT_DIR, "provider-cache-experiment.json");
  writeFileSync(jsonPath, json.endsWith("\n") ? json : `${json}\n`);
  writeFileSync(join(REPORT_DIR, "provider-cache-experiment.txt"), `${humanText}\n`);
  console.log(humanText);
  console.log(`report: ${jsonPath}`);
  if (options.json) console.log(json);
  process.exitCode = exitCode;
}

await main();
