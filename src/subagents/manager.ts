import type { ExtensionAPI, ExtensionCommandContext, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  type Component,
  type Focusable,
  type TUI,
  truncateToWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
  createSubagentId,
  deleteParentSessionRun,
  listParentSessionRuns,
} from "./artifacts";
import {
  cancelBackgroundJobs,
  createQueuedJob,
  createQueuedResumeJob,
  listBackgroundJobs,
  startBackgroundJob,
  startBackgroundResumeJob,
} from "./background";
import {
  deleteDefinitionOverlay,
  previewDefinitionPatch,
  type SubagentDefinition,
  type SubagentDefinitionField,
  type SubagentDefinitionPatch,
  type SubagentRegistry,
  writeDefinitionPatch,
} from "./definitions";
import { compileFreshPrompt, promptDefinitionHash } from "./prompt";
import { sanitizeSubagentDisplay } from "./render";
import type { SubagentRuntimeState } from "./tool";
import type { BackgroundJobSnapshot, SubagentRunDetails } from "./types";

type ManagerTab = "running" | "session" | "definitions";
type ManagerAction =
  | { kind: "close" }
  | { kind: "cancel"; id: string }
  | { kind: "resume"; id: string }
  | { kind: "fresh"; id: string }
  | { kind: "delete-history"; id: string }
  | { kind: "create-definition" }
  | { kind: "edit-definition"; name: string }
  | { kind: "toggle-definition"; name: string }
  | { kind: "delete-definition"; name: string };

interface ManagerSnapshot {
  running: BackgroundJobSnapshot[];
  session: SubagentRunDetails[];
  definitions: SubagentDefinition[];
  errors: string[];
}

const TABS: ManagerTab[] = ["running", "session", "definitions"];
const EDITABLE_FIELDS: SubagentDefinitionField[] = [
  "description",
  "model",
  "effort",
  "policy",
  "instructions",
  "output",
  "inheritParentSystem",
  "tools",
  "extensionTools",
  "skills",
  "visible",
];
const MULTILINE_FIELDS = new Set<SubagentDefinitionField>(["description", "policy", "instructions", "output"]);
const ARRAY_FIELDS = new Set<SubagentDefinitionField>(["tools", "extensionTools", "skills"]);
const BOOLEAN_FIELDS = new Set<SubagentDefinitionField>(["inheritParentSystem", "visible"]);

function fit(line: string, width: number): string {
  return truncateToWidth(line, Math.max(1, width), "…", true);
}

function wrap(value: string, width: number): string[] {
  return value.split("\n").flatMap((line) => wrapTextWithAnsi(line || " ", Math.max(1, width)));
}

function shortId(id: string): string {
  return id.replace(/^subagent_/, "").slice(0, 8);
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  return `${Math.floor(ms / 60_000)}m`;
}

function latestToolCall(details: SubagentRunDetails): string {
  const item = [...details.timeline].reverse().find((entry) => entry.kind === "tool" && entry.phase === "start");
  return item ? sanitizeSubagentDisplay(item.text).replace(/\s+/g, " ").trim() : "working";
}

function definitionValue(definition: SubagentDefinition, field: SubagentDefinitionField): unknown {
  return definition[field];
}

function displayValue(value: unknown): string {
  if (value === undefined) return "(default)";
  if (value === null) return "null";
  if (Array.isArray(value)) return value.length > 0 ? value.join(", ") : "[]";
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim() || "(empty)";
  return String(value);
}

function activeJobs(state: SubagentRuntimeState): BackgroundJobSnapshot[] {
  return listBackgroundJobs(state.background).filter((job) => (
    job.status === "queued" || job.status === "running" || job.status === "cancelling"
  ));
}

function snapshot(state: SubagentRuntimeState, parentSessionId: string): ManagerSnapshot {
  return {
    running: activeJobs(state),
    session: listParentSessionRuns(parentSessionId),
    definitions: [...state.registry.definitions].sort((a, b) => a.name.localeCompare(b.name)),
    errors: [...state.registry.errors],
  };
}

