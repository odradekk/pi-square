import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import jiti from "jiti";

const load = jiti(import.meta.url, { moduleCache: false });
const { MEMORY_STATE_CUSTOM_TYPE, MEMORY_STATE_FORMAT_TAG } = await load("../../../src/context-memory/format.ts");

const SCHEMA = "pi-square.context-memory/pi-session-cache-sequence/2";
const MATRIX_SCHEMA = "pi-square.context-memory/pi-session-cache-matrix/2";
const DEFAULT_CONTEXT_WINDOW = 100_000;
const COMPRESSION_THRESHOLD = 3_500;
const MEMORY_BUDGET_PERCENT = 1;
const REFERENCE_FILE = "reference.txt";
const REFERENCE_MATERIAL = [
  "Stable operational reference for the measurement lane: the build entry registers every feature module,",
  "the footer derives usage from the read-only context, and the theme pair ships two calibrated palettes.",
  "This local evidence payload is the ordinary tool work each prompt round reads before any compression. ",
].join("\n").repeat(24);

function usageRow(message, promptIndex, requestIndex) {
  const usage = message.usage ?? {};
  const input = Number.isSafeInteger(usage.input) && usage.input >= 0 ? usage.input : null;
  const output = Number.isSafeInteger(usage.output) && usage.output >= 0 ? usage.output : null;
  const cacheRead = Number.isSafeInteger(usage.cacheRead) && usage.cacheRead >= 0 ? usage.cacheRead : null;
  const cacheWrite = Number.isSafeInteger(usage.cacheWrite) && usage.cacheWrite >= 0 ? usage.cacheWrite : null;
  const promptTokens = input === null || cacheRead === null || cacheWrite === null
    ? null
    : input + cacheRead + cacheWrite;
  return {
    prompt: promptIndex,
    request: requestIndex,
    stopReason: typeof message.stopReason === "string" ? message.stopReason : "unknown",
    toolNames: Array.isArray(message.content)
      ? message.content.filter((part) => part?.type === "toolCall").map((part) => part.name)
      : [],
    input,
    output,
    cacheRead,
    cacheWrite,
    promptTokens,
    hitRate: promptTokens && cacheRead !== null ? cacheRead / promptTokens : null,
    cost: typeof usage.cost?.total === "number" && Number.isFinite(usage.cost.total)
      ? usage.cost.total
      : null,
  };
}

function aggregate(rows) {
  let input = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let reported = 0;
  for (const row of rows) {
    if (row.input === null || row.cacheRead === null || row.cacheWrite === null) continue;
    input += row.input;
    cacheRead += row.cacheRead;
    cacheWrite += row.cacheWrite;
    reported += 1;
  }
  const promptTokens = input + cacheRead + cacheWrite;
  return {
    requests: rows.length,
    reported,
    input,
    cacheRead,
    cacheWrite,
    promptTokens,
    hitRate: promptTokens > 0 ? cacheRead / promptTokens : null,
  };
}

/** Block count a recorded Memory state entry carries (#319 custom entries, not compactions). */
function memoryBlockCount(entry) {
  const blocks = entry?.data?.blocks;
  return Array.isArray(blocks) ? blocks.length : 0;
}

function prepareEnvironment(packageRoot, workspaceCount = 1) {
  const root = mkdtempSync(join(tmpdir(), "pi-square-cache-sequence-"));
  const agentDir = join(root, "agent");
  mkdirSync(join(agentDir, "config"), { recursive: true });
  writeFileSync(join(agentDir, "auth.json"), "{}\n", "utf8");
  writeFileSync(join(agentDir, "config", "pi-square.json"), JSON.stringify({
    version: 2,
    contextMemory: {
      enabled: true,
      compressionThreshold: { tokens: COMPRESSION_THRESHOLD },
      memoryBudgetPercent: MEMORY_BUDGET_PERCENT,
    },
  }, null, 2) + "\n", "utf8");
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
    packages: [{ source: packageRoot }],
    quietStartup: true,
    compaction: { enabled: false, keepRecentTokens: 200 },
    retry: { enabled: false, provider: { maxRetries: 0 } },
  }, null, 2) + "\n", "utf8");
  const workspaces = Array.from({ length: workspaceCount }, (_, index) => {
    const cwd = join(root, `workspace-${index + 1}`);
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(cwd, REFERENCE_FILE), REFERENCE_MATERIAL, "utf8");
    return cwd;
  });
  return { root, agentDir, workspaces };
}

