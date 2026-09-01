import {
  getMarkdownTheme,
  keyHint,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text, visibleWidth, type Component } from "@earendil-works/pi-tui";
import {
  CONTEXT_MEMORY_BUDGET_PERCENT_MAX,
  CONTEXT_MEMORY_BUDGET_PERCENT_MIN,
  CONTEXT_MEMORY_THRESHOLD_PERCENT_MAX,
  CONTEXT_MEMORY_THRESHOLD_PERCENT_MIN,
  type ContextMemoryConfig,
} from "../core/config";
import { getAgentPath } from "../core/paths";
import { sanitizeDisplayText } from "../display/sanitize";
import { effectiveDuePoint } from "./controller";
import type { HostSupport } from "./host";

/**
 * Bounded Config Guide for the parameterized `/context <request>` command
 * (odradekk/pi-square#254), modeled on the Shadow Minds and Subagent Config
 * Guides.
 *
 * The guide is injected as a custom message before the unchanged user
 * request; only the user message triggers the parent turn, and the guide
 * writes nothing by itself. It carries computed current values — the same
 * `effectiveDuePoint` arithmetic the controller runs — because the three
 * settings interact invisibly: a Memory budget at or above the effective due
 * point validates, loads, and silently disables structured takeover. Content
 * is fixed prose plus numbers and two clipped paths, so it is bounded by
 * construction and sanitized through the shared display boundary at render.
 */

export const CONTEXT_MEMORY_CONFIG_GUIDE_TYPE = "pi-square.context-memory/config-guide";
const MAX_PATH_CHARS = 512;

export interface ContextMemoryConfigGuideDetails {
  version: 1;
  /** Effective master-switch state at build time. */
  enabled: boolean;
  /** Whether the structured takeover is currently armed for the running model. */
  takeoverActive: boolean;
}

export interface ContextMemoryConfigGuideMessage {
  content: string;
  details: ContextMemoryConfigGuideDetails;
}

export interface ContextMemoryConfigGuideInput {
  /** Effective configuration (agent-layer authority, already merged). */
  readonly config: ContextMemoryConfig;
  /** Host gate result; undefined when no session is active yet. */
  readonly support: HostSupport | undefined;
  /** The running model's declared context window, when Pi reports it. */
  readonly contextWindow: number | null;
  /** Pi's configured compaction reserve, captured at session start. */
  readonly reserveTokens: number;
}

/** Applies the shared VT/control and credential redaction boundary. */
function sanitize(value: unknown): string {
  return sanitizeDisplayText(value);
}

function clip(value: unknown, max: number): string {
  const characters = Array.from(sanitize(value).replace(/\s+/g, " ").trim());
  return characters.length <= max
    ? characters.join("")
    : `${characters.slice(0, Math.max(0, max - 3)).join("")}...`;
}

