import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const SCHEMA = "pi-square.context-memory/pi-session-cache-sequence/1";
const DEFAULT_CONTEXT_WINDOW = 100_000;
const COMPRESSION_THRESHOLD = 3_500;
const MEMORY_BUDGET_PERCENT = 1;
const COMPACTION_WAIT_MS = 10_000;

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

function memoryBlockCount(entry) {
  const blocks = entry?.details?.blocks;
  return Array.isArray(blocks) ? blocks.length : 0;
}

async function waitForCompaction(session, sessionManager, before, expected, completed, completedBefore) {
  const deadline = Date.now() + COMPACTION_WAIT_MS;
  while (true) {
    const count = sessionManager.getBranch().filter((entry) => entry.type === "compaction").length;
    if (!session.isCompacting && (!expected || count > before || completed() > completedBefore)) return;
    if (Date.now() >= deadline) throw new Error("Pi Context Memory compaction did not settle within 10 seconds");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
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
    return cwd;
  });
  return { root, agentDir, workspaces };
}

/**
 * Drive one cache measurement through Pi's public session API. The only
 * caller-supplied boundary is the ModelRuntime/provider; Pi owns prompt
 * construction, extension transforms, tool execution, persistence, and
 * Context Memory compaction.
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

    const requests = [];
    const compactionEnds = [];
    let promptIndex = 0;
    let requestIndex = 0;
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "compaction_end") compactionEnds.push(event);
      if (event.type !== "message_end" || event.message?.role !== "assistant") return;
      requestIndex += 1;
      requests.push(usageRow(event.message, promptIndex, requestIndex));
    });
    const promptRows = [];
    try {
      for (const prompt of prompts) {
        promptIndex += 1;
        requestIndex = 0;
        const firstRequest = requests.length;
        const completedBefore = compactionEnds.length;
        const before = sessionManager.getBranch().filter((entry) => entry.type === "compaction").length;
        await session.prompt(prompt, { expandPromptTemplates: false, source: "interactive" });
        const submitted = requests.slice(firstRequest).some((row) => row.toolNames.includes("submit_memory"));
        await waitForCompaction(
          session,
          sessionManager,
          before,
          submitted,
          () => compactionEnds.length,
          completedBefore,
        );
        const after = sessionManager.getBranch().filter((entry) => entry.type === "compaction").length;
        promptRows.push({
          prompt: promptIndex,
          requests: requestIndex,
          compactionsBefore: before,
          compactionsAfter: after,
          compactionAttempted: compactionEnds.length > completedBefore,
          activeTools: session.state.tools.map((tool) => tool.name),
        });
      }
    } finally {
      unsubscribe();
    }

    const branch = sessionManager.getBranch();
    const compactions = branch.filter((entry) => entry.type === "compaction");
    const persistedAssistants = branch.filter((entry) => entry.type === "message" && entry.message.role === "assistant");
    const failures = [];
    if (requests.length < prompts.length) failures.push("one or more prompts produced no assistant response");
    if (requests.some((row) => row.input === null || row.output === null || row.cacheRead === null || row.cacheWrite === null)) {
      failures.push("one or more assistant responses lacked Pi-normalized usage");
    }
    if (compactions.some((entry) => entry.fromHook !== true)) {
      failures.push("a compaction was not committed through the Context Memory hook");
    }
    if (requests.some((row) => row.stopReason === "error" || row.stopReason === "aborted")) {
      failures.push("one or more Pi requests failed or were aborted");
    }
    if (!requests.some((row) => row.toolNames.includes("submit_memory"))) {
      failures.push("the real Pi tool loop never called submit_memory");
    }
    if (compactions.length < 2 || Math.max(0, ...compactions.map(memoryBlockCount)) < 2) {
      failures.push("the sequence did not commit a multi-block Context Memory");
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
        compactions: compactions.length,
        maximumMemoryBlocks: Math.max(0, ...compactions.map(memoryBlockCount)),
        extensionCompactions: compactions.filter((entry) => entry.fromHook === true).length,
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
      schema: "pi-square.context-memory/pi-session-cache-matrix/1",
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
        compactions: run.session.compactions,
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
    `Read this reference and acknowledge it briefly.\n\n${material}`,
    "Confirm the reference is understood.",
    `Read this additional reference and acknowledge it briefly.\n\n${material}`,
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
    "model                              all        warm       requests  compactions  blocks  integrity",
  ];
  for (const row of report.comparison) {
    const model = `${row.provider}/${row.model}`.slice(0, 34).padEnd(34);
    lines.push(`${model} ${percent(row.allHitRate).padEnd(10)} ${percent(row.warmHitRate).padEnd(10)} ${String(row.requests).padEnd(9)} ${String(row.compactions).padEnd(12)} ${String(row.maximumMemoryBlocks).padEnd(7)} ${row.integrityOk ? "ok" : "FAILED"}`);
  }
  lines.push("rate = cacheRead / (input + cacheRead + cacheWrite); warm excludes only the first cold request");
  return lines.join("\n");
}
