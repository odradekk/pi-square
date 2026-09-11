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
const { MEMORY_SUMMARY_WRAPPER } = await load("../../src/context-memory/format.ts");

/**
 * #319 observation boundary at the real request exit: a transform BEFORE
 * pi-square that rewrites a source prevents authorization (`SOURCE_NOT_SERVED`).
 * A transform AFTER pi-square can still alter the final request; the accepted
 * compatibility boundary does not treat our observation as a delivery receipt.
 * Once recorded Memory
 * cannot be applied to a modified request, the protocol history must stay
 * whole — no orphan results, no lost summary body, no carrier.
 *
 * A real extension file loaded through `additionalExtensionPaths` runs before
 * the package. For the downstream case, that file registers the package first
 * and then the filter, fixing their order without changing the Pi host.
 */

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CONTEXT_WINDOW = 40_000;
const COMPRESSION_THRESHOLD_TOKENS = 500;
const MEMORY_BUDGET_PERCENT = 1;
const FILTER_NEEDLE = "UPSTREAM-FILTER-NEEDLE";
const FILTER_PLACEHOLDER = "UPSTREAM-FILTERED-PLACEHOLDER";

const FILLER = "Operational history and module boundary notes that make each read a substantial evidence payload. ".repeat(14);
const WORK_FILES = {
  "file-a.txt": `${FILTER_NEEDLE}: the build entry point registers every feature module.\n${FILLER}\n`,
  "file-b.txt": `FILE-B-NEEDLE: the login flow sets the session cookie only after the redirect completes.\n${FILLER}\n`,
  "file-c.txt": `FILE-C-NEEDLE: the footer derives usage directly from the read-only context each render.\n${FILLER}\n`,
};

/** The upstream transform extension; `mode` is baked per generated file. */
function upstreamFilterSource(mode, filterOrder) {
  const imported = filterOrder === "after"
    ? `import registerPackage from ${JSON.stringify(join(packageRoot, "src/index.ts"))};\n` : "";
  return `${imported}export default function register(pi) {
  ${filterOrder === "after" ? "registerPackage(pi);" : ""}
  const MODE = ${JSON.stringify(mode)};
  const NEEDLE = ${JSON.stringify(FILTER_NEEDLE)};
  const STATE_TYPE = ${JSON.stringify(MEMORY_STATE_CUSTOM_TYPE)};
  pi.on("context", (event, ctx) => {
    let active = MODE === "always";
    if (MODE === "after-memory") {
      try {
        active = ctx.sessionManager.getBranch().some((entry) => entry.type === "custom" && entry.customType === STATE_TYPE);
      } catch {
        active = false;
      }
    }
    if (!active) return undefined;
    return {
      messages: event.messages.map((message) =>
        message && message.role === "toolResult" && Array.isArray(message.content)
          && message.content.some((part) => part && part.type === "text" && typeof part.text === "string" && part.text.includes(NEEDLE))
          ? { ...message, content: [{ type: "text", text: ${JSON.stringify(FILTER_PLACEHOLDER)} }] }
          : message),
    };
  });
}
`;
}

function prepareEnvironment(upstreamExtensionPath, filterOrder) {
  const root = mkdtempSync(join(tmpdir(), "pi-square-upstream-transform-"));
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
    packages: filterOrder === "after" ? [] : [{ source: packageRoot }],
    quietStartup: true,
    compaction: { enabled: false, keepRecentTokens: 200 },
    retry: { enabled: false, provider: { maxRetries: 0 } },
  }, null, 2) + "\n");
  for (const [name, content] of Object.entries(WORK_FILES)) {
    writeFileSync(join(cwd, name), content);
  }
  return { root, agentDir, cwd, upstreamExtensionPath };
}

function messageText(message) {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content.map((part) => (part?.type === "text" ? part.text : "")).join("");
}

function requestText(messages) {
  return messages.map(messageText).join("\n");
}

const runtimeDir = mkdtempSync(join(tmpdir(), "pi-square-upstream-runtime-"));
writeFileSync(join(runtimeDir, "auth.json"), "{}\n");

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;

/**
 * Drive one real session. `mode` selects the upstream filter policy:
 * "always" filters the covered read from the first request (the compression
 * must refuse); "after-memory" filters it only once Memory exists (the
 * recording succeeds, then the application must refuse without damaging
 * protocol history).
 */
