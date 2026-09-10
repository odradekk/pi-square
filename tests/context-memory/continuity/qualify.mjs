import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runQualification } from "./runner.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORT_DIR = resolve(HERE, "report");

function usage() {
  return [
    "Usage: npm run qualify:continuity -- --real [--runtime <module>] [--json]",
    "",
    "This command never makes a provider request unless --real is explicit.",
    "--real runs the fixed native Pi 16-run matrix. It refuses a dirty checkout",
    "before any request. Offline regression belongs in the test suite's faux provider.",
  ].join("\n");
}

function parse(argv) {
  const options = { real: false, json: false, runtimePath: null };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--real") options.real = true;
    else if (flag === "--json") options.json = true;
    else if (flag === "--runtime") { options.runtimePath = argv[++index]; if (!options.runtimePath) throw new Error("--runtime requires a module path"); }
    else if (flag === "--help" || flag === "-h") return null;
    else throw new Error(`unknown argument: ${flag}`);
  }
  return options;
}

async function runtimeFrom(path) {
  if (!path) return undefined;
  const module = await import(pathToFileURL(resolve(process.cwd(), path)).href);
  return module.default ?? module.runtime ?? module.createRuntime?.();
}

try {
  const options = parse(process.argv.slice(2));
  if (!options || !options.real) {
    console.log(usage());
  } else {
    const result = await runQualification({
      runtime: await runtimeFrom(options.runtimePath),
      reportDir: REPORT_DIR,
      mode: "real",
      onEvent(event) {
        if (event.type === "run-start") console.error(`start: ${event.run.scenario}/${event.run.variant}/${event.run.arm}`);
        if (event.type === "run-end") console.error(`end:   ${event.run.scenario}/${event.run.variant}/${event.run.arm} (${event.record.score.result})`);
      },
    });
    console.log(options.json ? result.json : result.markdown.trimEnd());
    console.error(`report: ${relative(process.cwd(), result.files.reportMarkdown)}`);
    if (result.files.evidence) console.error(`private evidence: ${relative(process.cwd(), result.files.evidence)}`);
    process.exitCode = result.report.machineStatus === "pass-needs-human-review" ? 0 : 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(usage());
  process.exitCode = 2;
}
