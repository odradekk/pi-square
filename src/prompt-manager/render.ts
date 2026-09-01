import { isEphemeralMemorySnapshot, type ContextMemorySnapshot } from "../context-memory/view";
import type { PromptManagerSegment } from "./types";
import { sanitizeDisplayLine } from "../display/sanitize";
import type { ByRoleChars, CollapsedEntries, MessageEntrySummary } from "./decompose";

// ----------------------------------------------------------------------------
// Theme wrapper
// ----------------------------------------------------------------------------

/**
 * Theme wrapper accepted by colour-aware renderers. `null` => no ANSI
 * colour applied (pipe redirection / dumb terminal). Pi exposes
 * `ctx.ui.theme.fg(color, text)`; index.ts builds the wrapper with a
 * try/catch guard so unknown color tokens degrade gracefully.
 */
export interface ThemeWrapper {
  fg(color: string, text: string): string;
}

function paint(theme: ThemeWrapper | null, color: string, text: string): string {
  if (!theme) return text;
  return theme.fg(color, text);
}

// ----------------------------------------------------------------------------
// Small text utilities
// ----------------------------------------------------------------------------

function clean(value: unknown): string {
  return sanitizeDisplayLine(value).replace(/\\[nrt]/g, " ").replace(/\s+/g, " ").trim();
}

function charCount(s: string): number {
  return Array.from(s).length;
}

function padRight(s: string, width: number): string {
  const len = charCount(s);
  return len >= width ? s : s + " ".repeat(width - len);
}

function padLeft(s: string, width: number): string {
  const len = charCount(s);
  return len >= width ? s : " ".repeat(width - len) + s;
}

function phaseLabel(phase: PromptManagerSegment["phase"]): string {
  switch (phase) {
    case "stable-prefix": return "stable";
    case "dynamic-suffix": return "dynamic";
  }
}

function phaseColor(phase: PromptManagerSegment["phase"]): string {
  return phase === "stable-prefix" ? "dim" : "mdQuote";
}

function formatNumber(n: number): string {
  if (n < 10000) return String(n);
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

/** Short magnitude format for compact rows: 74 223 -> "74.2k", 1 000 000 -> "1.0M". */
function formatShort(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 2 : 1) + "k";
  if (n < 1_000_000_000) return (n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1) + "M";
  return (n / 1_000_000_000).toFixed(1) + "B";
}

// ----------------------------------------------------------------------------
// Common rendering helpers
// ----------------------------------------------------------------------------

/** Continuation tree rail for notification body lines.
 *
 * The shared transcript grammar uses `│` for continuation and `└─` for
 * the final body line, but those glyphs are chosen by the render loop
 * which knows line count and width. Notification text is a plain
 * string with no render callback, so `│  ` is used uniformly for
 * structural consistency within the owned content. */
const RAIL_CONT = "│  ";

/** Open the unframed operational surface with a one-cell status rail. */
function openPanel(theme: ThemeWrapper | null, headerText: string): string {
  return paint(theme, "success", "✓") + " " + headerText;
}

function blankInner(_theme: ThemeWrapper | null): string {
  return "";
}

/** Top-level structure header text (used by summary/verbose openPanel arg). */
function headerText(theme: ThemeWrapper | null, input: PromptManagerViewInput): string {
  const tokensStr = input.groundTruthTokens !== null
    ? `${paint(theme, "text", formatShort(input.groundTruthTokens))} tokens` +
      (input.groundTruthWindow !== null
        ? ` ${paint(theme, "dim", "/")} ${paint(theme, "dim", formatShort(input.groundTruthWindow) + " window")}`
        : "")
    : paint(theme, "dim", "tokens unknown");

  const errorTag = input.errors.length > 0
    ? ` ${paint(theme, "dim", "·")} ${paint(theme, "error", `${input.errors.length} ${input.errors.length === 1 ? "error" : "errors"}`)}`
    : "";

  return (
    paint(theme, "toolTitle", "Prompt Manager") +
    ` ${paint(theme, "dim", "·")} ` +
    paint(theme, "muted", `turn ${input.currentTurn}.${input.subturn}`) +
    ` ${paint(theme, "dim", "·")} ` +
    tokensStr +
    errorTag
  );
}

function errorBody(theme: ThemeWrapper | null, input: PromptManagerViewInput): string[] {
  if (input.errors.length === 0) return [];
  const lines: string[] = [blankInner(theme)];
  for (const err of input.errors) {
    lines.push(
      RAIL_CONT +
      paint(theme, "error", "! ") +
      paint(theme, "error", clean(err)),
    );
  }
  return lines;
}

