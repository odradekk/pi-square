#!/usr/bin/env node

/**
 * Manual acceptance for #308 against the real Pi 0.84.2 TUI.
 *
 * Prerequisites: `npm install`, Node.js 24, and tmux. Run from the repository:
 *
 *   node tests/manual/subagent-roster-tui.mjs
 *
 * The script creates an isolated Pi home and project, serves a deterministic
 * OpenAI-compatible model on localhost, and drives both TUI modes through
 * tmux. It leaves no sessions or temporary files behind.
 */

import { execFile as execFileCallback } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFile = promisify(execFileCallback);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const piBin = join(repository, "node_modules", ".bin", "pi");
const scratch = mkdtempSync(join(tmpdir(), "pi-square-roster-tui-"));
const agentDir = join(scratch, "agent");
const projectDir = join(scratch, "project");
const children = 12;
const checks = [];
let failures = 0;
let defaultPrompts = [];

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

async function tmux(...args) {
  return execFile("tmux", args, { encoding: "utf8" });
}

async function screen(session) {
  return (await tmux("capture-pane", "-p", "-t", session)).stdout;
}

async function waitFor(session, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await screen(session);
    if (predicate(current)) return current;
    await delay(250);
  }
  return screen(session);
}

async function sendText(session, text) {
  for (const character of text) {
    await tmux("send-keys", "-t", session, "-l", character);
    await delay(25);
  }
}

async function sendKey(session, key) {
  await tmux("send-keys", "-t", session, key);
}

function rosterRows(value) {
  return value.split("\n").filter((line) => /^\s*[○●] explorer\b/u.test(line));
}

function overlayTitle(value) {
  return value.split("\n").find((line) => (
    /^\s{0,40}explorer [0-9a-f]+ (● running|✓ completed|✗ failed|× aborted)/u.test(line)
  )) ?? "";
}

function check(mode, label, condition, evidence) {
  const status = condition ? "PASS" : "FAIL";
  if (!condition) failures += 1;
  const line = `[${mode}] ${status}: ${label} — ${evidence}`;
  checks.push(line);
  process.stdout.write(`${line}\n`);
}

function messageText(message) {
  if (typeof message?.content === "string") return message.content;
  if (!Array.isArray(message?.content)) return "";
  return message.content.map((part) => part?.text ?? "").join("\n");
}

function childText(index) {
  const paragraph = "Deterministic child stream keeps the live transcript moving while the roster remains observational.";
  return Array.from({ length: 18 }, (_, block) => `child ${index} block ${block}: ${paragraph}`).join("\n");
}

function decide(messages) {
  const users = messages.filter((message) => message.role === "user");
  const latest = users.length === 0 ? "" : messageText(users.at(-1));
  const hasToolResults = messages.some((message) => message.role === "tool");
  if (latest.includes("PARENT_BURST") && !hasToolResults) {
    return {
      toolCalls: Array.from({ length: children }, (_, index) => ({
        id: `faux-delegate-${index}`,
        type: "function",
        function: {
          name: "delegate_subagent",
          arguments: JSON.stringify({
            task: `CHILD_STREAM ${index}: stream the deterministic tail`,
            agent: "explorer",
          }),
        },
      })),
    };
  }
  const child = /CHILD_STREAM (\d+)/u.exec(latest);
  if (child) return { text: childText(Number(child[1])), stream: true };
  if (latest.includes("SECOND_TASK")) return { text: "second task acknowledged" };
  defaultPrompts.push(latest);
  return { text: `assistant echo: ${latest.slice(0, 80)}` };
}

function startModelServer() {
  const server = http.createServer((request, response) => {
    if (request.method !== "POST" || !request.url?.endsWith("/chat/completions")) {
      response.writeHead(404).end();
      return;
    }
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      let payload = {};
      try { payload = JSON.parse(body); } catch { /* malformed input uses the empty request */ }
      const decision = decide(payload.messages ?? []);
      const base = { id: "faux-response", object: "chat.completion.chunk", created: 0, model: payload.model ?? "faux-1" };
      const write = (value) => response.write(`data: ${JSON.stringify(value)}\n\n`);
      const finish = () => {
        write({ ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } });
        response.end("data: [DONE]\n\n");
      };
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      if (decision.toolCalls) {
        write({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: decision.toolCalls }, finish_reason: null }] });
        write({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
        finish();
        return;
      }
      if (!decision.stream) {
        write({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: decision.text }, finish_reason: null }] });
        write({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
        finish();
        return;
      }
      const pieces = decision.text.split(/(?= )/u);
      let index = 0;
      const timer = setInterval(() => {
        for (let step = 0; step < 2 && index < pieces.length; step += 1, index += 1) {
          write({ ...base, choices: [{ index: 0, delta: { content: pieces[index] }, finish_reason: null }] });
        }
        if (index < pieces.length) return;
        clearInterval(timer);
        write({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
        finish();
      }, 45);
    });
  });
  return new Promise((resolveServer, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolveServer(server));
  });
}