class SubagentManager implements Component, Focusable {
  private tabIndex = 0;
  private indices: Record<ManagerTab, number> = { running: 0, session: 0, definitions: 0 };
  private _focused = false;
  private finished = false;

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
  }

  constructor(
    private readonly data: ManagerSnapshot,
    private readonly tui: TUI,
    private readonly theme: any,
    private readonly keybindings: KeybindingsManager,
    private readonly done: (action: ManagerAction) => void,
  ) {}

  private tab(): ManagerTab {
    return TABS[this.tabIndex] ?? "running";
  }

  private count(tab = this.tab()): number {
    if (tab === "running") return this.data.running.length;
    if (tab === "session") return this.data.session.length;
    return this.data.definitions.length;
  }

  private selectedIndex(): number {
    const tab = this.tab();
    const count = this.count(tab);
    if (count === 0) return 0;
    return Math.max(0, Math.min(count - 1, this.indices[tab]));
  }

  private move(delta: number): void {
    const tab = this.tab();
    const count = this.count(tab);
    if (count > 0) this.indices[tab] = (this.selectedIndex() + delta + count) % count;
    this.tui.requestRender();
  }

  private switchTab(delta: number): void {
    this.tabIndex = (this.tabIndex + delta + TABS.length) % TABS.length;
    this.tui.requestRender();
  }

  private finish(action: ManagerAction): void {
    if (this.finished) return;
    this.finished = true;
    this.done(action);
  }

  private selectedRun(): SubagentRunDetails | undefined {
    return this.data.session[this.selectedIndex()];
  }

  private selectedDefinition(): SubagentDefinition | undefined {
    return this.data.definitions[this.selectedIndex()];
  }

  private activate(): void {
    if (this.tab() === "running") {
      const job = this.data.running[this.selectedIndex()];
      if (job) this.finish({ kind: "cancel", id: job.id });
      return;
    }
    if (this.tab() === "session") {
      const run = this.selectedRun();
      if (run && run.phase !== "running" && run.phase !== "cancelling") this.finish({ kind: "resume", id: run.id });
      return;
    }
    const definition = this.selectedDefinition();
    if (definition) this.finish({ kind: "edit-definition", name: definition.name });
  }

  private listRows(): string[] {
    const selected = this.selectedIndex();
    if (this.tab() === "running") {
      if (this.data.running.length === 0) return [this.theme.fg("dim", "No active background subagents")];
      return this.data.running.map((job, index) => {
        const marker = index === selected ? this.theme.fg("accent", "›") : " ";
        const name = job.details.agent?.name ?? "generic";
        return `${marker} ${this.theme.fg("accent", name)} ${this.theme.fg("dim", shortId(job.id))}  ${job.status}`;
      });
    }
    if (this.tab() === "session") {
      if (this.data.session.length === 0) return [this.theme.fg("dim", "No V3 subagents in this session")];
      return this.data.session.map((run, index) => {
        const marker = index === selected ? this.theme.fg("accent", "›") : " ";
        const name = run.agent?.name ?? "generic";
        return `${marker} ${this.theme.fg("accent", name)} ${this.theme.fg("dim", shortId(run.id))}  ${run.phase}`;
      });
    }
    if (this.data.definitions.length === 0) return [this.theme.fg("dim", "No valid V2 definitions")];
    return this.data.definitions.map((definition, index) => {
      const marker = index === selected ? this.theme.fg("accent", "›") : " ";
      const visibility = definition.visible ? "visible" : "hidden";
      return `${marker} ${this.theme.fg("accent", definition.name)}  ${this.theme.fg("dim", `${definition.source} · ${visibility}`)}`;
    });
  }

  private detailRows(): string[] {
    if (this.tab() === "running") {
      const job = this.data.running[this.selectedIndex()];
      if (!job) return [];
      return [
        `ID  ${job.id}`,
        `TASK  ${sanitizeSubagentDisplay(job.details.task)}`,
        `ACTIVITY  ${latestToolCall(job.details)}`,
        `USAGE  ${job.details.usage.turns} turns · ${formatDuration(Date.now() - job.details.startedAt)}`,
      ];
    }
    if (this.tab() === "session") {
      const run = this.selectedRun();
      if (!run) return [];
      const current = run.agent?.name ? this.data.definitions.find((item) => item.name === run.agent?.name) : undefined;
      const currentHash = current ? promptDefinitionHash(current) : undefined;
      const originalHash = run.promptSnapshot.manifest.definitionHash;
      const drift = originalHash && currentHash ? (originalHash === currentHash ? "unchanged" : "changed") : "not comparable";
      return [
        `ID  ${run.id}`,
        `TASK  ${sanitizeSubagentDisplay(run.task)}`,
        `MODEL  ${run.model ?? "inherited"}`,
        `PROMPT  V${run.promptSnapshot.version} · ${drift}`,
        `HASH  ${(originalHash ?? run.promptSnapshot.manifest.effectiveSystemHash).slice(0, 16)}`,
      ];
    }
    const definition = this.selectedDefinition();
    if (!definition) return this.data.errors.slice(0, 4);
    const rows = [
      `DESCRIPTION  ${definition.description}`,
      `MODEL  ${definition.model ?? "inherit"} · EFFORT  ${definition.effort ?? "inherit"}`,
      `PARENT SYSTEM  ${definition.inheritParentSystem ? "inherit" : "isolated"}`,
      `TOOLS  ${definition.tools?.join(", ") || "default"}`,
      `EXTENSIONS  ${definition.extensionTools?.join(", ") || "none"}`,
      `SKILLS  ${definition.skills?.join(", ") || "all"}`,
      `LAYERS  ${definition.layers.map((layer) => layer.source).join(" → ")}`,
    ];
    for (const field of ["policy", "instructions", "output"] as const) {
      const source = definition.fieldSources[field]?.source ?? "default";
      rows.push(`${field.toUpperCase()}  ${definition[field] ? "set" : "empty"} · ${source}`);
    }
    return rows;
  }

  private commandBar(): string {
    if (this.tab() === "running") return "enter cancel · ←/→ tabs · esc close";
    if (this.tab() === "session") return "enter resume · f fresh · d delete history · ←/→ tabs · esc close";
    return "enter edit field · n new · h hide/show · d delete overlay · ←/→ tabs · esc close";
  }

  render(width: number): string[] {
    const safeWidth = Math.max(20, width);
    const tabs = TABS.map((tab, index) => (
      index === this.tabIndex
        ? this.theme.fg("accent", this.theme.bold(tab.toUpperCase()))
        : this.theme.fg("dim", tab.toUpperCase())
    )).join(this.theme.fg("dim", "   "));
    const output = [
      fit(`${this.theme.fg("toolTitle", this.theme.bold("SUBAGENTS"))}  ${tabs}`, safeWidth),
      fit(this.theme.fg("dim", "─".repeat(safeWidth)), safeWidth),
    ];
    const allRows = this.listRows();
    const listStart = Math.max(0, Math.min(this.selectedIndex() - 4, Math.max(0, allRows.length - 10)));
    const list = allRows.slice(listStart, listStart + 10);
    const detail = this.detailRows().flatMap((line) => wrap(line, Math.max(20, safeWidth - 2))).slice(0, 12);

    if (safeWidth >= 90) {
      const leftWidth = Math.min(42, Math.floor(safeWidth * 0.42));
      const rightWidth = safeWidth - leftWidth - 3;
      const height = Math.max(list.length, detail.length, 1);
      for (let index = 0; index < height; index += 1) {
        output.push(`${fit(list[index] ?? "", leftWidth)} ${this.theme.fg("dim", "│")} ${fit(detail[index] ?? "", rightWidth)}`);
      }
    } else {
      output.push(...list.map((line) => fit(line, safeWidth)));
      if (detail.length > 0) {
        output.push("", fit(this.theme.fg("dim", "DETAIL ─"), safeWidth));
        output.push(...detail.map((line) => fit(line, safeWidth)));
      }
    }
    if (this.data.errors.length > 0) output.push("", fit(this.theme.fg("error", `ISSUES  ${this.data.errors[0]}`), safeWidth));
    output.push("", fit(this.theme.fg("dim", this.commandBar()), safeWidth));
    return output;
  }

  handleInput(data: string): void {
    if (this.finished) return;
    if (this.keybindings.matches(data, "tui.select.cancel")) return this.finish({ kind: "close" });
    if (this.keybindings.matches(data, "tui.select.up")) return this.move(-1);
    if (this.keybindings.matches(data, "tui.select.down")) return this.move(1);
    if (matchesKey(data, "left") || matchesKey(data, "shift+tab")) return this.switchTab(-1);
    if (matchesKey(data, "right") || matchesKey(data, "tab")) return this.switchTab(1);
    if (this.keybindings.matches(data, "tui.select.confirm")) return this.activate();

    if (this.tab() === "session") {
      const run = this.selectedRun();
      if (matchesKey(data, "f") && run) return this.finish({ kind: "fresh", id: run.id });
      if (matchesKey(data, "d") && run) return this.finish({ kind: "delete-history", id: run.id });
    }
    if (this.tab() === "definitions") {
      const definition = this.selectedDefinition();
      if (matchesKey(data, "n")) return this.finish({ kind: "create-definition" });
      if (matchesKey(data, "h") && definition) return this.finish({ kind: "toggle-definition", name: definition.name });
      if (matchesKey(data, "d") && definition) return this.finish({ kind: "delete-definition", name: definition.name });
    }
  }

  invalidate(): void {}
}