// ----------------------------------------------------------------------------
// Section renderers
// ----------------------------------------------------------------------------

export interface ToolInfoLite {
  name: string;
  description?: string;
  parameters?: unknown;
}

function totalToolsSchemaChars(tools: ToolInfoLite[]): number {
  let total = 0;
  for (const t of tools) {
    total += charCount(t.name ?? "");
    total += charCount(t.description ?? "");
    try { total += JSON.stringify(t.parameters ?? {}).length; } catch { /* ignore */ }
  }
  return total;
}

function renderToolsSection(theme: ThemeWrapper | null, tools: ToolInfoLite[]): string[] {
  const totalSchemaChars = totalToolsSchemaChars(tools);
  const lines: string[] = [];
  lines.push(
    RAIL_CONT +
    paint(theme, "text", "tools[]") +
    "      " +
    paint(theme, "dim", `${tools.length} items · ~${formatShort(totalSchemaChars)} chars schema · side-channel`),
  );

  // Wrap tool names at ~72 cols inside the panel.
  const names = tools.map((t) => clean(t.name)).filter(Boolean);
  let current = "";
  const wrapped: string[] = [];
  for (const name of names) {
    const piece = current === "" ? name : `  ${name}`;
    if (charCount(current + piece) > 72) {
      wrapped.push(current);
      current = name;
    } else {
      current += piece;
    }
  }
  if (current) wrapped.push(current);

  for (const row of wrapped) {
    lines.push(RAIL_CONT + "  " + paint(theme, "toolTitle", row));
  }
  return lines;
}

interface SystemRow {
  idx: number;
  id: string;
  label: string;
  chars: number;
  phase: string;
  phaseForColor: PromptManagerSegment["phase"] | "missing";
  details: { label: string; value: string }[];
  stale: boolean;
  missing: boolean;
}

function renderSystemSection(
  theme: ThemeWrapper | null,
  segments: PromptManagerSegment[],
  order: string[],
  currentTurn: number,
  systemPromptChars: number,
): string[] {
  const byId = new Map(segments.map((segment) => [segment.id, segment]));
  const rows: SystemRow[] = order.map((id, idx) => {
    const segment = byId.get(id as PromptManagerSegment["id"]);
    return {
      idx: idx + 1,
      id,
      label: clean(segment?.label ?? id),
      chars: segment ? charCount(segment.text) : 0,
      phase: segment ? phaseLabel(segment.phase) : "missing",
      phaseForColor: segment ? segment.phase : "missing",
      details: segment?.details ? [...segment.details] : [],
      stale: segment ? segment.turnSeq !== currentTurn : false,
      missing: !segment,
    };
  });

  const labelWidth = Math.max(...rows.map((row) => charCount(row.label)), 14);
  const charsWidth = Math.max(...rows.map((row) => formatNumber(row.chars).length), 5);
  const phaseWidth = 8;

  const lines: string[] = [];
  lines.push(
    RAIL_CONT +
    paint(theme, "text", "systemPrompt") +
    "  " +
    paint(theme, "dim", `${formatNumber(systemPromptChars)} chars · ${order.length} phases`),
  );

  for (const row of rows) {
    const idxStr = paint(theme, "dim", `${padLeft(String(row.idx), 1)}.`);
    const labelStr = paint(theme, "text", padRight(row.label, labelWidth));
    const charsStr = row.chars === 0
      ? paint(theme, "dim", padLeft("-", charsWidth))
      : paint(theme, "syntaxNumber", padLeft(formatNumber(row.chars), charsWidth));
    const color = row.missing
      ? "error"
      : phaseColor(row.phaseForColor as PromptManagerSegment["phase"]);
    const phaseStr = paint(theme, color, padRight(row.phase, phaseWidth));
    const staleStr = row.stale ? "  " + paint(theme, "warning", "stale") : "";

    let detailsStr = "";
    if (row.missing) {
      detailsStr = "  " + paint(theme, "error", "(not registered this turn)");
    } else if (row.details.length > 0) {
      const parts = row.details.map((detail) =>
        paint(theme, "dim", clean(detail.label) + ":") + " " + paint(theme, "text", clean(detail.value)),
      );
      const separator = " " + paint(theme, "dim", "·") + " ";
      detailsStr = "  " + parts.join(separator);
    }

    lines.push(
      RAIL_CONT + "  " +
      idxStr + "  " +
      labelStr + "  " +
      charsStr + "   " +
      phaseStr +
      staleStr +
      detailsStr,
    );
  }
  return lines;
}

