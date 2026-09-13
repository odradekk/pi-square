import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runQualification, runRecoveryComparison } from "./runner.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORT_DIR = resolve(HERE, "report");

function usage() {
  return [
    "Usage: npm run qualify:continuity -- --real [--recovery-ab] [--runtime <module>] [--json]",
    "",
    "This command never makes a provider request unless --real is explicit.",
    "--real runs the symmetric native Pi 24-cell matrix as two concurrent model queues",
    "with sequential cases and requests inside each queue. --recovery-ab instead runs",
    "the separate both-model search-enabled/read-only recovery comparison; it never",
    "changes or substitutes the 24-cell qualification. Both modes refuse a dirty checkout",
    "before any request. Offline regression belongs in the test suite's faux provider.",
    "Final handoffs expose only Pi's native write tool; equivalent workspace paths are",
    "normalized. Cache zeros normalized by Pi without raw presence report as unknown.",
    "Artifacts: continuity-qualification-*.{json,md} or recovery-comparison-*.{json,md},",
    "owner-only continuity-evidence-*.json, and the shared append-only attempts.jsonl.",
  ].join("\n");
}

function parse(argv) {
  const options = { real: false, recoveryAb: false, json: false, runtimePath: null };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--real") options.real = true;
    else if (flag === "--recovery-ab") options.recoveryAb = true;
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
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    const run = options.recoveryAb ? runRecoveryComparison : runQualification;
    const result = await run({
      runtime: await runtimeFrom(options.runtimePath),
      reportDir: REPORT_DIR,
      mode: "real",
      signal: controller.signal,
      onEvent(event) {
        if (event.type === "run-start") console.error(`start: ${event.run.lane}/${event.run.scenario}/${event.run.placement}/${event.run.retrievalArm}`);
        if (event.type === "run-end") console.error(`end:   ${event.run.lane}/${event.run.scenario}/${event.run.placement}/${event.run.retrievalArm} (${event.record.terminal})`);
      },
    });
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
    console.log(options.json ? result.json : result.markdown.trimEnd());
    console.error(`report: ${relative(process.cwd(), result.files.reportMarkdown)}`);
    if (result.files.evidence) console.error(`private evidence: ${relative(process.cwd(), result.files.evidence)}`);
    process.exitCode = ["pass-needs-human-review", "complete-needs-human-review"].includes(result.report.machineStatus) ? 0 : 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(usage());
  process.exitCode = 2;
}
