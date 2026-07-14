import Module from "node:module";
import { dirname, join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { fileURLToPath } from "node:url";

import jiti from "jiti";

const __dirname = dirname(fileURLToPath(import.meta.url));
const helperPath = fileURLToPath(import.meta.url);
const packageRoot = resolve(__dirname, "..", "..", "..");
const agentDir = resolve(packageRoot, "..", "..");
const sharedNodeModules = join(packageRoot, "node_modules");

const existingNodePath = process.env.NODE_PATH ? process.env.NODE_PATH.split(":") : [];
if (!existingNodePath.includes(sharedNodeModules)) {
  process.env.NODE_PATH = [sharedNodeModules, ...existingNodePath].filter(Boolean).join(":");
  Module._initPaths();
}

const load = jiti(import.meta.url, {
  moduleCache: false,
  alias: {
    "./session": helperPath,
    "./tool": helperPath,
    "@earendil-works/pi-tui": helperPath,
  },
});
const loadTool = jiti(import.meta.url, {
  moduleCache: false,
  alias: {
    "./render": helperPath,
    "./session": helperPath,
    "./status": helperPath,
    "@earendil-works/pi-tui": helperPath,
  },
});

const tests = [];
const MOCK_KEY = "__pi_square_subagents_background_test_mock__";
const mockState = globalThis[MOCK_KEY] ?? {
  impl: async () => {
    throw new Error("runSubagentTask mock not configured");
  },
  calls: [],
};
globalThis[MOCK_KEY] = mockState;

export function setRunSubagentTaskMock(fn) {
  mockState.calls = [];
  mockState.impl = fn;
}

export function getRunSubagentTaskCalls() {
  return [...mockState.calls];
}

export async function runSubagentTask(input) {
  mockState.calls.push(input);
  return await mockState.impl(input);
}

export async function resumeSubagentTask(input) {
  mockState.calls.push(input);
  return await mockState.impl(input);
}

export async function loadBackgroundModule() {
  return load(join(packageRoot, "src", "subagents", "background.ts"));
}

export async function loadToolModule() {
  return loadTool(join(packageRoot, "src", "subagents", "tool.ts"));
}

function formatCount(count) {
  if (count < 1000) return String(count);
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

function formatMs(ms) {
  if (!ms || ms < 0) return "0ms";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

export function renderSubagentCall() {
  return new Text("subagent call");
}

export function renderSubagentResult() {
  return new Text("subagent result");
}

export function renderSubagentNotification() {
  return new Text("subagent notification");
}

export function createPromptSnapshot(overrides = {}) {
  return {
    version: 2,
    system: "test system prompt",
    instructions: "test instructions",
    output: "test output",
    manifest: {
      contractVersion: 2,
      governanceVersion: 1,
      inheritParentSystem: true,
      effectiveSystemHash: "system-hash",
      governanceHash: "governance-hash",
      contextCount: 0,
      fieldSources: {},
      sourceFiles: [],
    },
    ...overrides,
  };
}

export function formatUsage(usage, model, durationMs) {
  const parts = [];
  if (usage.turns > 0) parts.push(`${usage.turns} turn${usage.turns === 1 ? "" : "s"}`);
  if (usage.input > 0) parts.push(`↑${formatCount(usage.input)}`);
  if (usage.output > 0) parts.push(`↓${formatCount(usage.output)}`);
  if (usage.cacheRead > 0) parts.push(`R${formatCount(usage.cacheRead)}`);
  if (usage.cacheWrite > 0) parts.push(`W${formatCount(usage.cacheWrite)}`);
  if (usage.cost > 0) parts.push(`$${usage.cost.toFixed(4)}`);
  if (durationMs && durationMs > 0) parts.push(formatMs(durationMs));
  if (model) parts.push(model);
  return parts.join(" · ");
}

export function createPiStub() {
  const sent = [];
  return {
    sent,
    api: {
      sendMessage(message, options) {
        sent.push({ message, options });
      },
    },
  };
}

export class Container {}

export class Text {
  constructor(text) {
    this.text = String(text);
  }

  render(width) {
    return this.text.split(/\r?\n/).flatMap((line) => wrapTextWithAnsi(line, width));
  }
}

export function visibleWidth(text) {
  return Array.from(stripVTControlCharacters(String(text))).length;
}

export function truncateToWidth(text, width, ellipsis = "", pad = false) {
  const target = Math.max(0, width);
  const characters = Array.from(String(text));
  const suffix = Array.from(ellipsis);
  let result = characters.length <= target
    ? characters.join("")
    : characters.slice(0, Math.max(0, target - suffix.length)).join("") + suffix.join("");
  if (pad && visibleWidth(result) < target) result += " ".repeat(target - visibleWidth(result));
  return result;
}

export function wrapTextWithAnsi(text, width) {
  const target = Math.max(1, width);
  const characters = Array.from(String(text));
  if (characters.length === 0) return [""];
  const lines = [];
  for (let index = 0; index < characters.length; index += target) {
    lines.push(characters.slice(index, index + target).join(""));
  }
  return lines;
}

export function createThemeStub() {
  return {
    fg: (_key, text) => String(text),
    bg: (_key, text) => String(text),
    bold: (text) => String(text),
  };
}

export function createTuiStub(rows = 24) {
  let renders = 0;
  return {
    terminal: { rows },
    requestRender() {
      renders += 1;
    },
    renderCount() {
      return renders;
    },
  };
}

export function createExtensionStub() {
  const shortcuts = new Map();
  const events = new Map();
  return {
    shortcuts,
    events,
    api: {
      registerShortcut(name, definition) {
        shortcuts.set(name, definition);
      },
      on(eventName, handler) {
        events.set(eventName, handler);
      },
    },
  };
}

export function test(name, fn) {
  tests.push({ name, fn });
}

export async function waitFor(predicate, description, timeoutMs = 1000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

export async function run() {
  let failed = 0;

  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`PASS: ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`FAIL: ${name} — ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.log(`\n${tests.length} tests, ${failed} failed`);
  if (failed > 0) process.exit(1);
}