function layerPatch(definition: SubagentDefinition, scope: "agent" | "project"): SubagentDefinitionPatch {
  const layer = definition.layers.find((candidate) => candidate.source === scope);
  return layer ? structuredClone(layer.patch) : { promptVersion: 2, name: definition.name };
}

function fieldValueForEdit(definition: SubagentDefinition, field: SubagentDefinitionField): string {
  const value = definitionValue(definition, field);
  if (Array.isArray(value)) return value.join("\n");
  return typeof value === "string" ? value : "";
}

async function chooseScope(ctx: ExtensionCommandContext): Promise<"project" | "agent" | undefined> {
  const selected = await ctx.ui.select("Definition scope", ["project (current repository)", "agent (all projects)"]);
  if (selected?.startsWith("project")) return "project";
  if (selected?.startsWith("agent")) return "agent";
  return undefined;
}

function summarizeEffectiveChange(
  before: SubagentDefinition | undefined,
  after: SubagentDefinition | undefined,
  field: SubagentDefinitionField,
): string {
  const oldValue = before ? displayValue(definitionValue(before, field)) : "(missing)";
  const newValue = after ? displayValue(definitionValue(after, field)) : "(invalid)";
  const oldSource = before?.fieldSources[field]?.source ?? "default";
  const newSource = after?.fieldSources[field]?.source ?? "default";
  return `${field}: ${oldValue} [${oldSource}]\n→ ${newValue} [${newSource}]`;
}