/**
 * Context Memory `memory[]` section (odradekk/pi-square#215, #216, #217, #218, #220, #221): the
 * selected Variant A inline hierarchy, rendered between the system-prompt
 * section and the message section. Inactive states stay one bounded line;
 * active Memory shows state, Memory/budget estimate, block count, stable
 * prefix, next operation, current usage, and one bounded chronological row
 * per block. No format versions, entry ranges/IDs, paths, timestamps, or
 * storage details ever appear. Never part of the usage bar — Memory
 * accounting leaves the total usage bar unchanged (#215). Ephemeral
 * in-memory sessions are reported as such (#221); the scale-limit line
 * states that Pi native compaction owns the boundary (#220).
 */
function renderMemorySection(theme: ThemeWrapper | null, memory: ContextMemorySnapshot): string[] {
  if (memory.state !== "active") {
    let description: string;
    switch (memory.state) {
      case "disabled":
        description = "disabled · enable through agent-level contextMemory configuration";
        break;
      case "unsupported":
        // Capability detection (#255): the only unsupported cause is missing
        // interfaces; the running host version rides along as information.
        description = typeof memory.hostVersion === "string"
          ? `unsupported Pi host ${memory.hostVersion} · required interfaces unavailable · native compaction unchanged`
          : "required Pi interfaces unavailable · native compaction unchanged";
        break;
      case "no-memory":
        description = "enabled · no Memory blocks yet";
        break;
      case "opaque":
        description = "opaque · latest compaction is not valid Context Memory · native summary retained";
        break;
      case "scale-limit":
        description = "scale limit · complete Memory sources no longer fit the model window · native compaction owns the boundary";
        break;
      case "due":
        description = "due · threshold reached · the next run authors the first Memory block";
        break;
      case "pending":
        description = "pending · Memory candidate accepted this run · compaction follows at run end";
        break;
      case "committing":
        description = "committing · writing the Memory compaction";
        break;
    }
    if (isEphemeralMemorySnapshot(memory)) {
      description += " · ephemeral session";
    }
    return [
      RAIL_CONT +
      paint(theme, "text", "memory[]") +
      "     " +
      paint(theme, "dim", description),
    ];
  }

  const lines: string[] = [];
  const budget = memory.budgetTokens !== null ? `${formatShort(memory.budgetTokens)} budget` : "budget unknown";
  const headParts = [
    paint(theme, "success", "active"),
    ` ${paint(theme, "dim", "·")} `,
    paint(theme, "text", `~${formatShort(memory.memoryTokens)} tok`),
    ` ${paint(theme, "dim", "/")} `,
    paint(theme, "muted", budget),
    ` ${paint(theme, "dim", "·")} `,
    paint(theme, "text", `${memory.blocks} ${memory.blocks === 1 ? "block" : "blocks"}`),
  ];
  if (memory.stablePrefix !== null && memory.nextOperation !== null) {
    headParts.push(
      ` ${paint(theme, "dim", "·")} `,
      paint(theme, "muted", `stable ${memory.stablePrefix}/${memory.blocks}`),
      ` ${paint(theme, "dim", "· next:")} `,
      paint(theme, "text", memory.nextOperation),
    );
  }
  if (isEphemeralMemorySnapshot(memory)) {
    headParts.push(
      ` ${paint(theme, "dim", "·")} `,
      paint(theme, "muted", "ephemeral session"),
    );
  }
  lines.push(RAIL_CONT + paint(theme, "text", "memory[]") + "     " + headParts.join(""));

  if (memory.currentTokens !== null && memory.contextWindow !== null) {
    lines.push(
      RAIL_CONT + "     " +
      paint(theme, "dim", `usage ${formatShort(memory.currentTokens)} / ${formatShort(memory.contextWindow)} window`),
    );
  }

  const previewWidth = Math.min(
    Math.max(...memory.rows.map((row) => charCount(row.preview)), 16),
    48,
  );
  for (let i = 0; i < memory.rows.length; i++) {
    const row = memory.rows[i]!;
    const indexStr = paint(theme, "dim", `${i + 1}.`);
    const previewStr = paint(theme, "text", padRight(clean(row.preview), previewWidth));
    const tokensStr = paint(theme, "syntaxNumber", `${formatShort(row.tokens)} tok`);
    const sourcesStr = paint(theme, "muted", `${row.sources} ${row.sources === 1 ? "source" : "sources"}`);
    lines.push(
      RAIL_CONT + "  " +
      indexStr + " " +
      previewStr + "  " +
      tokensStr + ` ${paint(theme, "dim", "·")} ` + sourcesStr,
    );
  }
  if (memory.rows.length < memory.blocks) {
    lines.push(
      RAIL_CONT + "  " +
      paint(theme, "dim", `⋯ +${memory.blocks - memory.rows.length} more blocks`),
    );
  }
  return lines;
}