/**
 * Drive one cache measurement through Pi's public session API. The only
 * caller-supplied boundary is the ModelRuntime/provider; Pi owns prompt
 * construction, extension transforms, tool execution, persistence, and the
 * Context Memory recording/projection cycle: accepted Memory lands as a
 * custom state entry during the `compact_to_memory_block` call and the next
 * ordinary request applies it — synchronously, with no settle wait and no
 * native compaction anywhere.
 */
async function runSequenceInEnvironment({ modelRuntime, model, prompts, environment, cwd }) {
  if (!Array.isArray(prompts) || prompts.length < 2 || prompts.some((prompt) => typeof prompt !== "string" || prompt.length === 0)) {
    throw new Error("the Pi cache sequence requires at least two non-empty prompts");
  }
  let session;
  try {
    const settingsManager = SettingsManager.create(cwd, environment.agentDir);
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir: environment.agentDir,
      settingsManager,
      noSkills: true,
    });
    await resourceLoader.reload();
    const sessionManager = SessionManager.inMemory();
    const measuredModel = {
      ...model,
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      maxTokens: Math.min(model.maxTokens ?? 1_024, 1_024),
    };
    ({ session } = await createAgentSession({
      cwd,
      agentDir: environment.agentDir,
      resourceLoader,
      settingsManager,
      sessionManager,
      modelRuntime,
      model: measuredModel,
      thinkingLevel: "off",
    }));
    const extensionErrors = [];
    await session.bindExtensions({
      mode: "print",
      onError: (error) => extensionErrors.push(String(error?.message ?? error)),
    });

    const memoryStateEntries = () => sessionManager.getBranch()
      .filter((entry) => entry.type === "custom" && entry.customType === MEMORY_STATE_CUSTOM_TYPE);
    const requests = [];
    let promptIndex = 0;
    let requestIndex = 0;
    const unsubscribe = session.subscribe((event) => {
      if (event.type !== "message_end" || event.message?.role !== "assistant") return;
      requestIndex += 1;
      requests.push(usageRow(event.message, promptIndex, requestIndex));
    });
    const promptRows = [];
    try {
      for (const prompt of prompts) {
        promptIndex += 1;
        requestIndex = 0;
        const statesBefore = memoryStateEntries().length;
        await session.prompt(prompt, { expandPromptTemplates: false, source: "interactive" });
        // Recording happens synchronously inside the tool call, so the state
        // entries are observable the moment the prompt resolves.
        const statesAfter = memoryStateEntries().length;
        promptRows.push({
          prompt: promptIndex,
          requests: requestIndex,
          memoryStatesBefore: statesBefore,
          memoryStatesAfter: statesAfter,
          memoryRecorded: statesAfter > statesBefore,
          activeTools: session.state.tools.map((tool) => tool.name),
        });
      }
    } finally {
      unsubscribe();
    }

    const branch = sessionManager.getBranch();
    const stateEntries = branch
      .filter((entry) => entry.type === "custom" && entry.customType === MEMORY_STATE_CUSTOM_TYPE);
    const persistedAssistants = branch.filter((entry) => entry.type === "message" && entry.message.role === "assistant");
    const failures = [];
    if (requests.length < prompts.length) failures.push("one or more prompts produced no assistant response");
    if (requests.some((row) => row.input === null || row.output === null || row.cacheRead === null || row.cacheWrite === null)) {
      failures.push("one or more assistant responses lacked Pi-normalized usage");
    }
    if (stateEntries.some((entry) => entry.data?.format !== MEMORY_STATE_FORMAT_TAG)) {
      failures.push("a Memory state entry did not carry the v2 state format tag");
    }
    if (branch.some((entry) => entry.type === "compaction")) {
      failures.push("a native Pi compaction carried Context Memory instead of a recorded state entry");
    }
    if (requests.some((row) => row.stopReason === "error" || row.stopReason === "aborted")) {
      failures.push("one or more Pi requests failed or were aborted");
    }
    if (!requests.some((row) => row.toolNames.includes("compact_to_memory_block"))) {
      failures.push("the real Pi tool loop never called compact_to_memory_block");
    }
    if (stateEntries.length < 2 || Math.max(0, ...stateEntries.map(memoryBlockCount)) < 2) {
      failures.push("the sequence did not record a multi-block Context Memory");
    }
    if (extensionErrors.length > 0) failures.push(`${extensionErrors.length} extension error(s) occurred`);
    if (!session.extensionRunner.getExtensionPaths().some((path) => path.endsWith("/src/index.ts"))) {
      failures.push("pi-square was not loaded into the Pi session");
    }
    if (persistedAssistants.length !== requests.length) {
      failures.push("public message_end usage did not match Pi's persisted assistant responses");
    }
    const all = aggregate(requests);
    const warm = aggregate(requests.slice(1));
    return {
      schema: SCHEMA,
      model: {
        provider: model.provider,
        id: model.id,
        api: model.api,
        measuredContextWindow: DEFAULT_CONTEXT_WINDOW,
      },
      execution: {
        driver: "AgentSession.prompt",
        promptCount: prompts.length,
        promptOrder: "sequential",
        retries: "disabled",
      },
      configuration: {
        compressionThresholdTokens: COMPRESSION_THRESHOLD,
        memoryBudgetPercent: MEMORY_BUDGET_PERCENT,
        autoCompaction: false,
      },
      prompts: promptRows,
      requests,
      cache: { all, warm },
      session: {
        extensionLoaded: session.extensionRunner.getExtensionPaths().some((path) => path.endsWith("/src/index.ts")),
        memoryStateEntries: stateEntries.length,
        maximumMemoryBlocks: Math.max(0, ...stateEntries.map(memoryBlockCount)),
        persistedAssistantResponses: persistedAssistants.length,
      },
      integrity: { ok: failures.length === 0, failures },
    };
  } finally {
    session?.dispose();
  }
}