async function confirmPatch(
  ctx: ExtensionCommandContext,
  state: SubagentRuntimeState,
  scope: "agent" | "project",
  patch: SubagentDefinitionPatch,
  field: SubagentDefinitionField,
): Promise<boolean> {
  const preview = previewDefinitionPatch({ registry: state.registry, cwd: ctx.cwd, scope, patch });
  if (preview.errors.length > 0 || !preview.definition) {
    ctx.ui.notify(preview.errors.join(" ") || "The effective definition is invalid.", "error");
    return false;
  }
  const before = state.registry.definitions.find((item) => item.name === patch.name);
  const message = [
    `Path: ${preview.filePath}`,
    "",
    "Layer YAML",
    preview.content.trim().slice(0, 3000),
    "",
    "Effective change",
    summarizeEffectiveChange(before, preview.definition, field),
  ].join("\n");
  if (!await ctx.ui.confirm("Save subagent overlay?", message)) return false;
  writeDefinitionPatch({ cwd: ctx.cwd, scope, patch, filePath: preview.filePath });
  state.refresh?.(ctx.cwd);
  ctx.ui.notify(`Saved ${patch.name} ${scope} overlay.`, "info");
  return true;
}

async function editDefinition(ctx: ExtensionCommandContext, state: SubagentRuntimeState, name: string): Promise<void> {
  state.refresh?.(ctx.cwd);
  const definition = state.registry.definitions.find((item) => item.name === name);
  if (!definition) return ctx.ui.notify(`Unknown subagent '${name}'.`, "error");
  const scope = await chooseScope(ctx);
  if (!scope) return;
  const field = await ctx.ui.select("Field to edit", EDITABLE_FIELDS) as SubagentDefinitionField | undefined;
  if (!field) return;
  const patch = layerPatch(definition, scope);
  const mutablePatch = patch as unknown as Record<string, unknown>;
  const mode = await ctx.ui.select(`${field} overlay state`, ["inherit lower layer", "set value", "clear lower value"]);
  if (!mode) return;

  if (mode.startsWith("inherit")) {
    delete mutablePatch[field];
  } else if (mode.startsWith("clear")) {
    mutablePatch[field] = null;
  } else if (BOOLEAN_FIELDS.has(field)) {
    const value = await ctx.ui.select(`Set ${field}`, ["true", "false"]);
    if (!value) return;
    mutablePatch[field] = value === "true";
  } else if (ARRAY_FIELDS.has(field)) {
    const value = await ctx.ui.editor(`Set ${field} (one item per line)`, fieldValueForEdit(definition, field));
    if (value === undefined) return;
    mutablePatch[field] = value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  } else if (MULTILINE_FIELDS.has(field)) {
    const value = await ctx.ui.editor(`Set ${field}`, fieldValueForEdit(definition, field));
    if (value === undefined) return;
    mutablePatch[field] = value.trim();
  } else {
    const value = await ctx.ui.input(`Set ${field}`, displayValue(definitionValue(definition, field)));
    if (value === undefined) return;
    mutablePatch[field] = value.trim();
  }
  await confirmPatch(ctx, state, scope, patch, field);
}

