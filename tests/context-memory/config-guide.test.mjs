import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { stripVTControlCharacters } from "node:util";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import jiti from "jiti";
import { initTheme, SessionManager } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

initTheme();


const packageRoot = resolve(import.meta.dirname, "..", "..");
const cleanAgentDir = join(tmpdir(), `pi-square-context-config-guide-${process.pid}`);
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = cleanAgentDir;
const load = jiti(import.meta.url, { moduleCache: false });
const { effectiveDuePoint } = await load(join(packageRoot, "src", "context-memory", "controller.ts"));
const {
  buildContextMemoryConfigGuide,
  renderContextMemoryConfigGuide,
  CONTEXT_MEMORY_CONFIG_GUIDE_TYPE,
} = await load(join(packageRoot, "src", "context-memory", "config-guide.ts"));
const themeModulePath = pathToFileURL(join(
  packageRoot,
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "dist",
  "modes",
  "interactive",
  "theme",
  "theme.js",
)).href;
const { loadThemeFromPath } = await import(themeModulePath);

const plainTheme = {
  fg(_color, text) { return String(text); },
  bg(_color, text) { return String(text); },
  bold(text) { return String(text); },
};

const WINDOW = 200_000;
const RESERVE = 32_000;
const support = { supported: true };

function plain(component, width = 100) {
  return component.render(width).map((line) => stripVTControlCharacters(line)).join("\n");
}

/**
 * #254: the `/context <request>` Config Guide. The guide must carry computed
 * current values through the controller's own exported due-point arithmetic,
 * state the silent-disable interaction and the agent-layer-only authority,
 * and render through the shared bounded, sanitized display boundary exactly
 * like the Shadow Minds and Subagent guides.
 */