/** Run one isolated real Pi session sequence. */
export async function runPiSessionSequence(options) {
  const environment = prepareEnvironment(options.packageRoot);
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = environment.agentDir;
  try {
    return await runSequenceInEnvironment({ ...options, environment, cwd: environment.workspaces[0] });
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(environment.root, { recursive: true, force: true });
  }
}

/** Run independent Pi sessions concurrently while each session's prompts remain sequential. */
export async function runPiSessionMatrix({ packageRoot, modelRuntime, models, prompts }) {
  if (!Array.isArray(models) || models.length === 0 || models.length > 3) {
    throw new Error("the Pi cache matrix requires one to three models");
  }
  const environment = prepareEnvironment(packageRoot, models.length);
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = environment.agentDir;
  try {
    const runs = await Promise.all(models.map((model, index) => runSequenceInEnvironment({
      modelRuntime,
      model,
      prompts,
      environment,
      cwd: environment.workspaces[index],
    })));
    return {
      schema: MATRIX_SCHEMA,
      generatedAt: new Date().toISOString(),
      execution: {
        driver: "AgentSession.prompt",
        modelLanes: runs.length,
        laneConcurrency: "parallel",
        promptOrderWithinLane: "sequential",
      },
      runs,
      comparison: runs.map((run) => ({
        provider: run.model.provider,
        model: run.model.id,
        requests: run.requests.length,
        memoryStateEntries: run.session.memoryStateEntries,
        maximumMemoryBlocks: run.session.maximumMemoryBlocks,
        allHitRate: run.cache.all.hitRate,
        warmHitRate: run.cache.warm.hitRate,
        integrityOk: run.integrity.ok,
      })),
      integrity: {
        ok: runs.every((run) => run.integrity.ok),
        failedModels: runs.filter((run) => !run.integrity.ok).map((run) => `${run.model.provider}/${run.model.id}`),
      },
    };
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(environment.root, { recursive: true, force: true });
  }
}

export function piSessionCachePrompts() {
  const material = "stable project fact and implementation detail. ".repeat(520);
  return [
    `Read reference.txt in this workspace and acknowledge it briefly.\n\n${material}`,
    "Confirm the reference is understood.",
    `Read reference.txt again and acknowledge it briefly.\n\n${material}`,
    "Confirm both references are understood.",
    "Give a one-line status update.",
    "Give another one-line status update.",
    "Give a final one-line status update.",
  ];
}

export function renderPiSessionMatrix(report) {
  const percent = (value) => value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
  const lines = [
    "Context Memory provider cache — real Pi request sequence",
    `execution: ${report.execution.modelLanes} AgentSession lanes in parallel; prompts sequential inside each lane`,
    "model                              all        warm       requests  memoryStates  blocks  integrity",
  ];
  for (const row of report.comparison) {
    const model = `${row.provider}/${row.model}`.slice(0, 34).padEnd(34);
    lines.push(`${model} ${percent(row.allHitRate).padEnd(10)} ${percent(row.warmHitRate).padEnd(10)} ${String(row.requests).padEnd(9)} ${String(row.memoryStateEntries).padEnd(13)} ${String(row.maximumMemoryBlocks).padEnd(7)} ${row.integrityOk ? "ok" : "FAILED"}`);
  }
  lines.push("rate = cacheRead / (input + cacheRead + cacheWrite); warm excludes only the first cold request");
  return lines.join("\n");
}
