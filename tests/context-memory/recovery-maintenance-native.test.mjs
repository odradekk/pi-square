import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRuntime, createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import jiti from "jiti";

const load = jiti(import.meta.url, { moduleCache: false });
const { MEMORY_STATE_CUSTOM_TYPE, MEMORY_SUMMARY_WRAPPER } = await load("../../src/context-memory/format.ts");
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const REBUILD_ADVISORY = "rebuilds the newest Memory suffix";
const FILLER = "Operational history and module boundary notes that make each read a substantial evidence payload. ".repeat(6);
const block = (title, padding) => `# ${title}\n\n${"n".repeat(padding)}\n\nPreserve the archive investigation.`;
const firstBlock = block("First digest", 630);
const secondBlock = block("Second digest", 500);
const rebuiltBlock = block("Rebuilt digest", 150);
const messageText = (message) => typeof message?.content === "string" ? message.content
  : (message?.content ?? []).map((part) => part.type === "text" ? part.text : "").join("");
const call = (name, args) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

// Recovery calls/results are protocol artifacts, not new compression sources.
// Observe actual Pi provider requests after a rebuild, independently for each
// recovery surface and for search followed by a read bound to its returned view.
for (const recoverySteps of [["read"], ["search"], ["search", "read"]]) {
  const root = mkdtempSync(join(tmpdir(), "pi-square-recovery-maintenance-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "workspace");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  let session;
  try {
    mkdirSync(join(agentDir, "config"), { recursive: true });
    mkdirSync(cwd);
    writeFileSync(join(agentDir, "auth.json"), "{}\n", { mode: 0o600 });
    writeFileSync(join(agentDir, "config", "pi-square.json"), JSON.stringify({
      version: 2,
      contextMemory: { enabled: true, compressionThreshold: { tokens: 1_200 }, memoryBudgetPercent: 2 },
    }));
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
      packages: [{ source: packageRoot }], quietStartup: true,
      compaction: { enabled: false, keepRecentTokens: 200 },
      retry: { enabled: false, provider: { maxRetries: 0 } },
    }));
    for (const letter of "abcdefghijk") {
      writeFileSync(join(cwd, `file-${letter}.txt`), `FILE-${letter.toUpperCase()}-NEEDLE: workspace fact ${letter}.\n${FILLER}\n`);
    }
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const runtime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"), modelsPath: null,
      allowModelNetwork: false, refreshOnCreate: false,
    });
    const faux = fauxProvider({
      provider: "recovery-maintenance-test", api: "recovery-maintenance-test",
      models: [{ id: "recovery-maintenance", contextWindow: 40_000, maxTokens: 2_048 }],
    });
    runtime.registerNativeProvider(faux.provider);
    const sessionManager = SessionManager.create(cwd, join(root, "sessions"));
    const states = () => sessionManager.getBranch()
      .filter((entry) => entry.type === "custom" && entry.customType === MEMORY_STATE_CUSTOM_TYPE);
    let acceptedCount = 0;
    let recoveryIndex = 0;
    let recoveryView;
    let recovered = false;
    let rearmed = false;
    let lastRead;
    let recoveredStateId;
    let recoveredCarrier;
    const recoveryRequest = (step) => step === "search"
      ? call("search_memory_source", { terms: ["FILE-C-NEEDLE"] })
      : call("read_memory_source", recoveryView ?? { block: 2, page: 1 });
    let providerAssertion;
    faux.setResponses(Array.from({ length: 30 }, () => (context) => {
      try {
        const text = context.messages.map(messageText).join("\n");
        const rebuildDue = text.includes(REBUILD_ADVISORY);
        const due = rebuildDue || text.includes("compression is due");
        const last = context.messages.at(-1);
        const lastName = last?.role === "toolResult" ? last.toolName : undefined;
        const lastText = messageText(last);
        const carrier = context.messages.filter((message) => messageText(message).includes(MEMORY_SUMMARY_WRAPPER));
        if (lastName === "search_memory_source" || lastName === "read_memory_source") {
          assert.equal(last.isError, false, "recovery must succeed before testing its maintenance effect");
          assert.equal(due, false, "pure recovery traffic must not rearm maintenance");
          assert.equal(states().at(-1).id, recoveredStateId, "recovery must not record another Memory state");
          assert.deepEqual(carrier, recoveredCarrier, "recovery keeps the complete normal carrier unchanged");
          if (lastName === "search_memory_source") {
            const row = /block (\d+) · page (\d+) of (\d+)/.exec(lastText);
            const view = /view (sv1-[0-9a-f]+)/.exec(lastText);
            assert.ok(row && view, "search returns a view-bound original source candidate");
            recoveryView = { block: Number(row[1]), page: Number(row[2]), view: view[1] };
          } else {
            assert.match(lastText, /FILE-C-NEEDLE/, "read recovers the covered original fact");
          }
          recoveryIndex += 1;
          if (recoveryIndex < recoverySteps.length) return recoveryRequest(recoverySteps[recoveryIndex]);
          recovered = true;
          return call("read", { path: "file-j.txt" });
        }
        if (lastName === "read") {
          lastRead = /FILE-([A-K])-NEEDLE/.exec(lastText)?.[1].toLowerCase();
          assert.ok(lastRead, "ordinary read returns its expected evidence");
          if (recovered) {
            if (lastRead === "j") return call("read", { path: "file-k.txt" });
            assert.equal(lastRead, "k");
            assert.ok(due, "later ordinary evidence rearms maintenance in the same run");
            rearmed = true;
            return fauxAssistantMessage("Recovery and ordinary continuation complete.", { stopReason: "stop" });
          }
        }
        if (lastName === "compact_to_memory_block") {
          assert.equal(last.isError, false, "setup compression must be accepted");
          acceptedCount += 1;
          if (acceptedCount === 1) return call("read", { path: "file-d.txt" });
          if (acceptedCount === 2) return call("read", { path: "file-f.txt" });
          assert.equal(acceptedCount, 3);
          assert.equal(due, false, "accepted rebuild clears the maintenance advisory");
          assert.equal(carrier.length, 1);
          assert.ok(messageText(carrier[0]).includes(firstBlock) && messageText(carrier[0]).includes(rebuiltBlock));
          assert.ok(!messageText(carrier[0]).includes(secondBlock), "the replaced summary leaves the carrier");
          recoveredCarrier = structuredClone(carrier);
          recoveredStateId = states().at(-1).id;
          return recoveryRequest(recoverySteps[0]);
        }
        const next = { a: "b", b: "c", d: "e", f: "g", g: "h", h: "i" }[lastRead];
        if (next) return call("read", { path: `file-${next}.txt` });
        if (lastRead === "c" || lastRead === "e") {
          assert.ok(due && !rebuildDue, "setup appends before rebuilding");
          return call("compact_to_memory_block", { markdown: lastRead === "c" ? firstBlock : secondBlock });
        }
        if (lastRead === "i") {
          assert.ok(rebuildDue, "setup reaches the suffix rebuild boundary");
          return call("compact_to_memory_block", { markdown: rebuiltBlock });
        }
        return call("read", { path: "file-a.txt" });
      } catch (error) {
        providerAssertion ??= error;
        throw error;
      }
    }));
    const settingsManager = SettingsManager.create(cwd, agentDir);
    const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noSkills: true });
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);
    ({ session } = await createAgentSession({
      cwd, agentDir, settingsManager, resourceLoader, sessionManager, modelRuntime: runtime,
      model: faux.getModel(), thinkingLevel: "off", initialActiveToolNames: ["read", "bash", "edit", "write"],
    }));
    await session.bindExtensions({ mode: "print", onError: (error) => { throw error; } });
    await session.prompt("Read the workspace evidence, maintain Memory when due, recover the original fact, then continue ordinary work.",
      { source: "interactive", expandPromptTemplates: false });
    if (providerAssertion) throw providerAssertion;
    assert.equal(recoveryIndex, recoverySteps.length);
    assert.equal(rearmed, true, "the native run reached ordinary continuation after recovery");
    assert.equal(states().length, 3, "only the two appends and one rebuild recorded Memory");
    const messages = sessionManager.getBranch().filter((entry) => entry.type === "message").map((entry) => entry.message);
    assert.equal(messages.filter((message) => message.role === "user").length, 1, "no follow-up input or restart is needed");
    assert.match(messageText(messages.at(-1)), /Recovery and ordinary continuation complete/);
    console.log(`context-memory recovery maintenance native (${recoverySteps.join(" → ")}): OK`);
  } finally {
    await session?.dispose();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(root, { recursive: true, force: true });
  }
}
