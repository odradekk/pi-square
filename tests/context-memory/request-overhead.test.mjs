import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRuntime, createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import jiti from "jiti";

const load = jiti(import.meta.url, { moduleCache: false });
const { MEMORY_STATE_CUSTOM_TYPE } = await load("../../src/context-memory/format.ts");

/**
 * #320 request-composition acceptance: pressure counts what the model is
 * actually sent beside the messages — the effective system prompt and the
 * active tool definitions — read from the host's public seams on every
 * request, with no usage report required. The run uses a real Pi
 * `AgentSession` with a deterministic faux provider and a large workspace
 * AGENTS.md so the provider request itself carries the long system prompt;
 * the advisory must arm as soon as a qualified compressible source exists,
 * even though every faux usage report is tiny and could never carry the
 * overhead through a residual.
 */

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const CONTEXT_WINDOW = 40_000;
const COMPRESSION_THRESHOLD_TOKENS = 2_500;
const MEMORY_BUDGET_PERCENT = 1;

const KEY_FACT = "The maintenance window for the archive rotation is TIDE-MARK-42.";
const MEMORY_MARKDOWN = [
  "# Workspace digest",
  "",
  "The first read established the workspace conventions that later steps",
  `depend on, including the maintenance window fact: ${KEY_FACT}`,
  "Ordinary padding detail keeps this body a realistic single block.",
].join("\n");

const FILLER = "Workspace convention notes that make the first read a real evidence payload. ".repeat(12);
const WORK_FILES = {
  "file-a.txt": `FILE-A-NEEDLE: the build entry point is src/index.ts.\n${FILLER}\n`,
  "file-b.txt": "FILE-B-NEEDLE: the login flow sets the session cookie after the redirect.\n",
};

function messageText(message) {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content.map((part) => (part?.type === "text" ? part.text : "")).join("");
}

function requestText(messages) {
  return messages.map(messageText).join("\n");
}

function prepareEnvironment() {
  const root = mkdtempSync(join(tmpdir(), "pi-square-request-overhead-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "workspace");
  mkdirSync(join(agentDir, "config"), { recursive: true });
  mkdirSync(cwd);
  writeFileSync(join(agentDir, "auth.json"), "{}\n", { mode: 0o600 });
  writeFileSync(join(agentDir, "config", "pi-square.json"), JSON.stringify({
    version: 2,
    contextMemory: {
      enabled: true,
      compressionThreshold: { tokens: COMPRESSION_THRESHOLD_TOKENS },
      memoryBudgetPercent: MEMORY_BUDGET_PERCENT,
    },
  }, null, 2) + "\n");
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
    packages: [{ source: packageRoot }],
    quietStartup: true,
    compaction: { enabled: false, keepRecentTokens: 200 },
    retry: { enabled: false, provider: { maxRetries: 0 } },
  }, null, 2) + "\n");
  // A large workspace AGENTS.md rides inside the effective system prompt Pi
  // assembles for every request of this run — the composition under test.
  writeFileSync(join(cwd, "AGENTS.md"),
    "# Workspace guide\n\n" + "Extended workspace convention line that Pi carries inside the system prompt for this test. ".repeat(520) + "\n");
  for (const [name, content] of Object.entries(WORK_FILES)) {
    writeFileSync(join(cwd, name), content);
  }
  return { root, agentDir, cwd };
}

const runtimeDir = mkdtempSync(join(tmpdir(), "pi-square-request-overhead-runtime-"));
writeFileSync(join(runtimeDir, "auth.json"), "{}\n");