/**
 * Parse `/context` view arguments: empty shows the overview; the read-only
 * `memory <block> [page]` form (1-based, page defaulting to 1) inspects one
 * Memory block without a model call or session write (#217).
 */
export type ContextCommand =
  | { readonly kind: "overview" }
  | { readonly kind: "memory"; readonly block: number; readonly page: number }
  | { readonly kind: "invalid" };

export function parseContextCommandArgs(args: unknown): ContextCommand {
  const text = typeof args === "string" ? args.trim() : "";
  if (text.length === 0) return { kind: "overview" };
  const parts = text.split(/\s+/);
  if (parts.length < 2 || parts.length > 3 || parts[0] !== "memory") return { kind: "invalid" };
  const block = Number(parts[1]);
  if (!Number.isInteger(block) || block < 1) return { kind: "invalid" };
  let page = 1;
  if (parts.length === 3) {
    page = Number(parts[2]);
    if (!Number.isInteger(page) || page < 1) return { kind: "invalid" };
  }
  return { kind: "memory", block, page };
}

function roleColor(role: string, inLlmContext: boolean): string {
  if (!inLlmContext) return "dim";
  if (role === "user") return "userMessageText";
  if (role === "assistant") return "success";
  if (role === "toolResult") return "toolOutput";
  if (role === "compaction") return "mdQuote";
  if (role === "custom_message") return "customMessageLabel";
  return "text";
}

function renderMessagesSection(
  theme: ThemeWrapper | null,
  collapsed: CollapsedEntries,
  totalEntries: number,
  totalChars: number,
  llmEntries: number,
  llmChars: number,
  withRows: boolean,
): string[] {
  const lines: string[] = [];
  lines.push(
    RAIL_CONT +
    paint(theme, "text", "messages[]") +
    "   " +
    paint(theme, "dim",
      `${totalEntries} entries · ${llmEntries} LLM-visible · ~${formatShort(llmChars)} chars` +
      (totalChars !== llmChars ? ` (incl. ${formatShort(totalChars - llmChars)} meta)` : ""),
    ),
  );
  if (!withRows) return lines;

  const indexWidth = String(totalEntries === 0 ? 0 : totalEntries - 1).length;
  const charsWidth = Math.max(
    ...collapsed.rows.map((r) => formatNumber(r.charCount).length),
    4,
  );
  const roleWidth = Math.max(...collapsed.rows.map((r) => r.role.length), 8);

  function rowLine(r: MessageEntrySummary): string {
    const idxStr = paint(theme, "dim", padLeft(String(r.index), indexWidth));
    const rc = roleColor(r.role, r.inLlmContext);
    const roleStr = paint(theme, rc, padRight(r.role, roleWidth));
    const charsStr = r.charCount === 0
      ? paint(theme, "dim", padLeft("-", charsWidth))
      : paint(theme, "syntaxNumber", padLeft(formatNumber(r.charCount), charsWidth));

    const tags: string[] = [];
    if (!r.inLlmContext) tags.push(paint(theme, "dim", "meta"));
    if (r.hasThinking) tags.push(paint(theme, "thinkingHigh", "thinking"));
    if (r.toolCalls.length > 0) {
      tags.push(paint(theme, "syntaxFunction", `tool(${r.toolCalls.join(",")})`));
    }
    const tagsStr = tags.length > 0 ? "  " + tags.join(paint(theme, "dim", " + ")) : "";

    let briefStr = "";
    if (r.brief) {
      const briefColor = r.inLlmContext
        ? (r.role === "user" ? "userMessageText" : r.role === "assistant" ? "success" : "syntaxString")
        : "dim";
      briefStr = "  " + paint(theme, briefColor, `"${r.brief}"`);
    }

    return RAIL_CONT + "  " + idxStr + "  " + roleStr + "  " + charsStr + tagsStr + briefStr;
  }

  for (let i = 0; i < collapsed.rows.length; i++) {
    if (i === collapsed.hiddenStart && collapsed.hiddenCount > 0) {
      lines.push(
        RAIL_CONT + "  " +
        paint(theme, "dim", `... ${collapsed.hiddenCount} more entries (${formatShort(collapsed.hiddenChars)} chars) ...`),
      );
    }
    lines.push(rowLine(collapsed.rows[i]));
  }
  return lines;
}

