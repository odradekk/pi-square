/**
 * Read-only `/shadow` manager view (odradekk/pi-square#149, slice #153).
 *
 * Opens a focus-preserving, non-overlay TUI view that lists every effective
 * Shadow definition with its layer provenance, marks hidden and invalid state,
 * and shows the registry diagnostics — including excluded untrusted project
 * layers. It creates no model calls, sends no messages, and writes nothing;
 * editing arrives with #154. The view follows the shared unframed operational
 * grammar: one-cell status rail, label-led rows, muted borders, no emoji.
 */

import {
  keyHint,
  type ExtensionCommandContext,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Component, Focusable, TUI } from "@earendil-works/pi-tui";
import type { EffectiveShadowDefinition, ShadowDefinitionRegistry } from "./definitions";

const LIST_WIDTH = 34;
const BODY_PREVIEW_LINES = 8;
const DIAGNOSTIC_LINES = 4;

/** Snapshot the view renders; refresh comes from the owning feature state. */
export interface ShadowManagerSnapshot {
  definitions: EffectiveShadowDefinition[];
  invalid: ShadowDefinitionRegistry["invalid"];
  diagnostics: ShadowDefinitionRegistry["diagnostics"];
  projectTrusted: boolean;
}

export function snapshot(registry: ShadowDefinitionRegistry, projectTrusted: boolean): ShadowManagerSnapshot {
  return {
    definitions: registry.definitions,
    invalid: registry.invalid,
    diagnostics: registry.diagnostics,
    projectTrusted,
  };
}

