import {
  getSelectListTheme,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Editor,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
  type TUI,
} from "@earendil-works/pi-tui";
import { loadConfig, type PiSquareConfig } from "../core/config";
import {
  readDisplayConfigSnapshot,
  writeDisplayConfig,
  type DisplayConfigSnapshot,
  type DisplayConfigWriteScope,
} from "../core/config-write";
import { emitDiagnostics } from "../core/diagnostics";
import type { DisplayController } from "./index";
import { DISPLAY_CATALOG, type DisplayToolCatalogEntry } from "./catalog";
import { OperationalDisplayComponent } from "./components";
import { resolveDisplayPolicyForTool } from "./policy";
import { sanitizeDisplayLine } from "./sanitize";
import {
  DISPLAY_DIFF_COLLAPSED_LINES_MAX,
  DISPLAY_DIFF_COLLAPSED_LINES_MIN,
  DISPLAY_DIFF_SPLIT_MIN_WIDTH_MAX,
  DISPLAY_DIFF_SPLIT_MIN_WIDTH_MIN,
  DISPLAY_EXPANDED_MAX_LINES_MAX,
  DISPLAY_EXPANDED_MAX_LINES_MIN,
  DISPLAY_FAMILIES,
  DISPLAY_POLICY_FIELDS,
  DISPLAY_PREVIEW_LINES_MAX,
  DISPLAY_PREVIEW_LINES_MIN,
  type DisplayDescriptionV1,
  type DisplayFamily,
  type DisplayLayerConfig,
  type DisplayPolicyField,
  type DisplayPolicyOverlay,
} from "./types";

interface GlobalNode {
  readonly kind: "global";
  readonly name: "defaults";
  readonly label: "Global defaults";
}
interface FamilyNode {
  readonly kind: "family";
  readonly name: DisplayFamily;
  readonly label: string;
}
interface ToolNode {
  readonly kind: "tool";
  readonly name: string;
  readonly label: string;
  readonly entry: DisplayToolCatalogEntry;
}
type DisplayNode = GlobalNode | FamilyNode | ToolNode;

type ManagerView =
  | { kind: "browse" }
  | { kind: "choice"; title: string; items: readonly { label: string; action: () => void }[]; index: number }
  | { kind: "editor"; title: string; editor: Editor; error?: string; onSubmit: (value: string) => void }
  | { kind: "review"; lines: readonly string[]; scroll: number; saving: boolean };

export interface DisplayManagerServices {
  readonly trustedProject: boolean;
  currentConfig(): PiSquareConfig;
  diagnostics?(): readonly string[];
  refresh(scope: DisplayConfigWriteScope): Promise<DisplayConfigSnapshot>;
  save(
    scope: DisplayConfigWriteScope,
    snapshot: DisplayConfigSnapshot,
    display: DisplayLayerConfig,
    removeFooterMode: boolean,
  ): Promise<DisplayConfigSnapshot>;
}

const FIELD_OPTIONS: Readonly<Record<DisplayPolicyField, readonly unknown[] | undefined>> = Object.freeze({
  resultMode: ["hidden", "summary", "preview"],
  previewLines: undefined,
  expandedMaxLines: undefined,
  showMetadata: [true, false],
  showDuration: [true, false],
  wordWrap: [true, false],
  diffView: ["auto", "split", "unified"],
  diffSplitMinWidth: undefined,
  diffCollapsedLines: undefined,
  diffIndicators: ["bars", "classic", "none"],
});
const PREVIEW_WIDTHS = [40, 80, 120] as const;

function cleanDisplayValue(value: unknown): string {
  return sanitizeDisplayLine(value).replace(/\\[nrt]/g, " ").replace(/\s+/g, " ").trim();
}

function panelWidth(terminalWidth: number): number {
  const width = Math.max(1, terminalWidth);
  if (width <= 72) return width;
  return Math.min(110, Math.max(80, Math.floor(width * 0.9)));
}

function fit(text: string, width: number): string {
  return truncateToWidth(text, Math.max(1, width), "...");
}

function pad(text: string, width: number): string {
  const fitted = fit(text, width);
  return fitted + " ".repeat(Math.max(0, width - visibleWidth(fitted)));
}

function cloneLayer(value: DisplayLayerConfig): DisplayLayerConfig {
  return structuredClone(value);
}