// ----------------------------------------------------------------------------
// Top-level renderer
// ----------------------------------------------------------------------------

export interface PromptManagerViewInput {
  tools: ToolInfoLite[];
  segments: PromptManagerSegment[];
  promptOrder: string[];
  /** Read-only Context Memory snapshot; rendered as the `memory[]` section. */
  memory: ContextMemorySnapshot;
  systemPromptChars: number;
  collapsedMessages: CollapsedEntries;
  totalMessageEntries: number;
  totalMessageChars: number;
  totalLlmEntries: number;
  totalLlmChars: number;
  messagesByRole?: ByRoleChars;
  groundTruthTokens: number | null;
  groundTruthWindow: number | null;
  currentTurn: number;
  subturn: number;
  errors: string[];
}

// ----------------------------------------------------------------------------
// Mode dispatch
// ----------------------------------------------------------------------------

export type DisplayMode = "off" | "minimal" | "summary" | "verbose";

/** Single-line summary. No side rule. Errors collapse to a count suffix. */
export function renderMinimal(input: PromptManagerViewInput, theme: ThemeWrapper | null = null): string {
  const tokens = input.groundTruthTokens;
  const win = input.groundTruthWindow;
  const tokensStr = tokens !== null
    ? `${formatShort(tokens)}/${formatShort(win ?? 0)}`
    : "?";

  const fieldSep = "  ";
  const pieces = [
    paint(theme, "accent", "prompt"),
    paint(theme, "muted", `turn ${input.currentTurn}.${input.subturn}`),
    paint(theme, "dim", "sys") + " " + paint(theme, "syntaxNumber", formatShort(input.systemPromptChars) + "c"),
    paint(theme, "dim", "msg") + " " + paint(theme, "syntaxNumber", formatShort(input.totalLlmChars) + "c"),
    paint(theme, "dim", "tok") + " " + paint(theme, "syntaxNumber", tokensStr),
    paint(theme, "dim", "phases") + " " + paint(theme, "text", String(input.segments.length)),
    paint(theme, "dim", "entries") + " " + paint(theme, "text", `${input.totalLlmEntries}/${input.totalMessageEntries}`),
  ];
  let line = pieces.join(fieldSep);
  if (input.errors.length > 0) {
    line += fieldSep + paint(theme, "error", `${input.errors.length} ERR`);
  }
  return line;
}

/** Header + Prompt Manager phase table + one-line messages overview. */
export function renderSummary(input: PromptManagerViewInput, theme: ThemeWrapper | null = null): string {
  const lines: string[] = [];
  lines.push(openPanel(theme, headerText(theme, input)));
  lines.push(...errorBody(theme, input));
  lines.push(blankInner(theme));
  lines.push(...renderSystemSection(
    theme,
    input.segments,
    input.promptOrder,
    input.currentTurn,
    input.systemPromptChars,
  ));
  lines.push(blankInner(theme));
  lines.push(...renderMessagesSection(
    theme,
    input.collapsedMessages,
    input.totalMessageEntries,
    input.totalMessageChars,
    input.totalLlmEntries,
    input.totalLlmChars,
    false,
  ));
  return lines.join("\n");
}

/** Full three-section view: tools[] + systemPrompt + messages[] with brief. */
export function renderVerbose(input: PromptManagerViewInput, theme: ThemeWrapper | null = null): string {
  const lines: string[] = [];
  lines.push(openPanel(theme, headerText(theme, input)));
  lines.push(...errorBody(theme, input));
  lines.push(blankInner(theme));
  lines.push(...renderToolsSection(theme, input.tools));
  lines.push(blankInner(theme));
  lines.push(...renderSystemSection(
    theme,
    input.segments,
    input.promptOrder,
    input.currentTurn,
    input.systemPromptChars,
  ));
  lines.push(blankInner(theme));
  lines.push(...renderMemorySection(theme, input.memory));
  lines.push(blankInner(theme));
  lines.push(...renderMessagesSection(
    theme,
    input.collapsedMessages,
    input.totalMessageEntries,
    input.totalMessageChars,
    input.totalLlmEntries,
    input.totalLlmChars,
    true,
  ));
  return lines.join("\n");
}

