import { randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

const STAGES = Object.freeze([
  {
    name: "Data ingestion and normalization",
    fact: "data namespace identifier",
    command: "normalize",
    prompt: `Implement the \`normalize\` command in \`cli.mjs\`. It reads one JSON object from stdin and writes exactly one JSON object to stdout. The input is \`{ records }\`, where \`records\` is an array of one to fifty objects with \`id\`, \`name\`, \`amount\`, and \`tags\`. Return only \`{ records }\`, with no source-only fields: trim and lowercase ids; collapse internal whitespace in names and title-case each word; coerce finite numeric amounts; trim/lowercase tags, remove duplicates, and sort tags; preserve record order. Reject a missing records array, a non-object record, a missing required field, a non-finite amount, or a non-array tags field with a non-zero exit and a concise stderr message. Keep command dispatch and JSON parsing ordinary and readable: later stages will extend this same CLI.\n\nThis is an eight-stage project. A project identifier is released after each stage first passes. Preserve the complete stage-to-identifier mapping for the final delivery.`,
  },
  {
    name: "Data validation",
    fact: "validation profile identifier",
    command: "validate",
    prompt: `Implement \`validate\` as the next pipeline command. The data namespace identifier released after Data ingestion and normalization is now a required project constant: embed and return it as \`namespace\`. Given normalized \`{ records }\`, return \`{ namespace, valid, errors }\`. A record is valid only when \`id\` is a non-empty string and \`amount\` is a finite number greater than or equal to zero. \`errors\` is in input order and contains \`{ index, code }\`, with \`id\` before \`amount\` when both fail. Keep \`normalize\` working and share ordinary parsing/validation helpers where useful.`,
  },
  {
    name: "Deduplication and conflict handling",
    fact: "deduplication policy identifier",
    command: "dedupe",
    prompt: `Implement \`dedupe\` as the pipeline's conflict step. Use the named data namespace and validation profile identifiers released by the two completed stages as project constants. Given validated \`{ records }\`, keep the first record for each id and report later duplicates. Return \`{ namespace, profile, records, conflicts }\`; \`conflicts\` contains \`{ id, keptIndex, droppedIndex }\` in encounter order. The returned \`namespace\` and \`profile\` must be those two project constants. Keep all earlier commands working.`,
  },
  {
    name: "Partition routing",
    fact: "routing version identifier",
    command: "route",
    prompt: `Implement \`route\`. Use the validation profile and deduplication policy identifiers released by the preceding stages as project constants. Given \`{ records }\`, partition records by the first lowercase character of \`id\`: \`a-m\` goes to \`primary\`, \`n-z\` to \`secondary\`, and every other id to \`quarantine\`. Return \`{ profile, policy, partitions }\`, where each partition preserves input order. Keep every earlier command working.`,
  },
  {
    name: "Incremental processing and checkpoints",
    fact: "checkpoint namespace identifier",
    command: "checkpoint",
    prompt: `Implement \`checkpoint\`. Use the original data namespace identifier and the routing version identifier released after Partition routing as project constants. Given \`{ cursor, records }\`, return \`{ namespace, routingVersion, nextCursor, records }\`. \`cursor\` is a non-negative integer; return records after that zero-based cursor, at most two records, and set \`nextCursor\` to \`cursor + returned records.length\`. Keep every earlier command working.`,
  },
  {
    name: "Failure recovery",
    fact: "recovery protocol identifier",
    command: "recover",
    prompt: `Implement \`recover\`. Use the deduplication policy identifier and checkpoint namespace identifier released by completed stages as project constants. Given \`{ checkpoint, failed }\`, return \`{ policy, checkpointNamespace, resumeCursor, retry }\`. \`resumeCursor\` is \`checkpoint.nextCursor\` when it is a non-negative integer, otherwise 0. \`retry\` is the unique failed ids in first-seen order. Keep every earlier command working.`,
  },
  {
    name: "Audit and consistency checks",
    fact: "audit profile identifier",
    command: "audit",
    prompt: `Implement \`audit\`. Use the original data namespace identifier and the recovery protocol identifier released after Failure recovery as project constants. Given \`{ records, checkpoint }\`, return \`{ namespace, recoveryProtocol, consistent, issues }\`. \`consistent\` is true exactly when ids are unique and \`checkpoint.nextCursor\` is a non-negative integer no greater than \`records.length\`. \`issues\` is \`["duplicate-id"]\`, \`["checkpoint-range"]\`, or both in that order. Keep every earlier command working.`,
  },
  {
    name: "Integrated delivery",
    fact: "final delivery identifier",
    command: "deliver",
    prompt: `Implement \`deliver\` as the integrated pipeline entry point. Use every released project constant: namespace, validation profile, deduplication policy, routing version, checkpoint namespace, recovery protocol, and audit profile. Its input schema is \`{ command:"deliver", records:RawRecord[], cursor:nonNegativeInteger, failed:string[] }\`. Normalize, validate, deduplicate, route the deduplicated records, checkpoint those records at cursor, recover that checkpoint with failed ids, then audit the deduplicated records against that checkpoint. Return \`{ namespace, profile, policy, routingVersion, checkpointNamespace, recoveryProtocol, auditProfile, delivered, count, nextCursor, retry, partitions }\`; retry is unique failed ids in first-seen order, and nextCursor is the checkpoint result. Deliver only when validation and audit are consistent and there are no duplicate conflicts; then count is the deduplicated count, otherwise 0. Keep every earlier command working.`,
  },
]);

const cases = (flags) => [
  { probes: [
    { input: { command: "normalize", records: [{ id: " A-1 ", name: "  aLICE   jONES ", amount: "12.50", tags: [" Blue", "blue", "new "] }, { id: "b-2", name: "BOB", amount: 3, tags: [] }] }, expected: { records: [{ id: "a-1", name: "Alice Jones", amount: 12.5, tags: ["blue", "new"] }, { id: "b-2", name: "Bob", amount: 3, tags: [] }] } },
    { input: { command: "normalize", records: [{ id: " C-3 ", name: "o'CONNOR", amount: "0", tags: ["Z", "a", "z"] }] }, expected: { records: [{ id: "c-3", name: "O'connor", amount: 0, tags: ["a", "z"] }] } },
    { input: { command: "normalize", records: "not-an-array" }, expectedExit: "nonzero", fieldPath: "input.records" },
  ], code: "normalization" },
  { probes: [{ input: { command: "validate", records: [{ id: "a-1", amount: 12.5 }] }, expected: { namespace: flags[0], valid: true, errors: [] } }, { input: { command: "validate", records: [{ id: "a-1", amount: 12.5 }, { id: "b-2", amount: -3 }, { id: "", amount: -1 }] }, expected: { namespace: flags[0], valid: false, errors: [{ index: 1, code: "amount" }, { index: 2, code: "id" }, { index: 2, code: "amount" }] } }], code: "validation" },
  { probes: [{ input: { command: "dedupe", records: [{ id: "a-1" }, { id: "b-2" }, { id: "a-1" }, { id: "b-2" }] }, expected: { namespace: flags[0], profile: flags[1], records: [{ id: "a-1" }, { id: "b-2" }], conflicts: [{ id: "a-1", keptIndex: 0, droppedIndex: 2 }, { id: "b-2", keptIndex: 1, droppedIndex: 3 }] } }, { input: { command: "dedupe", records: [{ id: "only" }] }, expected: { namespace: flags[0], profile: flags[1], records: [{ id: "only" }], conflicts: [] } }], code: "deduplication" },
  { probes: [{ input: { command: "route", records: [{ id: "alpha" }, { id: "zeta" }, { id: "7bad" }, { id: "mango" }] }, expected: { profile: flags[1], policy: flags[2], partitions: { primary: [{ id: "alpha" }, { id: "mango" }], secondary: [{ id: "zeta" }], quarantine: [{ id: "7bad" }] } } }, { input: { command: "route", records: [{ id: "m" }, { id: "n" }, { id: "A" }] }, expected: { profile: flags[1], policy: flags[2], partitions: { primary: [{ id: "m" }], secondary: [{ id: "n" }], quarantine: [{ id: "A" }] } } }], code: "routing" },
  { probes: [{ input: { command: "checkpoint", cursor: 1, records: [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }] }, expected: { namespace: flags[0], routingVersion: flags[3], nextCursor: 3, records: [{ id: "b" }, { id: "c" }] } }, { input: { command: "checkpoint", cursor: 3, records: [{ id: "a" }, { id: "b" }, { id: "c" }] }, expected: { namespace: flags[0], routingVersion: flags[3], nextCursor: 3, records: [] } }], code: "checkpoint" },
  { probes: [{ input: { command: "recover", checkpoint: { nextCursor: 3 }, failed: ["b", "a", "b", "c", "a"] }, expected: { policy: flags[2], checkpointNamespace: flags[4], resumeCursor: 3, retry: ["b", "a", "c"] } }, { input: { command: "recover", checkpoint: {}, failed: [] }, expected: { policy: flags[2], checkpointNamespace: flags[4], resumeCursor: 0, retry: [] } }], code: "recovery" },
  { probes: [{ input: { command: "audit", records: [{ id: "a" }, { id: "a" }], checkpoint: { nextCursor: 1 } }, expected: { namespace: flags[0], recoveryProtocol: flags[5], consistent: false, issues: ["duplicate-id"] } }, { input: { command: "audit", records: [{ id: "a" }], checkpoint: { nextCursor: 4 } }, expected: { namespace: flags[0], recoveryProtocol: flags[5], consistent: false, issues: ["checkpoint-range"] } }, { input: { command: "audit", records: [{ id: "a" }], checkpoint: { nextCursor: 1 } }, expected: { namespace: flags[0], recoveryProtocol: flags[5], consistent: true, issues: [] } }], code: "audit" },
  { probes: [{ input: { command: "deliver", records: [{ id: " A ", name: "alice", amount: 1, tags: [] }, { id: "b", name: "bob", amount: 2, tags: [] }], cursor: 0, failed: ["b", "a", "b"] }, expected: { namespace: flags[0], profile: flags[1], policy: flags[2], routingVersion: flags[3], checkpointNamespace: flags[4], recoveryProtocol: flags[5], auditProfile: flags[6], delivered: true, count: 2, nextCursor: 2, retry: ["b", "a"], partitions: { primary: [{ id: "a", name: "Alice", amount: 1, tags: [] }, { id: "b", name: "Bob", amount: 2, tags: [] }], secondary: [], quarantine: [] } } }, { input: { command: "deliver", records: [{ id: "A", name: "alice", amount: 1, tags: [] }, { id: "a", name: "again", amount: 2, tags: [] }], cursor: 0, failed: [] }, expected: { namespace: flags[0], profile: flags[1], policy: flags[2], routingVersion: flags[3], checkpointNamespace: flags[4], recoveryProtocol: flags[5], auditProfile: flags[6], delivered: false, count: 0, nextCursor: 1, retry: [], partitions: { primary: [{ id: "a", name: "Alice", amount: 1, tags: [] }], secondary: [], quarantine: [] } } }], code: "delivery" },
];