function mutableLayer(value: DisplayLayerConfig): {
  motion?: "full" | "reduced" | "off";
  defaults?: DisplayPolicyOverlay;
  families?: Partial<Record<DisplayFamily, DisplayPolicyOverlay>>;
  tools?: Record<string, DisplayPolicyOverlay>;
} {
  return value as ReturnType<typeof mutableLayer>;
}

function allNodes(): DisplayNode[] {
  return [
    { kind: "global", name: "defaults", label: "Global defaults" },
    ...DISPLAY_FAMILIES.map((family): FamilyNode => ({
      kind: "family",
      name: family,
      label: `${family[0]!.toUpperCase()}${family.slice(1)} family`,
    })),
    ...DISPLAY_CATALOG.map((entry): ToolNode => ({
      kind: "tool",
      name: entry.name,
      label: entry.name,
      entry,
    })),
  ];
}

function overlayFor(layer: DisplayLayerConfig, node: DisplayNode, create: boolean): DisplayPolicyOverlay | undefined {
  const mutable = mutableLayer(layer);
  if (node.kind === "global") {
    if (create) mutable.defaults ??= {};
    return mutable.defaults;
  }
  if (node.kind === "family") {
    if (create) mutable.families ??= {};
    if (create) mutable.families![node.name] ??= {};
    return mutable.families?.[node.name];
  }
  if (create) mutable.tools ??= {};
  if (create) mutable.tools![node.name] ??= {};
  return mutable.tools?.[node.name];
}

function cleanEmptyLayer(layer: DisplayLayerConfig): void {
  const mutable = mutableLayer(layer);
  if (mutable.defaults && Object.keys(mutable.defaults).length === 0) delete mutable.defaults;
  if (mutable.families) {
    for (const family of DISPLAY_FAMILIES) {
      if (mutable.families[family] && Object.keys(mutable.families[family]!).length === 0) delete mutable.families[family];
    }
    if (Object.keys(mutable.families).length === 0) delete mutable.families;
  }
  if (mutable.tools) {
    for (const name of Object.keys(mutable.tools)) {
      if (Object.keys(mutable.tools[name]!).length === 0) delete mutable.tools[name];
    }
    if (Object.keys(mutable.tools).length === 0) delete mutable.tools;
  }
}

function resetNode(layer: DisplayLayerConfig, node: DisplayNode): void {
  const mutable = mutableLayer(layer);
  if (node.kind === "global") {
    delete mutable.defaults;
    delete mutable.motion;
  } else if (node.kind === "family") {
    if (mutable.families) delete mutable.families[node.name];
  } else if (mutable.tools) delete mutable.tools[node.name];
  cleanEmptyLayer(layer);
}

function configWithStage(
  config: PiSquareConfig,
  scope: DisplayConfigWriteScope,
  snapshot: DisplayConfigSnapshot,
  staged: DisplayLayerConfig,
  node: DisplayNode,
): PiSquareConfig {
  const source = { path: snapshot.path, config: cloneLayer(staged) };
  let agent = scope === "agent" ? source : config.display.agent ? structuredClone(config.display.agent) : undefined;
  let project = scope === "project" ? source : config.display.project ? structuredClone(config.display.project) : undefined;

  const prune = (candidate: typeof agent): typeof agent => {
    if (!candidate) return undefined;
    if (node.kind === "global") {
      return { path: candidate.path, config: { ...candidate.config, families: undefined, tools: undefined } };
    }
    if (node.kind === "family") {
      return {
        path: candidate.path,
        config: {
          ...candidate.config,
          families: candidate.config.families?.[node.name]
            ? { [node.name]: candidate.config.families[node.name] }
            : undefined,
          tools: undefined,
        },
      };
    }
    return candidate;
  };
  agent = prune(agent);
  project = prune(project);
  return {
    ...structuredClone(config),
    display: {
      motion: project?.config.motion ?? agent?.config.motion ?? "full",
      ...(agent ? { agent } : {}),
      ...(project ? { project } : {}),
    },
  };
}

function nodeIdentity(node: DisplayNode): { tool: string; family: DisplayFamily } {
  if (node.kind === "tool") return { tool: node.name, family: node.entry.family };
  if (node.kind === "family") return { tool: `preview:${node.name}`, family: node.name };
  return { tool: "preview:defaults", family: "workflow" };
}