/** Dispatch by mode. Returns null when mode is "off" (no notify). */
export function renderByMode(
  input: PromptManagerViewInput,
  mode: DisplayMode,
  theme: ThemeWrapper | null = null,
): string | null {
  switch (mode) {
    case "off":     return null;
    case "minimal": return renderMinimal(input, theme);
    case "summary": return renderSummary(input, theme);
    case "verbose": return renderVerbose(input, theme);
  }
}

// ----------------------------------------------------------------------------
// Usage bar (for /context only)
// ----------------------------------------------------------------------------

const BAR_WIDTH = 64;
const ESTIMATE_DRIFT_THRESHOLD = 0.10;

interface UsagePart {
  key: string;
  label: string;
  color: string;
  chars: number;
}

export function renderUsageBar(input: PromptManagerViewInput, theme: ThemeWrapper | null): string {
  if (input.groundTruthTokens === null || input.groundTruthWindow === null || input.groundTruthWindow === 0) {
    return paint(theme, "warning", "context usage unavailable — no model selected or window unknown");
  }

  const used = input.groundTruthTokens;
  const win = input.groundTruthWindow;
  const usedRatio = Math.max(0, Math.min(1, used / win));
  const usedWidth = Math.max(0, Math.min(BAR_WIDTH, Math.round(BAR_WIDTH * usedRatio)));
  const freeWidth = BAR_WIDTH - usedWidth;

  const byRole: ByRoleChars = input.messagesByRole ?? { user: 0, assistant: 0, toolResult: 0 };
  const allParts: UsagePart[] = [
    { key: "tools",      label: "tools",      color: "toolTitle",        chars: totalToolsSchemaChars(input.tools) },
    { key: "system",     label: "system",     color: "accent",           chars: input.systemPromptChars },
    { key: "user",       label: "user",       color: "userMessageText",  chars: byRole.user },
    { key: "assistant",  label: "assistant",  color: "success",          chars: byRole.assistant },
    { key: "toolResult", label: "toolResult", color: "toolOutput",       chars: byRole.toolResult },
  ];
  const parts = allParts.filter((p) => p.chars > 0);
  const totalChars = parts.reduce((s, p) => s + p.chars, 0);

  const estimatedTokens = Math.round(totalChars / 4);
  const drift = used > 0 ? Math.abs(estimatedTokens - used) / used : 0;
  const driftWarn = drift > ESTIMATE_DRIFT_THRESHOLD;

  const widths = totalChars > 0
    ? parts.map((p) => Math.round(usedWidth * p.chars / totalChars))
    : parts.map(() => 0);
  const widthSum = widths.reduce((s, w) => s + w, 0);
  const widthDrift = usedWidth - widthSum;
  if (widthDrift !== 0 && widths.length > 0) {
    let maxIdx = 0;
    for (let i = 1; i < widths.length; i++) {
      if (widths[i] > widths[maxIdx]) maxIdx = i;
    }
    widths[maxIdx] = Math.max(0, widths[maxIdx] + widthDrift);
  }

  const filledGlyph = theme ? "\u2588" : "#";
  const emptyGlyph  = theme ? "\u2591" : ".";
  const swatchGlyph = theme ? "\u25A0" : "o";

  let bar = "[";
  for (let i = 0; i < parts.length; i++) {
    bar += paint(theme, parts[i].color, filledGlyph.repeat(widths[i]));
  }
  bar += paint(theme, "dim", emptyGlyph.repeat(freeWidth));
  bar += "]";

  const legendChunks: string[] = [];
  for (const p of parts) {
    const swatch = paint(theme, p.color, swatchGlyph);
    const label = paint(theme, "dim", p.label);
    const value = paint(theme, "text", `${formatNumber(p.chars)}c`);
    legendChunks.push(`${swatch} ${label} ${value}`);
  }
  if (freeWidth > 0) {
    const swatch = paint(theme, "dim", swatchGlyph);
    legendChunks.push(`${swatch} ${paint(theme, "dim", "free")}`);
  }
  const legend = " " + legendChunks.join("   ");

  const pct = (usedRatio * 100).toFixed(1);
  let header =
    `context · ${paint(theme, "text", formatNumber(used))} / ` +
    `${paint(theme, "dim", formatNumber(win))} tokens · ` +
    `${paint(theme, "accent", pct + "%")} used`;
  if (driftWarn) {
    const driftPct = (drift * 100).toFixed(0);
    header += paint(
      theme,
      "warning",
      `   (bar segment ratios may differ from actual tokens by ~${driftPct}% — chars/4 estimate)`,
    );
  }

  return [header, bar, legend].join("\n");
}
