// One diagnostic continuity run against the real primary model, printing the
// full integrity/coverage failure detail for instrument debugging (#325).
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { executeRun, planRuns } from "./runner.mjs";
import { runContinuitySession } from "./session.mjs";

const runtime = await ModelRuntime.create({ allowModelNetwork: false, refreshOnCreate: false });
const planned = planRuns().find((run) => run.scenario === "exact-work" && run.variant === "early");
const model = runtime.getModel(planned.model.provider, planned.model.id);
const record = await executeRun({ runtime, model, run: planned, sessionRunner: runContinuitySession });
console.log("integrity:", JSON.stringify(record.integrity, null, 1));
console.log("coverage:", JSON.stringify(record.coverage, null, 1));
console.log("error:", record.error);
console.log("requests:", JSON.stringify((record.result?.requests ?? []).map(({ phase, request, stopReason, input, cacheRead, cacheWrite, tools }) => ({ phase, request, stopReason, input, cacheRead, cacheWrite, tools })), null, 1));
console.log("measurements:", JSON.stringify(record.result?.measurements, null, 1));
console.log("sourceReads:", JSON.stringify(record.result?.sourceReads, null, 1));
console.log("score:", JSON.stringify(record.score.failures));