function valueText(value: unknown): string {
  if (value === undefined) return "inherit";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function parseFieldValue(field: DisplayPolicyField, text: string): unknown {
  const trimmed = text.trim();
  if (trimmed === "" || trimmed === "null" || trimmed === "inherit") return undefined;
  const options = FIELD_OPTIONS[field];
  if (options) {
    const parsed = trimmed === "true" ? true : trimmed === "false" ? false : trimmed;
    if (!options.includes(parsed)) throw new Error(`expected one of: ${options.join(", ")}, or inherit`);
    return parsed;
  }
  const number = Number(trimmed);
  if (!Number.isInteger(number)) throw new Error("expected an integer or inherit");
  const ranges: Partial<Record<DisplayPolicyField, readonly [number, number]>> = {
    previewLines: [DISPLAY_PREVIEW_LINES_MIN, DISPLAY_PREVIEW_LINES_MAX],
    expandedMaxLines: [DISPLAY_EXPANDED_MAX_LINES_MIN, DISPLAY_EXPANDED_MAX_LINES_MAX],
    diffSplitMinWidth: [DISPLAY_DIFF_SPLIT_MIN_WIDTH_MIN, DISPLAY_DIFF_SPLIT_MIN_WIDTH_MAX],
    diffCollapsedLines: [DISPLAY_DIFF_COLLAPSED_LINES_MIN, DISPLAY_DIFF_COLLAPSED_LINES_MAX],
  };
  const range = ranges[field]!;
  if (number < range[0] || number > range[1]) throw new Error(`expected ${range[0]}-${range[1]}`);
  return number;
}

function previewDescription(identity: { tool: string; family: DisplayFamily }): DisplayDescriptionV1 {
  return {
    version: 1,
    tool: identity.tool,
    family: identity.family,
    status: "success",
    title: identity.tool.startsWith("preview:") ? "Display preview" : identity.tool,
    target: "src/example.ts",
    durationMs: 1_240,
    metadata: [{ label: "scope", value: "effective" }, { label: "items", value: "12" }],
    rows: [{ text: "12 results across 4 files" }],
    preview: { text: "first preview line\nsecond preview line\nthird preview line", omittedLines: 3 },
  };
}

export class DisplayManager implements Component, Focusable {
  focused = false;
  private scope: DisplayConfigWriteScope = "agent";
  private selected = 0;
  private query = "";
  private view: ManagerView = { kind: "browse" };
  private previousView: ManagerView | undefined;
  private readonly staged = new Map<DisplayConfigWriteScope, DisplayLayerConfig>();
  private previewWidthIndex = 1;
  private previewThemeIndex = 0;
  private flash: { kind: "success" | "error"; text: string } | undefined;
  private finished = false;

  constructor(
    private config: PiSquareConfig,
    private readonly snapshots: Map<DisplayConfigWriteScope, DisplayConfigSnapshot>,
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    private readonly done: () => void,
    private readonly services: DisplayManagerServices,
    private readonly previewThemes: readonly { name: string; theme: Theme }[],
  ) {
    for (const [scope, snapshot] of snapshots) this.staged.set(scope, cloneLayer(snapshot.display));
  }

  private nodes(): DisplayNode[] {
    const query = this.query.toLowerCase();
    return allNodes().filter((node) => !query || `${node.label} ${node.kind}`.toLowerCase().includes(query));
  }

  private node(): DisplayNode {
    const nodes = this.nodes();
    this.selected = Math.min(this.selected, Math.max(0, nodes.length - 1));
    return nodes[this.selected] ?? { kind: "global", name: "defaults", label: "Global defaults" };
  }

  private currentLayer(): DisplayLayerConfig {
    return this.staged.get(this.scope) ?? {};
  }

  private effective(node = this.node()) {
    const snapshot = this.snapshots.get(this.scope)!;
    const stagedConfig = configWithStage(this.config, this.scope, snapshot, this.currentLayer(), node);
    const identity = nodeIdentity(node);
    return {
      identity,
      effective: resolveDisplayPolicyForTool(identity.tool, identity.family, stagedConfig.display),
      motion: stagedConfig.display.motion,
    };
  }

  private requestRender(): void {
    this.tui.requestRender();
  }

  private close(): void {
    this.finished = true;
    this.done();
  }

  private back(): void {
    if (this.view.kind === "browse") return this.close();
    this.view = this.previousView ?? { kind: "browse" };
    this.previousView = undefined;
    this.requestRender();
  }

  private push(view: ManagerView): void {
    this.previousView = this.view;
    this.view = view;
    this.requestRender();
  }

  private openEditor(title: string, initial: string, onSubmit: (value: string) => void): void {
    const editor = new Editor(this.tui, {
      borderColor: (text) => this.theme.fg("border", text),
      selectList: getSelectListTheme(),
    }, { paddingX: 0, autocompleteMaxVisible: 0 });
    editor.setText(initial);
    const view: ManagerView = { kind: "editor", title, editor, onSubmit };
    editor.onChange = () => {
      if (view.kind === "editor") view.error = undefined;
      this.requestRender();
    };
    editor.onSubmit = (value) => {
      try {
        onSubmit(value);
      } catch (error) {
        if (view.kind === "editor") view.error = cleanDisplayValue(error instanceof Error ? error.message : error);
        this.requestRender();
      }
    };
    this.push(view);
  }

  private openFieldChoice(): void {
    const node = this.node();
    const fields = node.kind === "global" ? ["motion", ...DISPLAY_POLICY_FIELDS] : [...DISPLAY_POLICY_FIELDS];
    this.push({
      kind: "choice",
      title: `Edit ${node.label}`,
      index: 0,
      items: fields.map((field) => ({
        label: field,
        action: () => this.editField(field as DisplayPolicyField | "motion"),
      })),
    });
  }

  private editField(field: DisplayPolicyField | "motion"): void {
    const node = this.node();
    const layer = this.currentLayer();
    const current = field === "motion" ? layer.motion : overlayFor(layer, node, false)?.[field];
    const values = field === "motion" ? ["full", "reduced", "off", undefined] : FIELD_OPTIONS[field];
    const set = (value: unknown) => {
      const mutable = mutableLayer(layer);
      if (field === "motion") {
        if (value === undefined) delete mutable.motion;
        else mutable.motion = value as "full" | "reduced" | "off";
      } else {
        const overlay = overlayFor(layer, node, true)! as Record<string, unknown>;
        if (value === undefined) delete overlay[field];
        else overlay[field] = value;
      }
      cleanEmptyLayer(layer);
      this.view = { kind: "browse" };
      this.previousView = undefined;
      this.flash = { kind: "success", text: `${field} staged` };
      this.requestRender();
    };
    if (values) {
      this.push({
        kind: "choice",
        title: `${node.label} / ${field}`,
        index: Math.max(0, values.findIndex((value) => value === current)),
        items: values.map((value) => ({ label: value === undefined ? "inherit / reset" : String(value), action: () => set(value) })),
      });
      return;
    }
    this.openEditor(`${node.label} / ${field}`, valueText(current), (value) => set(parseFieldValue(field as DisplayPolicyField, value)));
  }

  private toggleScope(): void {
    const next = this.scope === "agent" ? "project" : "agent";
    if (next === "project" && !this.services.trustedProject) {
      this.flash = { kind: "error", text: "Project display config requires a trusted project" };
      return this.requestRender();
    }
    if (!this.snapshots.has(next)) {
      this.flash = { kind: "error", text: `${next} config snapshot is unavailable` };
      return this.requestRender();
    }
    this.scope = next;
    this.selected = 0;
    this.flash = { kind: "success", text: `Editing ${next} scope` };
    this.requestRender();
  }

  private openSearch(): void {
    this.openEditor("Search display nodes", this.query, (value) => {
      this.query = sanitizeDisplayLine(value).trim();
      this.selected = 0;
      this.view = { kind: "browse" };
      this.previousView = undefined;
      this.requestRender();
    });
  }

  private reviewLines(snapshot: DisplayConfigSnapshot): string[] {
    return [
      `Scope: ${this.scope}`,
      `Path: ${cleanDisplayValue(snapshot.path)}`,
      `Remove deprecated footer.mode: ${snapshot.footerModePresent ? "yes" : "not present"}`,
      "",
      "CURRENT DISPLAY",
      JSON.stringify(snapshot.display, null, 2),
      "",
      "STAGED DISPLAY",
      JSON.stringify(this.currentLayer(), null, 2),
    ];
  }

  private openReview(): void {
    const snapshot = this.snapshots.get(this.scope)!;
    this.push({ kind: "review", lines: this.reviewLines(snapshot), scroll: 0, saving: false });
  }

  private async saveReview(): Promise<void> {
    if (this.view.kind !== "review" || this.view.saving) return;
    this.view.saving = true;
    this.requestRender();
    const scope = this.scope;
    const snapshot = this.snapshots.get(scope)!;
    try {
      const next = await this.services.save(scope, snapshot, this.currentLayer(), snapshot.footerModePresent);
      this.snapshots.set(scope, next);
      this.staged.set(scope, cloneLayer(next.display));
      this.config = structuredClone(this.services.currentConfig());
      this.view = { kind: "browse" };
      this.previousView = undefined;
      this.flash = { kind: "success", text: `Saved ${scope} display configuration` };
    } catch (error) {
      const stale = error && typeof error === "object" && (error as { code?: unknown }).code === "DISPLAY_STALE_REVIEW";
      let message = error instanceof Error ? error.message : String(error);
      if (stale) {
        try {
          const latest = await this.services.refresh(scope);
          this.snapshots.set(scope, latest);
          this.view = { kind: "review", lines: this.reviewLines(latest), scroll: 0, saving: false };
          message = "Config changed since review; current file refreshed and staged changes retained for review";
        } catch (refreshError) {
          message = `Config changed since review, and refresh failed: ${refreshError instanceof Error ? refreshError.message : String(refreshError)}`;
        }
      }
      this.flash = { kind: "error", text: message };
      if (this.view.kind === "review") this.view.saving = false;
    }
    this.requestRender();
  }

  private renderBrowse(width: number, rows: number): string[] {
    const nodes = this.nodes();
    const selected = this.selected;
    const listBudget = Math.max(4, Math.min(nodes.length, rows - 9));
    const start = Math.max(0, Math.min(selected - Math.floor(listBudget / 2), Math.max(0, nodes.length - listBudget)));
    const list = nodes.slice(start, start + listBudget).map((node, offset) => {
      const index = start + offset;
      const marker = index === selected ? this.theme.fg("accent", ">") : " ";
      const kind = this.theme.fg("dim", node.kind.padEnd(6));
      return fit(`${marker} ${kind} ${this.theme.fg("text", node.label)}`, width);
    });
    if (nodes.length === 0) list.push(this.theme.fg("warning", "No display nodes match the search"));

    const node = this.node();
    const effective = this.effective(node);
    const detail = [
      this.theme.fg("muted", `${node.label} · ${this.scope} scope`),
      `motion=${effective.motion}`,
      ...DISPLAY_POLICY_FIELDS.map((field) => (
        `${field}=${valueText(effective.effective.policy[field])}  [${cleanDisplayValue(effective.effective.provenance[field])}]`
      )),
    ];
    const selectedTheme = this.previewThemes[this.previewThemeIndex] ?? { name: "current", theme: this.theme };
    const preview = new OperationalDisplayComponent(
      previewDescription(effective.identity),
      effective.effective.policy,
      selectedTheme.theme,
      { expanded: false },
    ).render(Math.min(width, PREVIEW_WIDTHS[this.previewWidthIndex]));
    const previewHeader = this.theme.fg("muted", `PREVIEW ${PREVIEW_WIDTHS[this.previewWidthIndex]} · ${selectedTheme.name}`);

    if (width >= 88) {
      const leftWidth = Math.min(38, Math.floor(width * 0.38));
      const rightWidth = width - leftWidth - 3;
      const right = [...detail.flatMap((line) => wrapTextWithAnsi(line, rightWidth)), "", previewHeader, ...preview]
        .slice(0, Math.max(list.length, rows - 5));
      const output: string[] = [];
      const count = Math.max(list.length, right.length);
      for (let index = 0; index < count; index += 1) {
        const left = pad(list[index] ?? "", leftWidth);
        output.push(fit(`${left} ${this.theme.fg("borderMuted", "│")} ${right[index] ?? ""}`, width));
      }
      return output;
    }
    return [
      ...list,
      this.theme.fg("borderMuted", "─".repeat(width)),
      ...detail.slice(0, 4).map((line) => fit(line, width)),
      fit(previewHeader, width),
      ...preview.slice(0, 3).map((line) => fit(line, width)),
    ].slice(0, rows - 4);
  }

  render(terminalWidth: number): string[] {
    const width = panelWidth(terminalWidth);
    const maxRows = Math.max(1, Math.min(30, Math.floor(this.tui.terminal.rows)));
    const diagnostic = this.services.diagnostics?.()[0];
    const header = [
      fit(`${this.theme.fg("accent", "◆")} ${this.theme.fg("toolTitle", this.theme.bold("DISPLAY"))}  ${this.theme.fg("dim", `${this.scope.toUpperCase()} · ${this.query ? `filter=${this.query}` : "all nodes"}`)}`, width),
      ...(diagnostic ? [fit(`${this.theme.fg("warning", "!")} ${this.theme.fg("warning", cleanDisplayValue(diagnostic))}`, width)] : []),
      this.theme.fg("borderMuted", "─".repeat(width)),
    ];
    let body: string[];
    if (this.view.kind === "browse") body = this.renderBrowse(width, maxRows - 5);
    else if (this.view.kind === "choice") {
      const view = this.view;
      body = [this.theme.fg("text", this.theme.bold(view.title)), "", ...view.items.map((item, index) => (
        `${index === view.index ? this.theme.fg("accent", ">") : " "} ${item.label}`
      ))];
    } else if (this.view.kind === "editor") {
      this.view.editor.focused = this.focused;
      body = [this.theme.fg("text", this.theme.bold(this.view.title)), "", ...this.view.editor.render(width)];
      if (this.view.error) body.push(this.theme.fg("error", this.view.error));
    } else {
      const budget = maxRows - 7;
      const lines = this.view.lines.flatMap((line) => wrapTextWithAnsi(line || " ", width));
      const maximumScroll = Math.max(0, lines.length - budget);
      this.view.scroll = Math.min(this.view.scroll, maximumScroll);
      body = [
        this.theme.fg("text", this.theme.bold(this.view.saving ? "Saving display config" : "Review display config")),
        "",
        ...lines.slice(this.view.scroll, this.view.scroll + budget),
      ];
    }
    const footer: string[] = [];
    if (this.flash) footer.push(this.theme.fg(this.flash.kind === "error" ? "error" : "success", cleanDisplayValue(this.flash.text)));
    footer.push(this.theme.fg("borderMuted", "─".repeat(width)));
    footer.push(this.theme.fg("dim", this.view.kind === "browse"
      ? "enter edit · / search · p scope · r reset · w review · t width · v theme · esc close"
      : this.view.kind === "review"
        ? "enter save · up/down scroll · esc back"
        : "enter choose/submit · esc back"));
    const bodyBudget = Math.max(0, maxRows - header.length - footer.length);
    const rendered = [...header, ...body.slice(0, bodyBudget), ...footer]
      .map((line) => fit(line, width));
    return rendered.slice(0, maxRows);
  }

  handleInput(data: string): void {
    if (this.finished) return;
    if (this.view.kind === "editor") {
      if (this.keybindings.matches(data, "tui.select.cancel")) this.back();
      else this.view.editor.handleInput(data);
      this.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.cancel")) return this.back();
    if (this.view.kind === "choice") {
      if (this.keybindings.matches(data, "tui.select.up")) this.view.index = (this.view.index - 1 + this.view.items.length) % this.view.items.length;
      else if (this.keybindings.matches(data, "tui.select.down")) this.view.index = (this.view.index + 1) % this.view.items.length;
      else if (this.keybindings.matches(data, "tui.select.confirm")) this.view.items[this.view.index]?.action();
      return this.requestRender();
    }
    if (this.view.kind === "review") {
      if (this.keybindings.matches(data, "tui.select.up")) this.view.scroll = Math.max(0, this.view.scroll - 1);
      else if (this.keybindings.matches(data, "tui.select.down")) this.view.scroll += 1;
      else if (this.keybindings.matches(data, "tui.select.confirm")) void this.saveReview();
      return this.requestRender();
    }
    if (this.keybindings.matches(data, "tui.select.up")) this.selected = Math.max(0, this.selected - 1);
    else if (this.keybindings.matches(data, "tui.select.down")) this.selected = Math.min(this.nodes().length - 1, this.selected + 1);
    else if (this.keybindings.matches(data, "tui.select.confirm")) return this.openFieldChoice();
    else if (matchesKey(data, "/")) return this.openSearch();
    else if (matchesKey(data, "p")) return this.toggleScope();
    else if (matchesKey(data, "r")) {
      resetNode(this.currentLayer(), this.node());
      this.flash = { kind: "success", text: `${this.node().label} reset in staged config` };
    } else if (matchesKey(data, "w")) return this.openReview();
    else if (matchesKey(data, "t")) this.previewWidthIndex = (this.previewWidthIndex + 1) % PREVIEW_WIDTHS.length;
    else if (matchesKey(data, "v")) this.previewThemeIndex = (this.previewThemeIndex + 1) % this.previewThemes.length;
    this.requestRender();
  }

  invalidate(): void {
    if (this.view.kind === "editor") this.view.editor.invalidate();
  }

  dispose(): void {}
}

function productionServices(
  controller: DisplayController,
  ctx: ExtensionCommandContext,
): DisplayManagerServices {
  return {
    trustedProject: ctx.isProjectTrusted(),
    currentConfig: () => controller.config,
    diagnostics: () => controller.diagnostics,
    refresh: (scope) => readDisplayConfigSnapshot(scope, {
      cwd: ctx.cwd,
      isProjectTrusted: ctx.isProjectTrusted(),
    }),
    async save(scope, snapshot, display, removeFooterMode) {
      await writeDisplayConfig(
        { fingerprint: snapshot.fingerprint, display, removeFooterMode },
        { cwd: ctx.cwd, isProjectTrusted: ctx.isProjectTrusted() },
        scope,
      );
      const loaded = loadConfig(ctx.cwd);
      controller.applyConfig(loaded.config, ctx);
      emitDiagnostics(ctx, loaded.diagnostics);
      return readDisplayConfigSnapshot(scope, {
        cwd: ctx.cwd,
        isProjectTrusted: ctx.isProjectTrusted(),
      });
    },
  };
}

async function openDisplayManager(
  controller: DisplayController,
  ctx: ExtensionCommandContext,
): Promise<void> {
  if (!ctx.hasUI) return;
  const context = { cwd: ctx.cwd, isProjectTrusted: ctx.isProjectTrusted() };
  let agent: DisplayConfigSnapshot;
  try {
    agent = await readDisplayConfigSnapshot("agent", context);
  } catch (error) {
    ctx.ui.notify(cleanDisplayValue(error instanceof Error ? error.message : error), "error");
    return;
  }
  const snapshots = new Map<DisplayConfigWriteScope, DisplayConfigSnapshot>([["agent", agent]]);
  if (context.isProjectTrusted) {
    try {
      snapshots.set("project", await readDisplayConfigSnapshot("project", context));
    } catch (error) {
      ctx.ui.notify(cleanDisplayValue(error instanceof Error ? error.message : error), "error");
    }
  }
  const previewThemes = [
    { name: "current", theme: ctx.ui.theme },
    ...(ctx.ui.getTheme("pi-square-theme-dark") ? [{ name: "dark", theme: ctx.ui.getTheme("pi-square-theme-dark")! }] : []),
    ...(ctx.ui.getTheme("pi-square-theme-light") ? [{ name: "light", theme: ctx.ui.getTheme("pi-square-theme-light")! }] : []),
  ];
  await ctx.ui.custom<void>((tui, theme, keybindings, done) => new DisplayManager(
    controller.config,
    snapshots,
    tui,
    theme,
    keybindings,
    done,
    productionServices(controller, ctx),
    previewThemes,
  ), { overlay: false });
}

export function registerDisplayManager(pi: ExtensionAPI, controller: DisplayController): void {
  pi.registerCommand("display", {
    description: "Configure pi-square display policies and preview the effective operational-console layout.",
    handler: async (_args, ctx) => openDisplayManager(controller, ctx),
  });
}

export const __testables = {
  panelWidth,
  allNodes,
  resetNode,
  parseFieldValue,
  configWithStage,
};