async function createDefinition(ctx: ExtensionCommandContext, state: SubagentRuntimeState): Promise<void> {
  const scope = await chooseScope(ctx);
  if (!scope) return;
  const name = (await ctx.ui.input("New subagent name", "my-agent"))?.trim();
  if (!name) return;
  const description = (await ctx.ui.editor("Routing description", "Describe when the parent should delegate to this agent."))?.trim();
  if (!description) return ctx.ui.notify("A new definition requires a description.", "warning");
  const patch: SubagentDefinitionPatch = { promptVersion: 2, name, description, visible: true };
  await confirmPatch(ctx, state, scope, patch, "description");
}

async function toggleDefinition(ctx: ExtensionCommandContext, state: SubagentRuntimeState, name: string): Promise<void> {
  state.refresh?.(ctx.cwd);
  const definition = state.registry.definitions.find((item) => item.name === name);
  if (!definition) return;
  const scope = await chooseScope(ctx);
  if (!scope) return;
  const patch = layerPatch(definition, scope);
  patch.visible = !definition.visible;
  await confirmPatch(ctx, state, scope, patch, "visible");
}

async function deleteDefinition(ctx: ExtensionCommandContext, state: SubagentRuntimeState, name: string): Promise<void> {
  state.refresh?.(ctx.cwd);
  const definition = state.registry.definitions.find((item) => item.name === name);
  if (!definition) return;
  const writable = definition.layers.filter((layer) => layer.source === "project" || layer.source === "agent");
  if (writable.length === 0) {
    ctx.ui.notify("Package definitions are read-only. Use hide/show to create an overlay.", "warning");
    return;
  }
  const labels = writable.map((layer) => `${layer.source}: ${layer.filePath}`);
  const selected = labels.length === 1 ? labels[0] : await ctx.ui.select("Overlay to delete", labels);
  if (!selected) return;
  const layer = writable[labels.indexOf(selected)];
  if (!layer || layer.source === "package") return;
  const lower = [...definition.layers].filter((candidate) => candidate.source !== layer.source).at(-1);
  const message = lower
    ? `Delete ${layer.filePath}?\n\nThe effective definition will fall back to ${lower.source}: ${lower.filePath}.`
    : `Delete ${layer.filePath}?\n\nThe definition will disappear.`;
  if (!await ctx.ui.confirm("Delete subagent overlay?", message)) return;
  deleteDefinitionOverlay({ cwd: ctx.cwd, scope: layer.source, name, filePath: layer.filePath });
  state.refresh?.(ctx.cwd);
  ctx.ui.notify(`Deleted ${layer.source} overlay for ${name}.`, "info");
}