function prepareWorkspace(port, fullscreen) {
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(projectDir, ".pi"), { recursive: true });
  writeFileSync(join(agentDir, "auth.json"), "{}\n");
  writeFileSync(join(agentDir, "models-store.json"), "{}\n");
  writeFileSync(join(agentDir, "models.json"), `${JSON.stringify({
    providers: {
      faux: {
        name: "Faux",
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: "local-manual-harness",
        api: "openai-completions",
        models: [{
          id: "faux-1",
          name: "Faux deterministic",
          contextWindow: 200_000,
          maxTokens: 16_384,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        }],
      },
    },
  }, null, 2)}\n`);
  writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify({
    ...(fullscreen ? { tuiMode: "fullscreen" } : {}),
    lastChangelogVersion: "0.84.2",
  }, null, 2)}\n`);
  writeFileSync(join(agentDir, "trust.json"), `${JSON.stringify({ [projectDir]: true }, null, 2)}\n`);
  writeFileSync(join(projectDir, ".pi", "settings.json"), `${JSON.stringify({ packages: [repository] }, null, 2)}\n`);
}

async function clearEditor(session) {
  await sendKey(session, "C-u");
  await delay(200);
}

async function runScenario(mode, port) {
  const session = `pi-square-308-${mode}-${process.pid}`;
  prepareWorkspace(port, mode === "fullscreen");
  const command = [
    "env",
    `PI_CODING_AGENT_DIR=${agentDir}`,
    "TERM=xterm-256color",
    piBin,
    "--provider", "faux",
    "--model", "faux-1",
  ].map(shellQuote).join(" ");
  await tmux("new-session", "-d", "-s", session, "-x", "100", "-y", "45", "-c", projectDir, command);
  try {
    let current = await waitFor(session, (value) => value.includes("pi-square"), 15_000);
    check(mode, "extension boot", current.includes("pi-square"), "pi-square is visible on the startup screen");

    await sendText(session, "PARENT_BURST please delegate the observation work");
    await sendKey(session, "Enter");
    current = await waitFor(session, (value) => rosterRows(value).length >= 10 && value.includes("+2 more"), 30_000);
    check(mode, "roster fills beyond ten children", rosterRows(current).length === 10 && current.includes("+2 more"), `${rosterRows(current).length} rows and overflow accounting are visible`);
    check(mode, "live lifecycles render", /● running|– queued/u.test(rosterRows(current).join("\n")), "running or queued lifecycle text is visible");

    await sendKey(session, "Down");
    await sendKey(session, "Enter");
    current = await waitFor(session, (value) => value.includes("esc close") && overlayTitle(value).includes("● running"), 8_000);
    check(mode, "overlay opens on a streaming child", current.includes("esc close") && overlayTitle(current).includes("● running"), overlayTitle(current).trim());
    check(mode, "long streaming tail is visible", /child 0 block|Deterministic child stream/u.test(current), "live child content is rendered in the overlay");

    await tmux("resize-window", "-t", session, "-x", "120", "-y", "52");
    current = await waitFor(session, (value) => value.includes("esc close"), 4_000);
    check(mode, "resize while the overlay is open", current.includes("esc close"), "the open overlay survives a 45x100 to 52x120 resize");

    current = await waitFor(session, (value) => overlayTitle(value).includes("✓ completed"), 40_000);
    check(mode, "child completion while the overlay is open", current.includes("esc close") && overlayTitle(current).includes("✓ completed"), overlayTitle(current).trim());

    if (mode === "fullscreen") {
      const before = current;
      for (let index = 0; index < 5; index += 1) {
        await tmux("send-keys", "-t", session, "-H", "1b", "5b", "3c", "36", "34", "3b", "31", "30", "3b", "32", "30", "4d");
        await delay(150);
      }
      const after = await waitFor(session, (value) => value !== before, 3_000);
      check(mode, "mouse wheel scrolls the overlay", after !== before, "wheel-up changed the completed transcript viewport");
      await sendKey(session, "End");
    }

    await sendKey(session, "Escape");
    await delay(300);
    await sendKey(session, "Escape");
    await clearEditor(session);
    await sendKey(session, "Down");
    await sendKey(session, "Enter");
    await waitFor(session, (value) => value.includes("esc close"), 8_000);
    await sendText(session, "typed replay check");
    current = await waitFor(session, (value) => !value.includes("esc close") && value.includes("typed replay check"), 6_000);
    check(mode, "input replays without submitting", current.includes("typed replay check") && !defaultPrompts.includes("typed replay check"), "the editor contains the replay and the model did not receive it");

    await clearEditor(session);
    await sendText(session, "/subagent");
    await sendKey(session, "Enter");
    current = await waitFor(session, (value) => ["RUNNING", "SESSION", "DEFINITIONS"].every((word) => value.includes(word)), 10_000);
    check(mode, "pi-square manager coexistence", ["RUNNING", "SESSION", "DEFINITIONS"].every((word) => current.includes(word)), "the manager opened over the roster");
    await sendKey(session, "Escape");
    await delay(300);
    await sendKey(session, "Escape");

    await clearEditor(session);
    await sendText(session, "SECOND_TASK continue");
    await sendKey(session, "Enter");
    current = await waitFor(session, (value) => value.includes("second task acknowledged") && rosterRows(value).length === 0, 30_000);
    check(mode, "a second real prompt expires terminal rows", current.includes("second task acknowledged") && rosterRows(current).length === 0, `the parent answered and ${rosterRows(current).length} roster rows remain`);
  } finally {
    await tmux("kill-session", "-t", session).catch(() => {});
  }
}

let server;
try {
  await execFile("tmux", ["-V"]);
  server = await startModelServer();
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("local model server has no TCP port");
  await runScenario("regular", address.port);
  await runScenario("fullscreen", address.port);
} finally {
  await new Promise((resolveClose) => server?.close(resolveClose) ?? resolveClose());
  rmSync(scratch, { recursive: true, force: true });
}

process.stdout.write(`\nmanual TUI acceptance: ${checks.length} checks, ${failures} failed\n`);
process.exitCode = failures === 0 ? 0 : 1;