try {
  assert.equal(CONTEXT_MEMORY_CONFIG_GUIDE_TYPE, "pi-square.context-memory/config-guide");

  // ── Computed current values, not formulas ──────────────────────────
  {
    const config = { enabled: true, compressionThreshold: { percent: 30 }, memoryBudgetPercent: 10 };
    const guide = buildContextMemoryConfigGuide({ config, support, contextWindow: WINDOW, reserveTokens: RESERVE });
    const duePoint = effectiveDuePoint(config.compressionThreshold, config.memoryBudgetPercent, WINDOW, RESERVE);
    assert.equal(duePoint, 60_000, "fixture: the configured threshold is the binding term");
    assert.deepEqual(guide.details, { version: 1, enabled: true, takeoverActive: true });
    const content = guide.content;
    assert.match(content, /Model context window: 200000 tokens/);
    assert.match(content, /Pi compaction reserve: 32000 tokens/);
    assert.match(content, /Effective due point: 60000 tokens/);
    assert.match(content, /Memory budget: 20000 tokens/);
    assert.match(content, /Half-budget \(append versus rebuild boundary\): 10000 tokens/);
    assert.match(content, /Configured compressionThreshold: \{ "percent": 30 \}/);
    assert.match(content, /Configured memoryBudgetPercent: 10/);
    assert.match(content, /Structured takeover currently: armed/);
    assert.ok(content.length < 16_000, `guide content stays bounded (${content.length} chars)`);

    // The same builder stays deterministic.
    assert.deepEqual(
      buildContextMemoryConfigGuide({ config, support, contextWindow: WINDOW, reserveTokens: RESERVE }),
      guide,
    );
  }

  // ── The silent disable: budget at or above the effective due point ──
  {
    // A token threshold below the safety clamp with a budget that reaches
    // past it: valid configuration, silently dead takeover.
    const config = { enabled: true, compressionThreshold: { tokens: 30_000 }, memoryBudgetPercent: 25 };
    assert.equal(effectiveDuePoint(config.compressionThreshold, 25, WINDOW, RESERVE), null);
    const guide = buildContextMemoryConfigGuide({ config, support, contextWindow: WINDOW, reserveTokens: RESERVE });
    assert.equal(guide.details.takeoverActive, false);
    assert.match(guide.content, /Effective due point: not computable — takeover disabled/);
    assert.match(guide.content, /Memory budget: 50000 tokens/);
    assert.match(guide.content, /Structured takeover currently: off — silent disable/);
    assert.match(guide.content, /silently disabled: the configuration still validates and loads, no error or diagnostic appears/);
    // The agent gets the arithmetic it needs to check a proposed value first.
    assert.match(guide.content, /window − 32000 − round\(window \/ 10\)/);
    assert.match(guide.content, /round\(window × memoryBudgetPercent \/ 100\)/);
    assert.match(guide.content, /keep the budget strictly below the due point/);
  }

  // ── Unknown window, disabled feature, no session ────────────────────
  {
    const config = { enabled: true, compressionThreshold: { percent: 30 }, memoryBudgetPercent: 10 };
    const unknownWindow = buildContextMemoryConfigGuide({ config, support, contextWindow: null, reserveTokens: RESERVE });
    assert.equal(unknownWindow.details.takeoverActive, false);
    assert.match(unknownWindow.content, /Model context window: unknown/);
    assert.match(unknownWindow.content, /Memory budget: unknown without the model window/);
    assert.match(unknownWindow.content, /Structured takeover currently: off — the current model's context window is unknown/);

    const disabled = buildContextMemoryConfigGuide({
      config: { enabled: false, compressionThreshold: { percent: 30 }, memoryBudgetPercent: 10 },
      support,
      contextWindow: WINDOW,
      reserveTokens: RESERVE,
    });
    assert.equal(disabled.details.enabled, false);
    assert.equal(disabled.details.takeoverActive, false);
    assert.match(disabled.content, /Feature enabled: false/);
    assert.match(disabled.content, /Structured takeover currently: off — the feature is disabled in configuration/);

    const preSession = buildContextMemoryConfigGuide({ config, support: undefined, contextWindow: WINDOW, reserveTokens: RESERVE });
    assert.match(preSession.content, /Structured takeover currently: off — no session is active yet/);

    for (const reason of ["host-version", "host-interfaces"]) {
      const unsupported = buildContextMemoryConfigGuide({
        config,
        support: { supported: false, reason },
        contextWindow: WINDOW,
        reserveTokens: RESERVE,
      });
      assert.equal(unsupported.details.takeoverActive, false);
      assert.match(unsupported.content, /Structured takeover currently: off — .+ Pi native compaction owns the boundary/);
    }
  }

  // ── Configuration contract sentences the ticket fixes ──────────────
  {
    const guide = buildContextMemoryConfigGuide({
      config: { enabled: true, compressionThreshold: { percent: 30 }, memoryBudgetPercent: 10 },
      support,
      contextWindow: WINDOW,
      reserveTokens: RESERVE,
    });
    const content = guide.content;
    assert.match(content, /next user message is the only authorized configuration request/i);
    assert.match(content, /Consultations about Context Memory or its configuration are answered from this guide without changing any file/);
    assert.match(content, /agent-layer only/);
    assert.match(content, /Writing it into a project-level \.pi\/config\/pi-square\.json causes the entire project pi-square configuration to be rejected atomically/);
    assert.match(content, /Edit only that file/);
    assert.match(content, /never normalized, clamped, or silently defaulted/);
    assert.match(content, /P an integer 10–80/);
    assert.match(content, /T an integer of at least 1/);
    assert.match(content, /memoryBudgetPercent: integer 1–25/);
    assert.match(content, /ordinary read, write, and replace tools/);
    assert.match(content, /no Context-Memory-specific write tool and no bespoke confirmation flow/);
    assert.match(content, /changes cadence as well as capacity/);
    assert.match(content, /restart the session/);
    assert.match(content, new RegExp(cleanAgentDir.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(content, /\b(password|secret|api[_-]?key|token)\s*[:=]/i);
  }

  // ── Renderer: collapsed, expanded, sanitized, unframed ─────────────
  {
    const guide = buildContextMemoryConfigGuide({
      config: { enabled: true, compressionThreshold: { percent: 30 }, memoryBudgetPercent: 10 },
      support,
      contextWindow: WINDOW,
      reserveTokens: RESERVE,
    });
    const collapsed = plain(renderContextMemoryConfigGuide(guide, { expanded: false }, plainTheme));
    assert.match(collapsed, /✓ ● Context Memory config guide/);
    assert.match(collapsed, /enabled · takeover armed/);
    assert.match(collapsed, /expand/);
    assert.equal(collapsed.split("\n").length, 1, "the collapsed guide is one row");
    assert.doesNotMatch(collapsed, /Computed current values/);

    const expanded = plain(renderContextMemoryConfigGuide(guide, { expanded: true }, plainTheme));
    assert.match(expanded, /Computed current values/);
    assert.match(expanded, /60000 tokens/);
    assert.match(expanded, /collapse/);
    assert.doesNotMatch(expanded, /\[Context Memory Config Guide\]/, "the bracket tag is replaced by the label");
  }

  {
    const disabledGuide = buildContextMemoryConfigGuide({
      config: { enabled: false, compressionThreshold: { percent: 30 }, memoryBudgetPercent: 10 },
      support,
      contextWindow: WINDOW,
      reserveTokens: RESERVE,
    });
    const collapsed = plain(renderContextMemoryConfigGuide(disabledGuide, { expanded: false }, plainTheme));
    assert.match(collapsed, /disabled/);
    assert.doesNotMatch(collapsed, /takeover armed/);
  }

  {
    const backgrounds = [];
    const theme = { ...plainTheme, bg(color, text) { backgrounds.push(color); return String(text); } };
    const rendered = plain(renderContextMemoryConfigGuide({
      content: "Guide\x1b]0;owned\x07\napi_key=s3cr3t",
      details: { version: 1, enabled: true, takeoverActive: false },
    }, { expanded: true }, theme));
    assert.equal(backgrounds.includes("customMessageBg"), false, "guide must not use a background card");
    assert.doesNotMatch(rendered, /owned|s3cr3t|\x1b|\x07/);
    assert.match(rendered, /api_key=\[REDACTED\]/);

    const fallback = plain(renderContextMemoryConfigGuide({ content: undefined, details: undefined }, { expanded: true }, plainTheme));
    assert.match(fallback, /Context Memory configuration guide unavailable/);
    assert.match(fallback, /✓ ● Context Memory config guide/);
  }

  // Semantic tokens only: the operational grammar, not customMessage*.
  {
    const tokenTheme = {
      fg(color, text) { return `[${color}]{${text}}`; },
      bg(_c, t) { return String(t); },
      bold(t) { return String(t); },
    };
    const tokenCollapsed = renderContextMemoryConfigGuide(
      { content: "x", details: { version: 1, enabled: true, takeoverActive: true } },
      { expanded: false },
      tokenTheme,
    ).render(100).join("");
    assert.match(tokenCollapsed, /\[success\]/);
    assert.match(tokenCollapsed, /\[toolTitle\]/);
    assert.doesNotMatch(tokenCollapsed, /customMessage/, "guide does not use customMessage tokens");
  }

  // ── Real themes keep the guide bounded at every boundary width ─────
  {
    const guide = buildContextMemoryConfigGuide({
      config: { enabled: true, compressionThreshold: { tokens: 30_000 }, memoryBudgetPercent: 25 },
      support,
      contextWindow: WINDOW,
      reserveTokens: RESERVE,
    });
    for (const file of ["pi-square-theme-dark.json", "pi-square-theme-light.json"]) {
      const theme = loadThemeFromPath(join(packageRoot, "themes", file));
      for (const width of [39, 40, 63, 64, 80, 99, 100, 120]) {
        for (const expanded of [false, true]) {
          const lines = renderContextMemoryConfigGuide(guide, { expanded }, theme).render(width);
          assert.ok(lines.length > 0, `${file} ${width} renders content`);
          for (const line of lines) {
            assert.ok(visibleWidth(line) <= width, `${file} exceeded ${width}: ${stripVTControlCharacters(line)}`);
          }
        }
      }
    }
  }
  // ── Registrar wiring: renderer registration and live values (#254) ─
  {
    const registerContextMemory = (await load(join(packageRoot, "src", "context-memory", "index.ts"))).default;
    const tools = new Map();
    const events = new Map();
    const renderers = new Map();
    let active = ["read", "bash"];
    const pi = {
      registerTool(definition) { tools.set(definition.name, definition); },
      registerMessageRenderer(name, renderer) { renderers.set(name, renderer); },
      on(name, handler) {
        const handlers = events.get(name) ?? [];
        handlers.push(handler);
        events.set(name, handlers);
      },
      getAllTools() { return [...tools.values()]; },
      getActiveTools() { return [...active]; },
      setActiveTools(names) { active = [...names]; },
    };
    const config = { enabled: true, compressionThreshold: { percent: 30 }, memoryBudgetPercent: 10 };
    const registration = registerContextMemory(pi, {
      configProvider: () => ({ contextMemory: config }),
      displayRuntimeProvider: () => {
        throw new Error("the guide path never renders");
      },
      reserveTokens: () => RESERVE,
    });
    assert.equal(typeof renderers.get(CONTEXT_MEMORY_CONFIG_GUIDE_TYPE), "function",
      "the registrar registers the guide's message renderer");

    async function emit(name, event, ctx) {
      let last;
      for (const handler of events.get(name) ?? []) last = await handler(event, ctx);
      return last;
    }

    // Before any session the guide falls back to the configuration provider
    // with no host opinion and the default Pi reserve.
    const preSession = registration.configGuide({ tokens: 1000, contextWindow: WINDOW });
    assert.equal(preSession.details.enabled, true);
    assert.equal(preSession.details.takeoverActive, false);
    assert.match(preSession.content, /off — no session is active yet/);
    assert.match(preSession.content, /Pi compaction reserve: \d+ tokens/);

    const sessionManager = SessionManager.inMemory("/project");
    sessionManager.appendMessage({ role: "user", content: "hello", timestamp: 1 });
    const ctx = {
      cwd: "/project",
      hasUI: false,
      mode: "rpc",
      sessionManager,
      compact() {},
      getContextUsage: () => ({ tokens: 40_000, contextWindow: WINDOW, percent: 20 }),
      getSystemPrompt: () => "",
      isIdle: () => true,
      hasPendingMessages: () => false,
      isProjectTrusted: () => true,
    };
    await emit("session_start", { type: "session_start", reason: "startup" }, ctx);

    const live = registration.configGuide({ tokens: 40_000, contextWindow: WINDOW });
    assert.equal(live.details.takeoverActive, true, "supported host with a valid due point arms takeover");
    assert.match(live.content, /Effective due point: 60000 tokens/);
    assert.match(live.content, /Pi compaction reserve: 32000 tokens/);

    // The guide is read-only: building it changes no active tool and writes
    // no session entry.
    // An empty branch keeps read_memory_source inactive; building the guide
    // changes no active tool either way.
    assert.deepEqual(active, ["read", "bash"]);
    registration.configGuide();
    assert.deepEqual(active, ["read", "bash"]);

    await emit("session_shutdown", { type: "session_shutdown" }, ctx);
    const settled = registration.configGuide({ tokens: 40_000, contextWindow: WINDOW });
    assert.equal(settled.details.takeoverActive, false);
    assert.match(settled.content, /off — no session is active yet/);
  }
} finally {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
}

console.log("context-memory config guide tests: OK");