async function promptTask(ctx: ExtensionCommandContext, title: string): Promise<string | undefined> {
  const task = (await ctx.ui.editor(title, "Describe the next delegated task."))?.trim();
  if (!task) {
    if (task !== undefined) ctx.ui.notify("A non-empty task is required.", "warning");
    return undefined;
  }
  return task;
}

async function runManagedResume(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  state: SubagentRuntimeState,
  id: string,
): Promise<void> {
  const task = await promptTask(ctx, "Resume subagent task");
  if (!task) return;
  const parentSessionId = ctx.sessionManager.getSessionId();
  const details = listParentSessionRuns(parentSessionId).find((item) => item.id === id);
  if (!details) {
    ctx.ui.notify(`Subagent '${id}' does not belong to the current session.`, "error");
    return;
  }
  if (details.phase === "running" || details.phase === "cancelling") {
    ctx.ui.notify(`Subagent '${id}' is already active.`, "warning");
    return;
  }
  const job = createQueuedResumeJob({ state: state.background, details, task, parentSessionId });
  startBackgroundResumeJob({ pi, state: state.background, job, ctx, task, parentSessionId });
  ctx.ui.notify(`Queued resume for ${details.agent?.name ?? "generic"} ${shortId(id)}.`, "info");
}

async function runManagedFresh(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  state: SubagentRuntimeState,
  original: SubagentRunDetails,
): Promise<void> {
  const task = await promptTask(ctx, "Start fresh task");
  if (!task) return;
  state.refresh?.(ctx.cwd);
  const definition = original.agent?.name
    ? state.registry.definitions.find((item) => item.name === original.agent?.name && item.visible)
    : undefined;
  if (original.agent?.name && !definition) {
    ctx.ui.notify(`Current definition '${original.agent.name}' is hidden, invalid, or missing.`, "error");
    return;
  }
  const id = createSubagentId();
  const parentSessionId = ctx.sessionManager.getSessionId();
  const promptSnapshot = compileFreshPrompt({
    definition,
    inheritedSystemCore: state.inheritedSystemCore,
  });
  const job = createQueuedJob({
    state: state.background,
    id,
    task,
    cwd: ctx.cwd,
    parentSessionId,
    promptSnapshot,
    definition,
  });
  startBackgroundJob({
    pi,
    state: state.background,
    job,
    ctx,
    task,
    parentSessionId,
    inheritedSystemCore: state.inheritedSystemCore,
    thinkingLevel: pi.getThinkingLevel(),
    definition,
  });
  ctx.ui.notify(`Queued fresh ${definition?.name ?? "generic"} ${shortId(id)}.`, "info");
}