let environment;
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
let session;
let unsubscribe;
try {
  environment = prepareEnvironment();
  process.env.PI_CODING_AGENT_DIR = environment.agentDir;
  const runtime = await ModelRuntime.create({
    authPath: join(runtimeDir, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const faux = fauxProvider({
    provider: "request-overhead-test",
    api: "request-overhead-test",
    models: [{ id: "request-overhead", contextWindow: CONTEXT_WINDOW, maxTokens: 2_048 }],
  });
  runtime.registerNativeProvider(faux.provider);

  /** Every real provider request, in order, with its full composition. */
  const requests = [];
  const compactionEvents = [];
  const abortedStops = [];
  let compacted = false;

  faux.setResponses(Array.from({ length: 20 }, () => (context) => {
    requests.push({
      messages: structuredClone(context.messages),
      toolNames: context.tools?.map((tool) => tool.name) ?? [],
      systemPrompt: typeof context.systemPrompt === "string" ? context.systemPrompt : "",
    });
    const text = requestText(context.messages);
    const last = context.messages.at(-1);
    const lastToolName = last?.role === "toolResult" ? last.toolName : undefined;

    if (compacted) {
      if (lastToolName === "compact_to_memory_block") {
        return fauxAssistantMessage(
          text.includes(KEY_FACT) ? `Task complete. ${KEY_FACT}` : "Task complete, but the key fact is MISSING.",
          { stopReason: "stop" },
        );
      }
      return fauxAssistantMessage("idle continuation", { stopReason: "stop" });
    }

    if (lastToolName === "read" && messageText(last).includes("FILE-A-NEEDLE")) {
      return fauxAssistantMessage(fauxToolCall("read", { path: "file-b.txt" }), { stopReason: "toolUse" });
    }
    if (lastToolName === "read" && messageText(last).includes("FILE-B-NEEDLE")) {
      if (text.includes("compression is due")) {
        compacted = true;
        return fauxAssistantMessage(
          fauxToolCall("compact_to_memory_block", { markdown: MEMORY_MARKDOWN }),
          { stopReason: "toolUse" },
        );
      }
      return fauxAssistantMessage("waiting for the compression advisory", { stopReason: "stop" });
    }
    return fauxAssistantMessage(fauxToolCall("read", { path: "file-a.txt" }), { stopReason: "toolUse" });
  }));

  const settingsManager = SettingsManager.create(environment.cwd, environment.agentDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd: environment.cwd, agentDir: environment.agentDir, settingsManager, noSkills: true,
  });
  await resourceLoader.reload();
  const sessionManager = SessionManager.create(environment.cwd, join(environment.root, "sessions"));
  ({ session } = await createAgentSession({
    cwd: environment.cwd,
    agentDir: environment.agentDir,
    settingsManager,
    resourceLoader,
    sessionManager,
    modelRuntime: runtime,
    model: faux.getModel(),
    thinkingLevel: "off",
    initialActiveToolNames: ["read", "bash", "edit", "write"],
  }));
  await session.bindExtensions({ mode: "print", onError: (error) => { throw error; } });
  const loadedErrors = resourceLoader.getExtensions().errors;
  assert.equal(loadedErrors.length, 0, "pi-square must load without extension errors");

  unsubscribe = session.subscribe((event) => {
    if (event.type === "compaction_start" || event.type === "compaction_end") compactionEvents.push(event.type);
    if (event.type === "message_end" && event.message.role === "assistant" && event.message.stopReason === "aborted") {
      abortedStops.push(event.message);
    }
  });

  await session.prompt(
    "Research this workspace: read file-a.txt then file-b.txt, compress what you learned when the maintenance advisory appears, and answer with the maintenance window fact you recorded.",
    { source: "interactive", expandPromptTemplates: false },
  );

  assert.equal(compactionEvents.length, 0, "no native compaction interferes");
  assert.equal(abortedStops.length, 0, "the run never aborts");
  assert.ok(requests.length >= 4, `the run produced several provider requests (got ${requests.length})`);

  // ── The composition under test is real: every request carried the long
  // system prompt and the active tool definitions, observed at the provider.
  const systemChars = requests[0].systemPrompt.length;
  assert.ok(systemChars > 20000,
    `Pi assembled the large workspace guide into the system prompt (${systemChars} chars)`);
  assert.ok(requests.every((request) => request.systemPrompt.includes("Extended workspace convention line")),
    "every request carries the AGENTS.md composition");
  assert.ok(requests.every((request) => request.toolNames.includes("read")
    && request.toolNames.includes("compact_to_memory_block")),
    "the active tool definitions ride every request beside the messages");

  // ── The overhead arms the advisory without any usage report: every faux
  // report is tiny (input ~1), so a usage-derived residual could never carry
  // a ~10000-token system prompt. The advisory appears exactly when a
  // qualified compressible source first exists — never before.
  const advisoryCounts = requests.map((request) =>
    request.messages.filter((message) => messageText(message).includes("compression is due")).length);
  assert.ok(advisoryCounts.every((count) => count <= 1), "at most one advisory per request");
  assert.equal(advisoryCounts[0], 0,
    "the first request has no qualified source yet, whatever the pressure");
  const compactCallIndex = requests.findIndex((request) =>
    request.messages.some((message) => message.role === "assistant" && Array.isArray(message.content)
      && message.content.some((part) => part?.type === "toolCall" && part.name === "compact_to_memory_block")));
  assert.ok(compactCallIndex > 0, "a provider request carries the compression call");
  assert.equal(advisoryCounts[compactCallIndex - 1], 1,
    "the request that prompts the compression carries the advisory armed by the system composition");

  // ── The compression records and applies: the next request carries the
  // complete carrier, the covered source leaves, and the answer delivers the
  // key fact through it.
  const branch = sessionManager.getBranch();
  const stateEntries = branch.filter((entry) => entry.type === "custom" && entry.customType === MEMORY_STATE_CUSTOM_TYPE);
  assert.equal(stateEntries.length, 1, "one Memory state entry records the compression");
  const applied = requests[compactCallIndex];
  const appliedText = requestText(applied.messages);
  assert.ok(applied.messages.some((message) => messageText(message).includes("pi-square Context Memory")),
    "the applied request carries the Memory carrier");
  assert.ok(!appliedText.includes("FILE-A-NEEDLE"), "the covered first read leaves the applied request");
  assert.ok(appliedText.includes("Research this workspace"),
    "the latest user instruction stays raw in the applied request");
  assert.ok(applied.systemPrompt.length > 20000,
    "the system prompt is still part of the applied request's composition");
  const finalAnswer = branch
    .filter((entry) => entry.type === "message" && entry.message.role === "assistant")
    .map((entry) => messageText(entry.message))
    .findLast(() => true);
  assert.match(finalAnswer, /TIDE-MARK-42/, "the final answer carries the key fact the carrier delivered");
  assert.doesNotMatch(finalAnswer, /MISSING/, "the fact reached the provider request, not just the tool call");

  console.log("context-memory request-overhead native session: OK");
} finally {
  unsubscribe?.();
  await session?.dispose();
  if (environment) rmSync(environment.root, { recursive: true, force: true });
  rmSync(runtimeDir, { recursive: true, force: true });
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
}