function generatedFlags() {
  return Array.from({ length: 8 }, () => `psq-${randomBytes(18).toString("base64url")}`);
}

/** Diagnostics expose ordinary scalar expectations, never a whole expected
 * object: a deliberately wrong-shaped answer must not retrieve hidden flags. */
function difference(actual, expected, flags, path = "output") {
  if (isDeepStrictEqual(actual, expected)) return null;
  const source = flags.indexOf(expected);
  if (source !== -1) return { fieldPath: path, sourceStage: source + 1, expected: "project constant from the named source stage" };
  if (expected === null || typeof expected !== "object") return { fieldPath: path, expected: expected === undefined ? "field absent" : expected };
  if (actual === null || typeof actual !== "object" || Array.isArray(actual) !== Array.isArray(expected)) {
    return { fieldPath: path, expected: Array.isArray(expected) ? "array" : "object" };
  }
  for (const key of Object.keys(expected)) {
    const found = difference(actual[key], expected[key], flags, `${path}.${key}`);
    if (found) return found;
  }
  return { fieldPath: path, expected: "only the declared fields and array elements" };
}

/** Creates private task material. The coordinator alone owns flag issuance. */
export function createTask({ flags = generatedFlags() } = {}) {
  if (!Array.isArray(flags) || flags.length !== 8 || flags.some((value) => typeof value !== "string" || value.length < 16)) {
    throw new TypeError("flags must be eight high-entropy strings");
  }
  const taskFlags = [...flags];
  const taskCases = cases(taskFlags);
  return {
    flags: taskFlags,
    openingPrompt: "Build a local JSON data-processing CLI one stage at a time. You will receive only the current stage. Each first successful stage releases one high-entropy project identifier; retain the exact stage-to-identifier mapping because final delivery requires all eight. Run the verifier whenever you need feedback.",
    prompt(stage) {
      if (!Number.isInteger(stage) || stage < 1 || stage > STAGES.length) throw new RangeError("stage must be 1 through 8");
      return STAGES[stage - 1].prompt;
    },
    setupFiles: {
      "package.json": '{"type":"module","private":true}\n',
      "cli.mjs": `import { readFileSync } from "node:fs";\n\nconst input = JSON.parse(readFileSync(0, "utf8"));\nconst fail = (message) => { process.stderr.write(message + "\\n"); process.exitCode = 1; };\n\n// Implement the currently revealed command.\nfail(\`unknown command: \${input?.command ?? ""}\`);\n`,
      "README.md": "# Incremental data CLI\n\nRead one JSON object from stdin and write one JSON object to stdout. Implement only the stage currently revealed by the coordinator.\n",
    },
    async verify(stage, execute, signal) {
      if (!Number.isInteger(stage) || stage < 1 || stage > STAGES.length) throw new RangeError("stage must be 1 through 8");
      if (typeof execute !== "function") throw new TypeError("execute must be a function");
      const failures = [];
      for (let index = 0; index < stage; index += 1) {
        const test = taskCases[index];
        const failure = (caseNumber, behavior, details = {}) => ({ stage: index + 1, case: caseNumber, behavior, sourceStage: null, ...details });
        let matched = true; let failedProbe = null;
        for (let probeIndex = 0; probeIndex < (test.probes ?? [test]).length; probeIndex += 1) {
          const probe = (test.probes ?? [test])[probeIndex];
          let result;
          try { result = await execute(probe.input, signal); }
          catch (error) { if (signal?.aborted || error?.name === "AbortError" || error?.name === "SandboxError") throw error; failures.push(failure(probeIndex + 1, "execution")); matched = false; break; }
          if (probe.expectedExit === "nonzero") { if (!result || result.exitCode === 0) failures.push(failure(probeIndex + 1, "invalid-input", { fieldPath: probe.fieldPath, expected: "non-zero exit" })); continue; }
          if (!result || result.exitCode !== 0) { failures.push(failure(probeIndex + 1, "process")); matched = false; break; }
          let actual;
          try { actual = JSON.parse(result.stdout); }
          catch { failures.push(failure(probeIndex + 1, "json-output")); matched = false; break; }
          if (!isDeepStrictEqual(actual, probe.expected)) { matched = false; failedProbe = probeIndex + 1; failures.push(failure(probeIndex + 1, test.code, difference(actual, probe.expected, taskFlags))); break; }
        }
        if (!matched && !failures.some((item) => item.stage === index + 1)) failures.push(failure(failedProbe, test.code));
      }
      return { ok: failures.length === 0, failures };
    },
  };
}