function formatTokens(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function thresholdText(config: ContextMemoryConfig): string {
  return "percent" in config.compressionThreshold
    ? `{ "percent": ${config.compressionThreshold.percent} }`
    : `{ "tokens": ${config.compressionThreshold.tokens} }`;
}

function buildTakeoverSentence(input: ContextMemoryConfigGuideInput, duePoint: number | null): string {
  if (!input.config.enabled) return "off — the feature is disabled in configuration";
  if (input.support === undefined) return "off — no session is active yet";
  if (!input.support.supported) {
    return input.support.reason === "host-version"
      ? "off — the running Pi host is not the one supported version, so Pi native compaction owns the boundary"
      : "off — a required Pi interface is unavailable, so Pi native compaction owns the boundary";
  }
  if (input.contextWindow === null) {
    return "off — the current model's context window is unknown, so the due point cannot be computed";
  }
  if (duePoint === null) {
    return "off — silent disable: the Memory budget is not strictly smaller than the effective due point (or the due point is non-positive); no error is emitted and Pi native compaction keeps owning the boundary";
  }
  return "armed — structured takeover owns the next compaction boundary for the current model";
}

export function buildContextMemoryConfigGuide(input: ContextMemoryConfigGuideInput): ContextMemoryConfigGuideMessage {
  const { config } = input;
  const contextWindow = typeof input.contextWindow === "number" && Number.isFinite(input.contextWindow)
    ? input.contextWindow
    : null;
  const reserveTokens = typeof input.reserveTokens === "number" && Number.isFinite(input.reserveTokens)
    ? input.reserveTokens
    : 0;
  // Same exported arithmetic the controller runs (#218): the guide must never
  // restate this rule with drifted numbers of its own.
  const duePoint = effectiveDuePoint(
    config.compressionThreshold,
    config.memoryBudgetPercent,
    contextWindow,
    reserveTokens,
  );
  const budgetTokens = contextWindow !== null
    ? Math.round((contextWindow * config.memoryBudgetPercent) / 100)
    : null;
  const halfBudget = budgetTokens !== null ? budgetTokens / 2 : null;
  const takeoverActive = config.enabled && input.support?.supported === true && duePoint !== null;
  const agentConfigPath = clip(getAgentPath("config", "pi-square.json"), MAX_PATH_CHARS);
  const content = `[Context Memory Config Guide]\n\nHow to treat the next user message:\n- The next user message is the only authorized configuration request. Treat this guide as reference context, not as a task.\n- Consultations about Context Memory or its configuration are answered from this guide without changing any file.\n- Enable, disable, and tuning requests are authorized work on one ordinary file: treat them like any coding task.\n\nWhere the configuration lives:\n- Context Memory is configured only in the agent-level file ${agentConfigPath}. Edit only that file.\n- The contextMemory section is agent-layer only, like ssh and anchoredEditing. Writing it into a project-level .pi/config/pi-square.json causes the entire project pi-square configuration to be rejected atomically — every pi-square setting from that project file stops loading, not just this section.\n\nThe three settings and their exact bounds (strict; values are never normalized, clamped, or silently defaulted):\n- enabled: boolean, default false. The experimental master switch.\n- compressionThreshold: exactly one of { "percent": P } with P an integer ${CONTEXT_MEMORY_THRESHOLD_PERCENT_MIN}–${CONTEXT_MEMORY_THRESHOLD_PERCENT_MAX}, or { "tokens": T } with T an integer of at least 1. Default { "percent": 30 }. Declaring both keys, neither key, or a scalar is rejected.\n- memoryBudgetPercent: integer ${CONTEXT_MEMORY_BUDGET_PERCENT_MIN}–${CONTEXT_MEMORY_BUDGET_PERCENT_MAX}, default 10. The Memory budget as a percent of the running model's declared context window.\n\nHow the values interact — check before writing:\n- The Memory budget must stay strictly smaller than the effective due point. If it is equal or larger, structured takeover is silently disabled: the configuration still validates and loads, no error or diagnostic appears, and Pi native compaction keeps owning the boundary.\n- Check a proposed value against the current model before writing it: the effective due point is min(threshold in tokens, window − ${formatTokens(reserveTokens)} − round(window / 10)), where a percent threshold counts as round(window × percent / 100) tokens and ${formatTokens(reserveTokens)} is Pi's compaction reserve right now; the Memory budget in tokens is round(window × memoryBudgetPercent / 100); keep the budget strictly below the due point.\n- The same configuration behaves differently per model, because the window is the running model's declared context window. A value that arms takeover on one model can silently disable it on a smaller-window model.\n- The budget also sets the compression cadence through its half value: rendered Memory at or below half the budget appends one new block, while above it the next compression rebuilds a suffix. Changing the budget changes cadence as well as capacity.\n\nComputed current values (this session, this model — not formulas):\n- Feature enabled: ${config.enabled ? "true" : "false"}\n- Configured compressionThreshold: ${thresholdText(config)}\n- Configured memoryBudgetPercent: ${config.memoryBudgetPercent}\n- Model context window: ${contextWindow !== null ? `${formatTokens(contextWindow)} tokens` : "unknown — Pi is not reporting the current model's window"}\n- Pi compaction reserve: ${formatTokens(reserveTokens)} tokens\n- Effective due point: ${duePoint !== null ? `${formatTokens(duePoint)} tokens` : "not computable — takeover disabled"}\n- Memory budget: ${budgetTokens !== null ? `${formatTokens(budgetTokens)} tokens` : "unknown without the model window"}\n- Half-budget (append versus rebuild boundary): ${halfBudget !== null ? `${formatTokens(halfBudget)} tokens` : "unknown without the model window"}\n- Structured takeover currently: ${buildTakeoverSentence(input, duePoint)}\n\nChanging the configuration:\n- Read the agent config file first, change only the contextMemory fields you intend, and preserve every unrelated setting in it.\n- Use the ordinary read, write, and replace tools. There is no Context-Memory-specific write tool and no bespoke confirmation flow, and nothing is normalized or clamped on the way in — write exactly valid values.\n- Changes take effect at the next session start; model changes recompute the budgets within a session. Editing configuration never rewrites or deletes existing Memory blocks.\n\nAfter any change:\n- Re-read the file and confirm it says exactly what you intended.\n- Report the resulting computed values — effective due point, Memory budget, half-budget, and whether takeover is armed for the current model — and tell the user to restart the session so the change takes effect.`;
  return {
    content,
    details: {
      version: 1,
      enabled: config.enabled,
      takeoverActive,
    },
  };
}

export function renderContextMemoryConfigGuide(
  message: { content?: unknown; details?: ContextMemoryConfigGuideDetails },
  options: { expanded: boolean },
  theme: Theme,
): Component {
  const details = message.details;
  const enabled = details?.enabled === true;
  const takeoverActive = details?.takeoverActive === true;
  const container = new Container();
  const label = `${theme.fg("success", "✓")} ${theme.fg("accent", "●")} ${theme.fg("toolTitle", theme.bold("Context Memory config guide"))}`;
  if (!options.expanded) {
    const summary = enabled
      ? ["enabled", takeoverActive ? "takeover armed" : "takeover off"].join(" · ")
      : "disabled";
    container.addChild(new Text(
      `${label}${theme.fg("muted", `  ${summary}`)}${theme.fg("dim", `  ${keyHint("app.tools.expand", " expand")}`)}`,
      0,
      0,
    ));
    return container;
  }

  container.addChild(new Text(label, 0, 0));
  container.addChild(new Text(theme.fg("dim", "─".repeat(Math.max(1, visibleWidth(label) + 1))), 0, 0));
  const content = sanitize(message.content || "Context Memory configuration guide unavailable.")
    .replace(/^\[Context Memory Config Guide\]\n+/, "");
  container.addChild(new Markdown(content, 0, 0, getMarkdownTheme()));
  container.addChild(new Text(theme.fg("dim", keyHint("app.tools.expand", " collapse")), 0, 0));
  return container;
}