async function runSession({ mode, filterOrder = "before", mixedOrder, onDone }) {
  const extensionDir = mkdtempSync(join(tmpdir(), "pi-square-upstream-ext-"));
  const extensionPath = join(extensionDir, "context-filter.ts");
  writeFileSync(extensionPath, upstreamFilterSource(mode, filterOrder));
  const environment = prepareEnvironment(extensionPath, filterOrder);
  process.env.PI_CODING_AGENT_DIR = environment.agentDir;
  let session;
  let unsubscribe;
  try {
    const runtime = await ModelRuntime.create({
      authPath: join(runtimeDir, "auth.json"),
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    const faux = fauxProvider({
      provider: "upstream-transform-test",
      api: "upstream-transform-test",
      models: [{ id: "upstream-projection", contextWindow: CONTEXT_WINDOW, maxTokens: 2_048 }],
    });
    runtime.registerNativeProvider(faux.provider);

    const requests = [];
    const compactionEvents = [];
    const memoryMarkdown = "# Upstream digest\n\n- the workspace layout facts from the first two reads were established, including the entry point and the login flow notes.";
    let readA = false;
    let compacted = false;

    faux.setResponses(Array.from({ length: 40 }, () => (context) => {
      requests.push({
        messages: structuredClone(context.messages),
        toolNames: context.tools?.map((tool) => tool.name) ?? [],
      });
      const last = context.messages.at(-1);
      const lastToolName = last?.role === "toolResult" ? last.toolName : undefined;
      if (compacted) {
        if (lastToolName === "compact_to_memory_block") {
          return fauxAssistantMessage(fauxToolCall("read", { path: "file-c.txt" }), { stopReason: "toolUse" });
        }
        return fauxAssistantMessage("continuing after the compression attempt", { stopReason: "stop" });
      }
      if (lastToolName === "read" && messageText(last).includes("FILE-B-NEEDLE")) {
        compacted = true;
        const compact = fauxToolCall("compact_to_memory_block", { markdown: memoryMarkdown });
        const read = fauxToolCall("read", { path: "file-c.txt" });
        const calls = mixedOrder === "first" ? [compact, read]
          : mixedOrder === "last" ? [read, compact] : compact;
        return fauxAssistantMessage(calls, { stopReason: "toolUse" });
      }
      if (!readA) {
        readA = true;
        return fauxAssistantMessage(fauxToolCall("read", { path: "file-a.txt" }), { stopReason: "toolUse" });
      }
      if (lastToolName === "read" && (messageText(last).includes(FILTER_NEEDLE) || messageText(last).includes(FILTER_PLACEHOLDER))) {
        return fauxAssistantMessage(fauxToolCall("read", { path: "file-b.txt" }), { stopReason: "toolUse" });
      }
      return fauxAssistantMessage("idle", { stopReason: "stop" });
    }));

    const settingsManager = SettingsManager.create(environment.cwd, environment.agentDir);
    const resourceLoader = new DefaultResourceLoader({
      cwd: environment.cwd,
      agentDir: environment.agentDir,
      settingsManager,
      noSkills: true,
      additionalExtensionPaths: [environment.upstreamExtensionPath],
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
      initialActiveToolNames: ["read", "bash"],
    }));
    await session.bindExtensions({ mode: "print", onError: () => {} });
    unsubscribe = session.subscribe((event) => {
      if (event.type === "compaction_start" || event.type === "compaction_end") compactionEvents.push(event.type);
    });

    const taskPrompt = [
      "Research this workspace: read file-a.txt and file-b.txt, then compress",
      "what you learned with compact_to_memory_block.",
      "Planning context that stays present: alpha-bravo-charlie-delta-echo. ",
    ].join("\n").repeat(3);

    await session.prompt(taskPrompt, { source: "interactive", expandPromptTemplates: false });
    return await onDone({ requests, compactionEvents, sessionManager, memoryMarkdown });
  } finally {
    unsubscribe?.();
    await session?.dispose();
    rmSync(environment.root, { recursive: true, force: true });
    rmSync(extensionDir, { recursive: true, force: true });
  }
}

try {
  // Earlier filtering prevents source observation and therefore recording.
  const refused = await runSession({
    mode: "always",
    onDone: ({ requests, compactionEvents, sessionManager }) => {
      assert.equal(compactionEvents.length, 0, "no native compaction occurs");
      assert.ok(requests.length >= 3, `several provider requests ran (got ${requests.length})`);
      assert.ok(!JSON.stringify(requests).includes(FILTER_NEEDLE),
        "the upstream filter kept the raw evidence out of every provider request");
      const branch = sessionManager.getBranch();
      assert.equal(
        branch.filter((entry) => entry.type === "custom" && entry.customType === MEMORY_STATE_CUSTOM_TYPE).length,
        0,
        "no Memory is recorded over sources that never reached the model",
      );
      const compactResults = branch.filter((entry) =>
        entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "compact_to_memory_block");
      assert.equal(compactResults.length, 1);
      assert.equal(compactResults[0].message.isError, true, "the compression call failed visibly");
      assert.match(compactResults[0].message.content[0].text, /^SOURCE_NOT_SERVED: /,
        "the refusal names the local source-observation boundary");
      assert.ok(!JSON.stringify(requests).includes(MEMORY_SUMMARY_WRAPPER),
        "no carrier exists without a recording");
      return "refused";
    },
  });
  assert.equal(refused, "refused");

  // Later filtering is outside the accepted runtime guarantee. This checks
  // the limitation explicitly, not successful delivery or summary quality.
  await runSession({
    mode: "always",
    filterOrder: "after",
    onDone: ({ requests, sessionManager }) => {
      assert.ok(!JSON.stringify(requests).includes(FILTER_NEEDLE),
        "the later transform removes raw evidence from every provider request");
      assert.ok(JSON.stringify(requests).includes(FILTER_PLACEHOLDER));
      const branch = sessionManager.getBranch();
      assert.equal(branch.filter((entry) => entry.type === "custom" && entry.customType === MEMORY_STATE_CUSTOM_TYPE).length, 1,
        "source authorization covers the handler's observed input, not later transforms");
      const result = branch.find((entry) => entry.type === "message"
        && entry.message.role === "toolResult" && entry.message.toolName === "compact_to_memory_block");
      assert.equal(result?.message.isError, false, "the observed source can be recorded without claiming final delivery");
    },
  });

  // ── Fix 2: a refused application keeps protocol history whole ──
  const preserved = await runSession({
    mode: "after-memory",
    onDone: ({ requests, compactionEvents, sessionManager, memoryMarkdown }) => {
      assert.equal(compactionEvents.length, 0, "no native compaction occurs");
      const branch = sessionManager.getBranch();
      const stateEntries = branch.filter((entry) => entry.type === "custom" && entry.customType === MEMORY_STATE_CUSTOM_TYPE);
      assert.equal(stateEntries.length, 1, "the recording itself succeeded against served sources");
      const compactResults = branch.filter((entry) =>
        entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "compact_to_memory_block");
      assert.equal(compactResults.length, 1);
      assert.equal(compactResults[0].message.isError, false, "the compression tool call was accepted");

      // After the recorded result, every request's upstream filter rewrites
      // the covered original, so the application must refuse — with the
      // protocol history left whole at the provider boundary.
      const after = requests.filter((request) =>
        request.messages.some((message) => message.role === "toolResult" && message.toolName === "compact_to_memory_block"));
      assert.ok(after.length >= 1, "the model continued after the recording");
      for (const request of after) {
        const text = requestText(request.messages);
        assert.ok(!text.includes(MEMORY_SUMMARY_WRAPPER),
          "no carrier enters a request whose covered source was modified upstream");
        const calls = new Set(request.messages
          .filter((message) => message.role === "assistant")
          .flatMap((message) => message.content.filter((part) => part?.type === "toolCall").map((part) => part.id)));
        const compactCall = request.messages
          .filter((message) => message.role === "assistant")
          .flatMap((message) => message.content.filter((part) => part?.type === "toolCall" && part.name === "compact_to_memory_block"))[0];
        assert.ok(compactCall, "the accepted call stays in the request");
        assert.equal(compactCall.arguments.markdown, memoryMarkdown,
          "the unapplied pair keeps its full argument body — the only request-side copy of the summary");
        const compactResult = request.messages.find((message) =>
          message.role === "toolResult" && message.toolName === "compact_to_memory_block");
        assert.ok(compactResult, "the accepted result stays in the request");
        assert.ok(calls.has(compactResult.toolCallId), "the pair never splits — no orphan result");
        assert.ok(text.includes(FILTER_PLACEHOLDER), "the upstream modification itself stays visible");
      }
      return "preserved";
    },
  });
  assert.equal(preserved, "preserved");

  for (const mixedOrder of ["first", "last"]) {
    await runSession({
      mode: "never",
      mixedOrder,
      onDone: ({ requests, sessionManager }) => {
        const branch = sessionManager.getBranch();
        const refusal = branch.find((entry) => entry.type === "message"
          && entry.message.role === "toolResult" && entry.message.toolName === "compact_to_memory_block");
        assert.ok(refusal?.message.isError, "a mixed compression batch refuses without recording");
        assert.match(messageText(refusal.message), /^COMPACT_NOT_SOAL_TOOL:/);
        assert.ok(!branch.some((entry) => entry.type === "custom" && entry.customType === MEMORY_STATE_CUSTOM_TYPE));
        const continuation = requests.find((request) => request.messages.some((message) =>
          message.role === "toolResult" && message.toolName === "read" && messageText(message).includes("FILE-C-NEEDLE")));
        assert.ok(continuation, "the ordinary sibling completes and reaches the model");
        const error = continuation.messages.find((message) => message.role === "toolResult"
          && message.toolCallId === refusal.message.toolCallId);
        assert.ok(error?.isError, `the first continuation preserves the rejection when compact is ${mixedOrder}`);
        assert.match(messageText(error), /^COMPACT_NOT_SOAL_TOOL:/);
        const calls = continuation.messages.filter((message) => message.role === "assistant")
          .flatMap((message) => message.content.filter((part) => part.type === "toolCall"));
        assert.ok(calls.some((call) => call.id === error.toolCallId && call.name === "compact_to_memory_block"));
        for (const message of continuation.messages) {
          if (message.role === "toolResult") assert.ok(calls.some((call) => call.id === message.toolCallId));
        }
      },
    });
  }

  console.log("context-memory upstream transform native session: OK");
} finally {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(runtimeDir, { recursive: true, force: true });
}
