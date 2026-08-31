import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createFakeAdapter } from "./fake-model.mjs";
import { runQualification } from "./runner.mjs";

/**
 * The Context Memory continuity qualification command (#224).
 *
 * `npm run qualify:continuity` executes the full 16-run matrix in dry-run
 * mode with the scripted fake adapter: no provider credential is read, no
 * network call is made, and the resulting report proves the machinery —
 * orchestration, scoring, report shape, failure propagation — never release
 * readiness.
 *
 * Real qualification (#227) passes `--adapter <module.mjs>` pointing at an
 * adapter module implementing the contract in `runner.mjs`. The command then
 * verifies the adapter's declared `requiredEnv` variable *names* are present
 * (never their values) and runs the same matrix in real mode.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORT_DIR = join(HERE, "report");

function parseArgs(argv) {
  const options = { json: false, adapterPath: null };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--json") options.json = true;
    else if (flag === "--adapter") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        console.error("--adapter requires a module path");
        process.exit(2);
      }
      options.adapterPath = value;
      index += 1;
    } else {
      console.error(`unknown argument: ${flag}`);
      console.error("usage: qualify.mjs [--json] [--adapter <adapter-module.mjs>]");
      process.exit(2);
    }
  }
  return options;
}

async function loadAdapter(path) {
  const module = await import(pathToFileURL(path).href);
  const adapter = module.default ?? module.adapter;
  if (!adapter) {
    console.error(`adapter module ${path} must default-export an adapter (see fake-model.mjs)`);
    process.exit(2);
  }
  return adapter;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  let adapter = createFakeAdapter();
  let mode = "dry-run";
  if (options.adapterPath !== null) {
    adapter = await loadAdapter(options.adapterPath);
    const required = adapter?.requiredEnv ?? adapter?.declaration?.requiredEnv ?? [];
    const missing = required.filter((name) => !process.env[name]);
    if (missing.length > 0) {
      console.error(`real-mode adapter requires environment variables that are not set: ${missing.join(", ")}`);
      console.error("the command never prints credential values; set them and re-run");
      process.exit(2);
    }
    mode = "real";
  }

  const { report, json, markdown } = await runQualification({ adapter, reportDir: REPORT_DIR, mode });
  if (options.json) console.log(json);
  else console.log(markdown.trimEnd());
  process.exitCode = report.result === "pass" ? 0 : 1;
}

await main();