function fit(line: string, width: number): string {
  const limit = Math.max(1, width);
  // ANSI-aware bounding without pulling the display runtime into this module.
  const visible = line.replace(/\x1b\[[0-9;]*m/g, "");
  if (visible.length <= limit) return line;
  let kept = 0;
  let cut = 0;
  for (let index = 0; index < line.length && kept < limit - 1; index += 1) {
    const isEscape = line[index] === "\x1b";
    if (isEscape) {
      const end = line.indexOf("m", index);
      cut = end === -1 ? line.length : end + 1;
      index = cut - 1;
      continue;
    }
    cut = index + 1;
    kept += 1;
  }
  return `${line.slice(0, cut)}…`;
}

function clip(text: string, max: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}

export class ShadowManager implements Component, Focusable {
  private _focused = false;
  private index = 0;
  private readonly entries: (EffectiveShadowDefinition | ShadowDefinitionSnapshotEntryInvalid)[];

  constructor(
    private readonly data: ShadowManagerSnapshot,
    private readonly tui: TUI,
    private readonly theme: any,
    private readonly keybindings: KeybindingsManager,
    private readonly done: () => void,
  ) {
    this.entries = [
      ...data.definitions,
      ...data.invalid.map((entry) => ({ id: entry.id, invalid: entry })),
    ];
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
  }

  private count(): number {
    return this.entries.length;
  }

  private selected(): EffectiveShadowDefinition | ShadowDefinitionSnapshotEntryInvalid | undefined {
    return this.entries[this.index];
  }

  private move(delta: number): void {
    const count = this.count();
    if (count === 0) return;
    this.index = (this.index + delta + count) % count;
    this.tui.requestRender();
  }
  private finish(): void {
    this.done();
  }

  invalidate(): void {
    // Stateless view: nothing caches between renders.
  }

  handleInput(data: string): void {
    if (this.keybindings.matches(data, "tui.select.down")) this.move(1);
    else if (this.keybindings.matches(data, "tui.select.up")) this.move(-1);
    else if (this.keybindings.matches(data, "tui.select.cancel")) this.finish();
    else if (data === "q") this.finish();
  }

  render(terminalWidth: number): string[] {
    const width = Math.max(40, terminalWidth);
    const lines: string[] = [];
    const identity = `${this.theme.fg("accent", "●")} ${this.theme.fg("toolTitle", "Shadows")}`;
    const state = this.data.definitions.every((definition) => !definition.enabled)
      ? this.theme.fg("dim", "disabled by default")
      : this.theme.fg("dim", `${this.data.definitions.filter((definition) => definition.enabled).length} enabled`);
    lines.push(fit(`${identity}  ${state}`, width));
    lines.push(fit(this.theme.fg("dim", "DEFINITIONS"), width));
    lines.push(fit(this.theme.fg("borderMuted", "─".repeat(width)), width));

    if (this.count() === 0) {
      lines.push(fit(this.theme.fg("dim", "No Shadow definitions discovered."), width));
    }

    const detailWidth = Math.max(20, width - LIST_WIDTH - 3);
    const detail = this.renderDetail(detailWidth);
    const listLines = this.renderList(LIST_WIDTH - 2);
    const rows = Math.max(listLines.length, detail.length);
    for (let row = 0; row < rows; row += 1) {
      const left = listLines[row] ?? "";
      const pad = " ".repeat(Math.max(1, LIST_WIDTH - plainLength(left)));
      lines.push(fit(`${left}${pad}${this.theme.fg("borderMuted", "│")} ${detail[row] ?? ""}`, width));
    }

    const diagnostics = this.renderDiagnostics(width);
    if (diagnostics.length > 0) {
      lines.push(fit(this.theme.fg("borderMuted", "─".repeat(width)), width));
      lines.push(...diagnostics);
    }

    lines.push(fit(this.theme.fg("borderMuted", "─".repeat(width)), width));
    lines.push(
      fit(
        `${keyHint("tui.select.up", "↑/↓")} select · ${keyHint("tui.select.cancel", "esc")} close`,
        width,
      ),
    );
    return lines;
  }

  private renderList(width: number): string[] {
    return this.entries.map((entry, position) => {
      const marker = position === this.index
        ? this.theme.fg("accent", "›")
        : " ";
      const label = "invalid" in entry
        ? this.theme.fg("error", clip(entry.invalid.id, width - 6))
        : clip(definitionLabel(entry), width - 6);
      const badge = "invalid" in entry
        ? this.theme.fg("error", "!")
        : entry.hidden
          ? this.theme.fg("dim", "◦")
          : entry.enabled
            ? this.theme.fg("success", "●")
            : this.theme.fg("dim", "○");
      return fit(`${marker} ${badge} ${label}`, width + 8);
    });
  }

  private renderDetail(width: number): string[] {
    const selected = this.selected();
    if (!selected) return [];
    if ("invalid" in selected) {
      const entry = selected.invalid;
      const lines = [
        this.theme.fg("error", `ID: ${entry.id}`),
        this.theme.fg("dim", "STATE: invalid — excluded from activation"),
      ];
      lines.push(this.theme.fg("dim", "SOURCES:"));
      for (const source of entry.sources) lines.push(fit(this.theme.fg("muted", `  ${source}`), width));
      lines.push(this.theme.fg("dim", "ERRORS:"));
      for (const error of entry.errors.slice(0, BODY_PREVIEW_LINES)) {
        lines.push(fit(this.theme.fg("text", `  ${clip(error, width - 4)}`), width));
      }
      return lines;
    }

    const definition = selected;
    const rows: string[] = [
      this.theme.bold(this.theme.fg("text", definition.name)),
      this.theme.fg("muted", `ID: ${definition.id}`),
      this.theme.fg(
        definition.enabled ? "success" : "dim",
        `STATE: ${definition.enabled ? "enabled" : "disabled"}${definition.hidden ? " · hidden" : ""}`,
      ),
      this.theme.fg("muted", `TRIGGERS: ${definition.triggers.length > 0 ? definition.triggers.join(", ") : "manual only"}`),
      this.theme.fg("muted", `DELIVERY: ${definition.delivery}${definition.completionGate ? " · completion gate" : ""}`),
      this.theme.fg("muted", `PRIORITY: ${definition.priority}`),
      this.theme.fg("muted", `TOOLS: ${toolLabel(definition)}`),
    ];
    if (definition.model) rows.push(this.theme.fg("muted", `MODEL: ${definition.model}`));
    if (definition.thinking) rows.push(this.theme.fg("muted", `THINKING: ${definition.thinking}`));
    if (definition.timeoutSeconds !== undefined || definition.maxTurns !== undefined || definition.maxToolCalls !== undefined) {
      rows.push(this.theme.fg("muted", `LIMITS: ${definition.timeoutSeconds ?? "default"}s · ${definition.maxTurns ?? "default"} turns · ${definition.maxToolCalls ?? "default"} tool calls`));
    }
    const instructionKeys = Object.keys(definition.triggerInstructions);
    if (instructionKeys.length > 0) {
      rows.push(this.theme.fg("dim", "TRIGGER INSTRUCTIONS:"));
      for (const key of instructionKeys) {
        rows.push(fit(this.theme.fg("muted", `  ${key}: ${clip(definition.triggerInstructions[key as keyof typeof definition.triggerInstructions] ?? "", width - 8)}`), width));
      }
    }
    rows.push(this.theme.fg("dim", "LAYERS:"));
    for (const layer of definition.layers) {
      rows.push(fit(this.theme.fg("muted", `  ${layer.scope}: ${layer.filePath}`), width));
    }
    rows.push(this.theme.fg("dim", "BODY:"));
    const bodyLines = definition.body.replace(/\r/g, "").split("\n").filter((line) => line.trim() !== "").slice(0, BODY_PREVIEW_LINES);
    for (const line of bodyLines) rows.push(fit(this.theme.fg("text", `  ${line}`), width));
    return rows;
  }

  private renderDiagnostics(width: number): string[] {
    const lines: string[] = [];
    if (!this.data.projectTrusted) {
      lines.push(fit(this.theme.fg("dim", `project layer: untrusted — project Shadow definitions are excluded`), width));
    }
    for (const diagnostic of this.data.diagnostics.slice(0, DIAGNOSTIC_LINES)) {
      lines.push(fit(this.theme.fg("warning", clip(diagnostic.message, width)), width));
    }
    const hidden = this.data.diagnostics.length - DIAGNOSTIC_LINES;
    if (hidden > 0) lines.push(fit(this.theme.fg("dim", `(+${hidden} more diagnostics)`), width));
    return lines;
  }
}

interface ShadowDefinitionSnapshotEntryInvalid {
  id: string;
  invalid: ShadowDefinitionRegistry["invalid"][number];
}

function definitionLabel(definition: EffectiveShadowDefinition): string {
  return `${definition.name} (${definition.id})`;
}

function toolLabel(definition: EffectiveShadowDefinition): string {
  if (definition.tools === undefined) return "default local read-only set";
  if (definition.tools.length === 0) return "none (trajectory only)";
  return definition.tools.join(", ");
}

function plainLength(line: string): number {
  return line.replace(/\x1b\[[0-9;]*m/g, "").length;
}

export async function openShadowManager(
  ctx: ExtensionCommandContext,
  data: ShadowManagerSnapshot,
): Promise<void> {
  await ctx.ui.custom<void>((tui, theme, keybindings, done) => (
    new ShadowManager(data, tui, theme, keybindings, done)
  ), { overlay: false });
}