function buildConfigurationRequest(registry: SubagentRegistry, cwd: string, request: string): string {
  const definitions = registry.definitions.slice(0, 50).map((definition) => ({
    name: definition.name,
    visible: definition.visible,
    layers: definition.layers.map((layer) => ({ source: layer.source, filePath: layer.filePath })),
    model: definition.model ?? "inherit",
    effort: definition.effort ?? "inherit",
    tools: definition.tools ?? "default",
    extensionTools: definition.extensionTools ?? [],
    skills: definition.skills ?? "all",
  }));
  return `[Subagent V2 configuration request]

Configuration contract:
- Use promptVersion: 2.
- Fields overlay by package < agent < project. Omitted fields inherit; null clears scalars and [] clears arrays.
- V2 prompt fields are policy (SYSTEM), instructions (replayed profile), and output (replayed delivery contract).
- Package files are read-only. Default writes to ${cwd}/.pi/subagents; use the agent scope only when the request explicitly requires all projects.
- visible: false hides an effective definition from the parent catalog and tool lookup.
- Validate the effective definition after edits. Confirm destructive deletion when the target or scope is ambiguous.

Current effective definitions:
${JSON.stringify(definitions, null, 2)}

[User configuration request]
${request}`;
}

async function openManager(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  state: SubagentRuntimeState,
): Promise<void> {
  const parentSessionId = String(ctx.sessionManager?.getSessionId?.() ?? "").trim();
  if (!parentSessionId) {
    ctx.ui.notify("The current Pi session has no stable ID; subagent manager is unavailable.", "error");
    return;
  }

  for (;;) {
    state.refresh?.(ctx.cwd);
    const action = await ctx.ui.custom<ManagerAction>((tui, theme, keybindings, done) => (
      new SubagentManager(snapshot(state, parentSessionId), tui, theme, keybindings, done)
    ), { overlay: true });
    if (!action || action.kind === "close") return;
    if (action.kind === "cancel") {
      const job = state.background.jobs.get(action.id);
      if (!job) continue;
      if (await ctx.ui.confirm("Cancel background subagent?", `${job.details.agent?.name ?? "generic"} ${action.id}\n\nArtifacts will be retained for resume.`)) {
        cancelBackgroundJobs({ state: state.background, id: action.id, reason: "Canceled from /subagent manager." });
      }
      continue;
    }
    if (action.kind === "resume") {
      await runManagedResume(pi, ctx, state, action.id);
      return;
    }
    if (action.kind === "fresh") {
      const run = listParentSessionRuns(parentSessionId).find((item) => item.id === action.id);
      if (run) await runManagedFresh(pi, ctx, state, run);
      return;
    }
    if (action.kind === "delete-history") {
      if (await ctx.ui.confirm("Delete subagent history?", `${action.id}\n\nThis permanently deletes run.json and the native child session.`)) {
        try {
          deleteParentSessionRun(parentSessionId, action.id);
          ctx.ui.notify(`Deleted subagent history ${action.id}.`, "info");
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        }
      }
      continue;
    }
    if (action.kind === "create-definition") await createDefinition(ctx, state);
    else if (action.kind === "edit-definition") await editDefinition(ctx, state, action.name);
    else if (action.kind === "toggle-definition") await toggleDefinition(ctx, state, action.name);
    else if (action.kind === "delete-definition") await deleteDefinition(ctx, state, action.name);
  }
}

export function registerSubagentManager(pi: ExtensionAPI, state: SubagentRuntimeState): void {
  pi.registerCommand("subagent", {
    description: "Manage current-session subagents and V2 definitions, or ask Pi to modify configuration.",
    handler: async (args, ctx) => {
      const request = String(args ?? "").trim();
      state.refresh?.(ctx.cwd);
      if (request) {
        pi.sendUserMessage(buildConfigurationRequest(state.registry, ctx.cwd, request));
        return;
      }
      if (!ctx.hasUI) return;
      await openManager(pi, ctx, state);
    },
  });
}

export const __testables = {
  SubagentManager,
  buildConfigurationRequest,
  displayValue,
  snapshot,
};
