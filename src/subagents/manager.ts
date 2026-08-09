import {
  getSelectListTheme,
  keyHint,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  Editor,
  matchesKey,
  type Component,
  type Focusable,
  type TUI,
  truncateToWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { DisplayRuntimeProvider } from "../display/tool-renderer";
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
  subscribeBackgroundState,
} from "./background";
import {
  buildSubagentConfigGuide,
  renderSubagentConfigGuide,
  SUBAGENT_CONFIG_GUIDE_TYPE,
} from "./config-guide";
import {
  deleteDefinitionOverlay,
  previewDefinitionPatch,
  type SubagentDefinition,
  type SubagentDefinitionField,
  type SubagentDefinitionPatch,
  writeDefinitionPatch,
} from "./definitions";
import { sanitizeSubagentDisplay } from "./display";
import { isRunLeaseActive } from "./lease";
import { compileFreshPrompt, promptDefinitionHash } from "./prompt";
import { latestToolCallSummary } from "./tool-display";
import type { SubagentRuntimeState } from "./tool";
import type { BackgroundJobSnapshot, SubagentRunDetails } from "./types";

type ManagerTab = "running" | "session" | "definitions";
type WritableScope = "agent" | "project";

interface ManagerSnapshot {
  running: BackgroundJobSnapshot[];
  session: SubagentRunDetails[];
  activeSessionIds?: string[];
  definitions: SubagentDefinition[];
  errors: string[];
}

type DefinitionPreview = ReturnType<typeof previewDefinitionPatch>;

interface OperationResult {
  ok: boolean;
  message: string;
  selectedId?: string;
}

interface ManagerServices {
  refresh(): ManagerSnapshot;
  subscribe(listener: () => void): () => void;
  subscribeMotion?(listener: () => void): () => void;
  cancel(id: string): OperationResult;
  queueResume(id: string, task: string): OperationResult;
  queueFresh(id: string, task: string): OperationResult;
  deleteHistory(id: string): OperationResult;
  preview(scope: WritableScope, patch: SubagentDefinitionPatch): DefinitionPreview;
  save(scope: WritableScope, patch: SubagentDefinitionPatch, filePath?: string): OperationResult;
  deleteOverlay(definition: SubagentDefinition, scope: WritableScope, filePath: string): OperationResult;
}

interface ChoiceItem {
  id: string;
  label: string;
  detail?: string;
  onSelect(): void;
}

interface BrowseView {
  kind: "browse";
}

interface ChoiceView {
  kind: "choice";
  eyebrow: string;
  title: string;
  description?: string;
  items: ChoiceItem[];
  index: number;
}

interface EditorView {
  kind: "editor";
  eyebrow: string;
  title: string;
  description?: string;
  editor: Editor;
  submitLabel: string;
  validate(value: string): string | undefined;
  onSubmit(value: string): void;
  error?: string;
}

interface ReviewView {
  kind: "review";
  eyebrow: string;
  title: string;
  lines: string[];
  confirmLabel: string;
  destructive?: boolean;
  scroll: number;
  onConfirm(): void;
}

type ManagerView = BrowseView | ChoiceView | EditorView | ReviewView;

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
const ARRAY_FIELDS = new Set<SubagentDefinitionField>(["tools", "extensionTools", "skills"]);
const BOOLEAN_FIELDS = new Set<SubagentDefinitionField>(["inheritParentSystem", "visible"]);
const MAX_REVIEW_CONTENT = 5_000;

function fit(line: string, width: number): string {
  return truncateToWidth(line, Math.max(1, width), "…", true);
}

/** Operational marker + label for a background-job status in the running tab. */
function jobStatusPresentation(status: string, theme: any): string {
  switch (status) {
    case "queued": return theme.fg("muted", "– queued");
    case "cancelling": return theme.fg("warning", "× cancelling");
    default: return theme.fg("accent", "→ running");
  }
}

/**
 * Operational marker + label for a session-run phase in the session tab.
 * Inactive running/cancelling sessions use muted tone because the lease is
 * dead; the running-tab helper uses warning for an actively-cancelling job.
 */
function sessionPhasePresentation(active: boolean, phase: string, theme: any): string {
  if (active) return theme.fg("warning", "→ active");
  const suffix = phase === "running" || phase === "cancelling" ? " (inactive)" : "";
  switch (phase) {
    case "done": return theme.fg("success", `✓ done`);
    case "error": return theme.fg("error", `✗ error`);
    case "aborted": return theme.fg("muted", `× aborted`);
    case "cancelling": return theme.fg("muted", `× cancelling${suffix}`);
    case "running": return theme.fg("muted", `→ running${suffix}`);
    default: return theme.fg("muted", phase);
  }
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
  const session = listParentSessionRuns(parentSessionId);
  return {
    running: activeJobs(state),
    session,
    activeSessionIds: session.filter((run) => isRunLeaseActive(run.id)).map((run) => run.id),
    definitions: [...state.registry.definitions].sort((a, b) => a.name.localeCompare(b.name)),
    errors: [...state.registry.errors],
  };
}

export function managerPanelWidth(terminalWidth: number): number {
  const width = Math.max(1, terminalWidth);
  if (width <= 72) return width;
  if (width < 110) return Math.min(80, width);
  return Math.min(104, Math.max(88, Math.floor(width * 0.84)));
}

export function managerRowBudget(terminalRows: number): number {
  const rows = Math.max(1, Math.floor(terminalRows));
  return Math.min(rows, 30, Math.max(8, Math.floor(rows * 0.72)));
}

function layerPatch(definition: SubagentDefinition, scope: WritableScope): SubagentDefinitionPatch {
  const layer = definition.layers.find((candidate) => candidate.source === scope);
  return layer ? structuredClone(layer.patch) : { promptVersion: 2, name: definition.name };
}

function fieldValueForEdit(definition: SubagentDefinition, field: SubagentDefinitionField): string {
  const value = definitionValue(definition, field);
  if (Array.isArray(value)) return value.join("\n");
  if (typeof value === "boolean") return String(value);
  return typeof value === "string" ? value : "";
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

function createProductionServices(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  state: SubagentRuntimeState,
  parentSessionId: string,
  runtime?: DisplayRuntimeProvider,
): ManagerServices {
  const refresh = () => {
    state.refresh?.(ctx.cwd);
    return snapshot(state, parentSessionId);
  };
  return {
    refresh,
    subscribe(listener) {
      return subscribeBackgroundState(state.background, listener);
    },
    ...(runtime ? {
      subscribeMotion(listener: () => void) {
        return (typeof runtime === "function" ? runtime() : runtime).subscribe(listener);
      },
    } : {}),
    cancel(id) {
      const job = state.background.jobs.get(id);
      if (!job) return { ok: false, message: `Background subagent '${id}' is no longer active.` };
      cancelBackgroundJobs({ state: state.background, id, reason: "Canceled from /subagent manager." });
      return { ok: true, message: `Cancellation requested for ${job.details.agent?.name ?? "generic"} ${shortId(id)}.` };
    },
    queueResume(id, task) {
      const details = listParentSessionRuns(parentSessionId).find((item) => item.id === id);
      if (!details) return { ok: false, message: `Subagent '${id}' does not belong to the current session.` };
      if (isRunLeaseActive(id)) {
        return { ok: false, message: `Subagent '${id}' is active and cannot be resumed concurrently.` };
      }
      const job = createQueuedResumeJob({ state: state.background, details, task, parentSessionId });
      startBackgroundResumeJob({ pi, state: state.background, job, ctx, task, parentSessionId });
      return {
        ok: true,
        message: `Queued resume for ${details.agent?.name ?? "generic"} ${shortId(id)}.`,
        selectedId: id,
      };
    },
    queueFresh(id, task) {
      refresh();
      const original = listParentSessionRuns(parentSessionId).find((item) => item.id === id);
      if (!original) return { ok: false, message: `Subagent '${id}' does not belong to the current session.` };
      const definition = original.agent?.name
        ? state.registry.definitions.find((item) => item.name === original.agent?.name && item.visible)
        : undefined;
      if (original.agent?.name && !definition) {
        return { ok: false, message: `Current definition '${original.agent.name}' is hidden, invalid, or missing.` };
      }
      const newId = createSubagentId();
      const promptSnapshot = compileFreshPrompt({ definition, inheritedSystemCore: state.inheritedSystemCore });
      const job = createQueuedJob({
        state: state.background,
        id: newId,
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
      return {
        ok: true,
        message: `Queued fresh ${definition?.name ?? "generic"} ${shortId(newId)}.`,
        selectedId: newId,
      };
    },
    deleteHistory(id) {
      try {
        deleteParentSessionRun(parentSessionId, id);
        return { ok: true, message: `Deleted subagent history ${shortId(id)}.` };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    },
    preview(scope, patch) {
      return previewDefinitionPatch({ registry: state.registry, cwd: ctx.cwd, scope, patch });
    },
    save(scope, patch, filePath) {
      try {
        writeDefinitionPatch({ cwd: ctx.cwd, scope, patch, filePath });
        state.refresh?.(ctx.cwd);
        return { ok: true, message: `Saved ${patch.name} ${scope} overlay.` };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    },
    deleteOverlay(definition, scope, filePath) {
      try {
        deleteDefinitionOverlay({ cwd: ctx.cwd, scope, name: definition.name, filePath });
        state.refresh?.(ctx.cwd);
        return { ok: true, message: `Deleted ${scope} overlay for ${definition.name}.` };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

export class SubagentManager implements Component, Focusable {
  private data: ManagerSnapshot;
  private tabIndex = 0;
  private indices: Record<ManagerTab, number> = { running: 0, session: 0, definitions: 0 };
  private view: ManagerView = { kind: "browse" };
  private history: ManagerView[] = [];
  private flash?: { kind: "success" | "error"; text: string };
  private _focused = false;
  private finished = false;
  private readonly unsubscribe?: () => void;
  private readonly unsubscribeMotion?: () => void;

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    if (this.view.kind === "editor") this.view.editor.focused = value;
  }

  constructor(
    initialData: ManagerSnapshot,
    private readonly tui: TUI,
    private readonly theme: any,
    private readonly keybindings: KeybindingsManager,
    private readonly done: () => void,
    private readonly services?: ManagerServices,
  ) {
    this.data = initialData;
    this.unsubscribe = services?.subscribe(() => {
      this.refreshData();
      this.tui.requestRender();
    });
    this.unsubscribeMotion = services?.subscribeMotion?.(() => {
      if (this.data.running.length > 0) this.tui.requestRender();
    });
  }

  private refreshData(selectedId?: string): void {
    if (!this.services) return;
    this.data = this.services.refresh();
    for (const tab of TABS) {
      const count = this.count(tab);
      this.indices[tab] = count === 0 ? 0 : Math.min(this.indices[tab], count - 1);
    }
    if (selectedId) {
      const index = this.data.running.findIndex((job) => job.id === selectedId);
      if (index >= 0) this.indices.running = index;
    }
  }

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

  private selectedRun(): SubagentRunDetails | undefined {
    return this.data.session[this.selectedIndex()];
  }

  private runIsActive(run: SubagentRunDetails | undefined): boolean {
    return Boolean(run && this.data.activeSessionIds?.includes(run.id));
  }

  private selectedDefinition(): SubagentDefinition | undefined {
    return this.data.definitions[this.selectedIndex()];
  }

  private move(delta: number): void {
    const count = this.count();
    if (count > 0) this.indices[this.tab()] = (this.selectedIndex() + delta + count) % count;
    this.tui.requestRender();
  }

  private switchTab(delta: number): void {
    this.tabIndex = (this.tabIndex + delta + TABS.length) % TABS.length;
    this.flash = undefined;
    this.tui.requestRender();
  }

  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.done();
  }

  private push(view: ManagerView): void {
    this.history.push(this.view);
    this.view = view;
    if (view.kind === "editor") view.editor.focused = this._focused;
    this.flash = undefined;
    this.tui.requestRender();
  }

  private back(): void {
    const previous = this.history.pop();
    if (!previous) {
      this.finish();
      return;
    }
    this.view = previous;
    if (previous.kind === "editor") previous.editor.focused = this._focused;
    this.flash = undefined;
    this.tui.requestRender();
  }

  private resetBrowse(result: OperationResult, preferredTab?: ManagerTab): void {
    if (!result.ok) {
      this.flash = { kind: "error", text: result.message };
      this.refreshData();
      this.tui.requestRender();
      return;
    }
    this.view = { kind: "browse" };
    this.history = [];
    this.flash = { kind: "success", text: result.message };
    if (preferredTab) this.tabIndex = TABS.indexOf(preferredTab);
    this.refreshData(result.selectedId);
    this.tui.requestRender();
  }

  private openChoice(input: Omit<ChoiceView, "kind" | "index">): void {
    this.push({ kind: "choice", index: 0, ...input });
  }

  private openEditor(input: {
    eyebrow: string;
    title: string;
    description?: string;
    initial?: string;
    submitLabel: string;
    validate?: (value: string) => string | undefined;
    onSubmit(value: string): void;
  }): void {
    const editor = new Editor(this.tui, {
      borderColor: (text) => this.theme.fg("border", text),
      selectList: getSelectListTheme(),
    }, { paddingX: 0, autocompleteMaxVisible: 0 });
    editor.setText(input.initial ?? "");
    const view: EditorView = {
      kind: "editor",
      eyebrow: input.eyebrow,
      title: input.title,
      description: input.description,
      editor,
      submitLabel: input.submitLabel,
      validate: input.validate ?? (() => undefined),
      onSubmit: input.onSubmit,
    };
    editor.onChange = () => {
      view.error = undefined;
      this.tui.requestRender();
    };
    editor.onSubmit = (value) => {
      const error = view.validate(value);
      if (error) {
        view.error = error;
        this.tui.requestRender();
        return;
      }
      view.onSubmit(value);
    };
    this.push(view);
  }

  private openReview(input: Omit<ReviewView, "kind" | "scroll">): void {
    this.push({ kind: "review", scroll: 0, ...input });
  }

  private confirmCancel(job: BackgroundJobSnapshot): void {
    this.openReview({
      eyebrow: "RUNNING / CANCEL",
      title: `Cancel ${job.details.agent?.name ?? "generic"} ${shortId(job.id)}?`,
      lines: [
        "The child will transition through cancelling to aborted.",
        "Artifacts and native session history remain available for resume.",
        "",
        `Task: ${sanitizeSubagentDisplay(job.details.task)}`,
      ],
      confirmLabel: "cancel job",
      destructive: true,
      onConfirm: () => this.resetBrowse(
        this.services?.cancel(job.id) ?? { ok: false, message: "Manager actions are unavailable." },
        "running",
      ),
    });
  }

  private openTask(kind: "resume" | "fresh", run: SubagentRunDetails): void {
    const label = kind === "resume" ? "Resume original" : "Start fresh";
    this.openEditor({
      eyebrow: `SESSION / ${kind.toUpperCase()}`,
      title: `${label} · ${run.agent?.name ?? "generic"} ${shortId(run.id)}`,
      description: kind === "resume"
        ? "Continue the frozen child session with a new authorized task."
        : "Create a new ID using the current effective definition.",
      initial: "",
      submitLabel: "review task",
      validate: (value) => value.trim() ? undefined : "A non-empty task is required.",
      onSubmit: (value) => {
        const task = value.trim();
        this.openReview({
          eyebrow: `SESSION / ${kind.toUpperCase()} / REVIEW`,
          title: label,
          lines: [
            `Agent: ${run.agent?.name ?? "generic"}`,
            `Source ID: ${run.id}`,
            `Prompt: ${kind === "resume" ? "frozen V2 snapshot" : "current effective definition"}`,
            "",
            "TASK",
            ...task.split("\n"),
          ],
          confirmLabel: kind === "resume" ? "queue resume" : "queue fresh run",
          onConfirm: () => {
            const result = kind === "resume"
              ? this.services?.queueResume(run.id, task)
              : this.services?.queueFresh(run.id, task);
            this.resetBrowse(result ?? { ok: false, message: "Manager actions are unavailable." }, "running");
          },
        });
      },
    });
  }

  private confirmHistoryDelete(run: SubagentRunDetails): void {
    this.openReview({
      eyebrow: "SESSION / DELETE",
      title: `Delete history ${shortId(run.id)}?`,
      lines: [
        "This permanently deletes run.json and the native child session.",
        "This action is separate from cancellation and cannot be undone.",
        "",
        `Agent: ${run.agent?.name ?? "generic"}`,
        `Task: ${sanitizeSubagentDisplay(run.task)}`,
      ],
      confirmLabel: "delete history",
      destructive: true,
      onConfirm: () => this.resetBrowse(
        this.services?.deleteHistory(run.id) ?? { ok: false, message: "Manager actions are unavailable." },
        "session",
      ),
    });
  }

  private chooseScope(title: string, onSelect: (scope: WritableScope) => void): void {
    this.openChoice({
      eyebrow: "DEFINITIONS / SCOPE",
      title,
      description: "Project is the default write target. Agent scope applies across repositories.",
      items: [
        { id: "project", label: "Project", detail: "Write to .pi/subagents in the current repository", onSelect: () => onSelect("project") },
        { id: "agent", label: "Agent", detail: "Write to the user-level subagent directory", onSelect: () => onSelect("agent") },
      ],
    });
  }

  private reviewPatch(
    before: SubagentDefinition | undefined,
    scope: WritableScope,
    patch: SubagentDefinitionPatch,
    field: SubagentDefinitionField,
  ): void {
    const preview = this.services?.preview(scope, patch);
    if (!preview || preview.errors.length > 0 || !preview.definition) {
      this.flash = {
        kind: "error",
        text: preview?.errors.join(" ") || "The effective definition is invalid.",
      };
      this.tui.requestRender();
      return;
    }
    const body = [
      `Path: ${preview.filePath}`,
      "",
      "LAYER YAML",
      preview.content.trim().slice(0, MAX_REVIEW_CONTENT),
      "",
      "EFFECTIVE CHANGE",
      summarizeEffectiveChange(before, preview.definition, field),
    ];
    this.openReview({
      eyebrow: "DEFINITIONS / REVIEW",
      title: `Save ${patch.name} ${scope} overlay?`,
      lines: body,
      confirmLabel: "save overlay",
      onConfirm: () => this.resetBrowse(
        this.services?.save(scope, patch, preview.filePath) ?? { ok: false, message: "Manager actions are unavailable." },
        "definitions",
      ),
    });
  }

  private setPatchValue(
    definition: SubagentDefinition,
    scope: WritableScope,
    field: SubagentDefinitionField,
    patch: SubagentDefinitionPatch,
    value: unknown,
  ): void {
    (patch as unknown as Record<string, unknown>)[field] = value;
    this.reviewPatch(definition, scope, patch, field);
  }

  private chooseBoolean(
    definition: SubagentDefinition,
    scope: WritableScope,
    field: SubagentDefinitionField,
    patch: SubagentDefinitionPatch,
  ): void {
    this.openChoice({
      eyebrow: "DEFINITIONS / VALUE",
      title: `Set ${field}`,
      items: [
        { id: "true", label: "True", onSelect: () => this.setPatchValue(definition, scope, field, patch, true) },
        { id: "false", label: "False", onSelect: () => this.setPatchValue(definition, scope, field, patch, false) },
      ],
    });
  }

  private editFieldValue(
    definition: SubagentDefinition,
    scope: WritableScope,
    field: SubagentDefinitionField,
    patch: SubagentDefinitionPatch,
  ): void {
    if (BOOLEAN_FIELDS.has(field)) {
      this.chooseBoolean(definition, scope, field, patch);
      return;
    }
    const array = ARRAY_FIELDS.has(field);
    this.openEditor({
      eyebrow: "DEFINITIONS / VALUE",
      title: `Set ${field}`,
      description: array ? "Enter one item per line. An empty value produces an empty array." : undefined,
      initial: fieldValueForEdit(definition, field),
      submitLabel: "review change",
      onSubmit: (value) => this.setPatchValue(
        definition,
        scope,
        field,
        patch,
        array ? value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean) : value.trim(),
      ),
    });
  }

  private chooseFieldMode(definition: SubagentDefinition, scope: WritableScope, field: SubagentDefinitionField): void {
    const patch = layerPatch(definition, scope);
    this.openChoice({
      eyebrow: "DEFINITIONS / OVERLAY",
      title: `${definition.name} · ${field}`,
      description: "Inherit omits the field. Clear explicitly removes the lower-layer value.",
      items: [
        {
          id: "inherit",
          label: "Inherit lower layer",
          detail: "Remove this field from the selected overlay",
          onSelect: () => {
            delete (patch as unknown as Record<string, unknown>)[field];
            this.reviewPatch(definition, scope, patch, field);
          },
        },
        {
          id: "set",
          label: "Set value",
          detail: "Define a value in the selected overlay",
          onSelect: () => this.editFieldValue(definition, scope, field, patch),
        },
        {
          id: "clear",
          label: "Clear lower value",
          detail: ARRAY_FIELDS.has(field) ? "Write an explicit empty array" : "Write an explicit null",
          onSelect: () => this.setPatchValue(definition, scope, field, patch, ARRAY_FIELDS.has(field) ? [] : null),
        },
      ],
    });
  }

  private editDefinition(definition: SubagentDefinition): void {
    this.chooseScope(`Edit ${definition.name}`, (scope) => {
      this.openChoice({
        eyebrow: "DEFINITIONS / FIELD",
        title: `${definition.name} · ${scope}`,
        description: "Choose one effective field to modify.",
        items: EDITABLE_FIELDS.map((field) => ({
          id: field,
          label: field,
          detail: `${displayValue(definitionValue(definition, field))} · ${definition.fieldSources[field]?.source ?? "default"}`,
          onSelect: () => this.chooseFieldMode(definition, scope, field),
        })),
      });
    });
  }

  private createDefinition(): void {
    this.chooseScope("Create V2 definition", (scope) => {
      this.openEditor({
        eyebrow: "DEFINITIONS / NEW",
        title: "Definition name",
        description: "Use a stable lowercase name suitable for tool routing.",
        initial: "my-agent",
        submitLabel: "continue",
        validate: (value) => value.trim() ? undefined : "A name is required.",
        onSubmit: (nameValue) => {
          const name = nameValue.trim();
          this.openEditor({
            eyebrow: "DEFINITIONS / NEW",
            title: `${name} · routing description`,
            description: "Describe when the parent should delegate to this agent.",
            initial: "",
            submitLabel: "review definition",
            validate: (value) => value.trim() ? undefined : "A description is required.",
            onSubmit: (description) => {
              const patch: SubagentDefinitionPatch = {
                promptVersion: 2,
                name,
                description: description.trim(),
                visible: true,
              };
              this.reviewPatch(undefined, scope, patch, "description");
            },
          });
        },
      });
    });
  }

  private toggleDefinition(definition: SubagentDefinition): void {
    this.chooseScope(`${definition.visible ? "Hide" : "Show"} ${definition.name}`, (scope) => {
      const patch = layerPatch(definition, scope);
      patch.visible = !definition.visible;
      this.reviewPatch(definition, scope, patch, "visible");
    });
  }

  private deleteDefinition(definition: SubagentDefinition): void {
    const writable = definition.layers.filter((layer) => layer.source === "project" || layer.source === "agent");
    if (writable.length === 0) {
      this.flash = { kind: "error", text: "Package definitions are read-only. Use hide/show to create an overlay." };
      this.tui.requestRender();
      return;
    }
    this.openChoice({
      eyebrow: "DEFINITIONS / DELETE",
      title: `Choose ${definition.name} overlay`,
      description: "Only project and agent overlays can be deleted.",
      items: writable.map((layer) => ({
        id: `${layer.source}:${layer.filePath}`,
        label: `${layer.source} overlay`,
        detail: layer.filePath,
        onSelect: () => {
          if (layer.source !== "project" && layer.source !== "agent") return;
          const scope: WritableScope = layer.source;
          const lower = [...definition.layers].filter((candidate) => candidate.source !== scope).at(-1);
          this.openReview({
            eyebrow: "DEFINITIONS / DELETE / REVIEW",
            title: `Delete ${layer.source} overlay?`,
            lines: [
              layer.filePath,
              "",
              lower
                ? `The effective definition will fall back to ${lower.source}: ${lower.filePath}.`
                : "The effective definition will disappear.",
            ],
            confirmLabel: "delete overlay",
            destructive: true,
            onConfirm: () => this.resetBrowse(
              this.services?.deleteOverlay(definition, scope, layer.filePath)
                ?? { ok: false, message: "Manager actions are unavailable." },
              "definitions",
            ),
          });
        },
      })),
    });
  }

  private activate(): void {
    if (this.tab() === "running") {
      const job = this.data.running[this.selectedIndex()];
      if (job) this.confirmCancel(job);
      return;
    }
    if (this.tab() === "session") {
      const run = this.selectedRun();
      if (!run) return;
      if (this.runIsActive(run)) {
        this.flash = { kind: "error", text: `Subagent '${run.id}' is active and cannot be resumed concurrently.` };
        this.tui.requestRender();
        return;
      }
      this.openTask("resume", run);
      return;
    }
    const definition = this.selectedDefinition();
    if (definition) this.editDefinition(definition);
  }

  private listRows(): string[] {
    const selected = this.selectedIndex();
    if (this.tab() === "running") {
      if (this.data.running.length === 0) return [this.theme.fg("dim", "No active background subagents")];
      return this.data.running.map((job, index) => {
        const marker = index === selected ? this.theme.fg("accent", "›") : " ";
        const name = job.details.agent?.name ?? "generic";
        return `${marker} ${this.theme.fg("text", this.theme.bold(name))} ${this.theme.fg("dim", shortId(job.id))}  ${jobStatusPresentation(job.status, this.theme)}`;
      });
    }
    if (this.tab() === "session") {
      if (this.data.session.length === 0) return [this.theme.fg("dim", "No V3 subagents in this session")];
      return this.data.session.map((run, index) => {
        const marker = index === selected ? this.theme.fg("accent", "›") : " ";
        const name = run.agent?.name ?? "generic";
        const active = this.runIsActive(run);
        return `${marker} ${this.theme.fg("text", this.theme.bold(name))} ${this.theme.fg("dim", shortId(run.id))}  ${sessionPhasePresentation(active, run.phase, this.theme)}`;
      });
    }
    if (this.data.definitions.length === 0) return [this.theme.fg("dim", "No valid V2 definitions")];
    return this.data.definitions.map((definition, index) => {
      const marker = index === selected ? this.theme.fg("accent", "›") : " ";
      const visibility = definition.visible ? "visible" : "hidden";
      return `${marker} ${this.theme.fg("text", this.theme.bold(definition.name))}  ${this.theme.fg("dim", `${definition.source} · ${visibility}`)}`;
    });
  }

  private detailRows(): string[] {
    if (this.tab() === "running") {
      const job = this.data.running[this.selectedIndex()];
      if (!job) return ["Active jobs will appear here as they are queued."];
      return [
        `ID: ${job.id}`,
        `Task: ${sanitizeSubagentDisplay(job.details.task)}`,
        `Activity: ${latestToolCallSummary(job.details.timeline)}`,
        `Usage: ${job.details.usage.turns} turns · ${formatDuration(Date.now() - job.details.startedAt)}`,
      ];
    }
    if (this.tab() === "session") {
      const run = this.selectedRun();
      if (!run) return ["Completed and resumable V3 children are scoped to this parent session."];
      const current = run.agent?.name ? this.data.definitions.find((item) => item.name === run.agent?.name) : undefined;
      const currentHash = current ? promptDefinitionHash(current) : undefined;
      const originalHash = run.promptSnapshot.manifest.definitionHash;
      const drift = originalHash && currentHash ? (originalHash === currentHash ? "unchanged" : "changed") : "not comparable";
      return [
        `ID: ${run.id}`,
        `Task: ${sanitizeSubagentDisplay(run.task)}`,
        `Model: ${run.model ?? "inherited"}`,
        `Prompt: V${run.promptSnapshot.version} · ${drift}`,
        `Hash: ${(originalHash ?? run.promptSnapshot.manifest.effectiveSystemHash).slice(0, 16)}`,
      ];
    }
    const definition = this.selectedDefinition();
    if (!definition) return this.data.errors.slice(0, 4).concat("Create a project or agent definition with N.");
    const rows = [
      `Description: ${definition.description}`,
      `Model: ${definition.model ?? "inherit"} · Effort: ${definition.effort ?? "inherit"}`,
      `Parent system: ${definition.inheritParentSystem ? "inherit" : "isolated"}`,
      `Tools: ${definition.tools?.join(", ") || "default"}`,
      `Extensions: ${definition.extensionTools?.join(", ") || "none"}`,
      `Skills: ${definition.skills?.join(", ") || "all"}`,
      `Layers: ${definition.layers.map((layer) => layer.source).join(" → ")}`,
    ];
    for (const field of ["policy", "instructions", "output"] as const) {
      rows.push(`${field[0].toUpperCase() + field.slice(1)}: ${definition[field] ? "set" : "empty"} · ${definition.fieldSources[field]?.source ?? "default"}`);
    }
    return rows;
  }

  private footerText(): string {
    if (this.view.kind === "choice") {
      return `${keyHint("tui.select.confirm", "choose")} · ${keyHint("tui.select.cancel", "back")}`;
    }
    if (this.view.kind === "editor") {
      return `${keyHint("tui.select.confirm", this.view.submitLabel)} · ${this.theme.fg("dim", "shift+enter newline · ")}${keyHint("tui.select.cancel", "back")}`;
    }
    if (this.view.kind === "review") {
      return `${keyHint("tui.select.confirm", this.view.confirmLabel)} · ${this.theme.fg("dim", "↑/↓ scroll · ")}${keyHint("tui.select.cancel", "back")}`;
    }
    if (this.tab() === "running") return "enter cancel · ←/→ tabs · esc close";
    if (this.tab() === "session") {
      return this.runIsActive(this.selectedRun())
        ? "resume unavailable while active · f fresh · d delete history · ←/→ tabs · esc close"
        : "enter resume · f fresh · d delete history · ←/→ tabs · esc close";
    }
    return "enter edit · n new · h hide/show · d delete overlay · ←/→ tabs · esc close";
  }

  private header(width: number, eyebrow?: string, title?: string): string[] {
    const identity = `${this.theme.fg("accent", "●")} ${this.theme.fg("toolTitle", "Subagents")}`;
    if (eyebrow && title) {
      return [
        fit(`${identity}  ${this.theme.fg("dim", eyebrow)}`, width),
        fit(this.theme.fg("text", this.theme.bold(title)), width),
        fit(this.theme.fg("borderMuted", "─".repeat(width)), width),
      ];
    }
    const tabs = TABS.map((tab, index) => (
      index === this.tabIndex
        ? this.theme.fg("accent", this.theme.bold(tab.toUpperCase()))
        : this.theme.fg("dim", tab.toUpperCase())
    )).join(this.theme.fg("dim", "   "));
    return [
      fit(identity, width),
      fit(tabs, width),
      fit(this.theme.fg("borderMuted", "─".repeat(width)), width),
    ];
  }

  private footer(width: number): string[] {
    const lines: string[] = [];
    if (this.flash) {
      const color = this.flash.kind === "error" ? "error" : "success";
      const flashMarker = this.flash.kind === "error" ? "✗" : "✓";
      lines.push(fit(`${this.theme.fg(color, flashMarker)} ${this.theme.fg(color, this.flash.text)}`, width));
    }
    lines.push(fit(this.theme.fg("borderMuted", "─".repeat(width)), width));
    lines.push(fit(this.theme.fg("dim", this.footerText()), width));
    return lines;
  }

  private windowRows(rows: string[], selected: number, budget: number): string[] {
    if (rows.length <= budget) return rows;
    const start = Math.max(0, Math.min(selected - Math.floor(budget / 2), rows.length - budget));
    const visible = rows.slice(start, start + budget);
    if (start > 0) visible[0] = this.theme.fg("dim", `… ${start} earlier`);
    if (start + budget < rows.length) visible[visible.length - 1] = this.theme.fg("dim", `… ${rows.length - start - budget} later`);
    return visible;
  }

  private renderBrowse(width: number, bodyBudget: number): string[] {
    const listRows = this.listRows();
    const details = this.detailRows().flatMap((line) => wrap(line, Math.max(20, width - 2)));
    if (width >= 88) {
      const leftWidth = Math.min(40, Math.floor(width * 0.4));
      const rightWidth = width - leftWidth - 3;
      const list = this.windowRows(listRows, this.selectedIndex(), bodyBudget);
      const detail = details.flatMap((line) => wrap(line, rightWidth)).slice(0, bodyBudget);
      const rows: string[] = [];
      for (let index = 0; index < bodyBudget; index += 1) {
        if (index >= list.length && index >= detail.length) break;
        rows.push(`${fit(list[index] ?? "", leftWidth)} ${this.theme.fg("borderMuted", "│")} ${fit(detail[index] ?? "", rightWidth)}`);
      }
      return rows;
    }
    const listBudget = Math.max(3, Math.min(7, Math.floor(bodyBudget * 0.48)));
    const list = this.windowRows(listRows, this.selectedIndex(), listBudget).map((line) => fit(line, width));
    const detailBudget = Math.max(0, bodyBudget - list.length - 2);
    const output = [...list];
    if (detailBudget > 0) {
      output.push("", fit(`${this.theme.fg("muted", "Detail")} ${this.theme.fg("borderMuted", "─".repeat(Math.max(0, width - 7)))}`, width));
      output.push(...details.slice(0, detailBudget).map((line) => fit(line, width)));
    }
    return output.slice(0, bodyBudget);
  }

  private renderChoice(view: ChoiceView, width: number, bodyBudget: number): string[] {
    const output: string[] = [];
    if (view.description) output.push(...wrap(view.description, width).map((line) => this.theme.fg("dim", line)), "");
    const remaining = Math.max(2, bodyBudget - output.length);
    const rows = view.items.map((item, index) => {
      const marker = index === view.index ? this.theme.fg("accent", "›") : " ";
      const label = index === view.index ? this.theme.bold(item.label) : item.label;
      const detail = item.detail ? this.theme.fg("dim", `  ${sanitizeSubagentDisplay(item.detail)}`) : "";
      return `${marker} ${this.theme.fg("text", label)}${detail}`;
    });
    output.push(...this.windowRows(rows, view.index, remaining).map((line) => fit(line, width)));
    return output.slice(0, bodyBudget);
  }

  private renderEditor(view: EditorView, width: number, bodyBudget: number): string[] {
    const output: string[] = [];
    if (view.description) output.push(...wrap(view.description, width).map((line) => this.theme.fg("dim", line)), "");
    output.push(`${this.theme.fg("muted", "INPUT")} ${this.theme.fg("borderMuted", "─".repeat(Math.max(0, width - 6)))}`);
    const editorBudget = Math.max(3, bodyBudget - output.length - (view.error ? 1 : 0));
    const editorLines = view.editor.render(width);
    output.push(...editorLines.slice(Math.max(0, editorLines.length - editorBudget)));
    if (view.error) output.push(this.theme.fg("error", view.error));
    return output.slice(0, bodyBudget).map((line) => fit(line, width));
  }

  private renderReview(view: ReviewView, width: number, bodyBudget: number): string[] {
    const wrapped = view.lines.flatMap((line) => wrap(sanitizeSubagentDisplay(line), width));
    const maxScroll = Math.max(0, wrapped.length - bodyBudget);
    view.scroll = Math.min(view.scroll, maxScroll);
    const visible = wrapped.slice(view.scroll, view.scroll + bodyBudget);
    if (view.scroll > 0 && visible.length > 0) visible[0] = this.theme.fg("dim", `… ${view.scroll} earlier lines`);
    if (view.scroll + bodyBudget < wrapped.length && visible.length > 0) {
      visible[visible.length - 1] = this.theme.fg("dim", `… ${wrapped.length - view.scroll - bodyBudget} later lines`);
    }
    const color = view.destructive ? "warning" : "text";
    return visible.map((line) => fit(this.theme.fg(color, line), width));
  }

  render(terminalWidth: number): string[] {
    const width = managerPanelWidth(terminalWidth);
    const maxRows = managerRowBudget(Number(this.tui.terminal?.rows) || 24);
    const view = this.view;
    const header = view.kind === "browse" ? this.header(width) : this.header(width, view.eyebrow, view.title);
    const footer = this.footer(width);
    const bodyBudget = Math.max(3, maxRows - header.length - footer.length);
    let body: string[];
    if (view.kind === "browse") body = this.renderBrowse(width, bodyBudget);
    else if (view.kind === "choice") body = this.renderChoice(view, width, bodyBudget);
    else if (view.kind === "editor") body = this.renderEditor(view, width, bodyBudget);
    else body = this.renderReview(view, width, bodyBudget);
    while (body.length < Math.min(3, bodyBudget)) body.push("");
    return [...header, ...body, ...footer].slice(0, maxRows).map((line) => fit(line, width));
  }

  handleInput(data: string): void {
    if (this.finished) return;
    if (this.view.kind === "editor") {
      if (this.keybindings.matches(data, "tui.select.cancel")) this.back();
      else this.view.editor.handleInput(data);
      this.tui.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.back();
      return;
    }
    if (this.view.kind === "choice") {
      if (this.keybindings.matches(data, "tui.select.up")) {
        this.view.index = (this.view.index - 1 + this.view.items.length) % this.view.items.length;
      } else if (this.keybindings.matches(data, "tui.select.down")) {
        this.view.index = (this.view.index + 1) % this.view.items.length;
      } else if (this.keybindings.matches(data, "tui.select.confirm")) {
        this.view.items[this.view.index]?.onSelect();
      }
      this.tui.requestRender();
      return;
    }
    if (this.view.kind === "review") {
      if (this.keybindings.matches(data, "tui.select.up") || matchesKey(data, "pageUp")) {
        this.view.scroll = Math.max(0, this.view.scroll - (matchesKey(data, "pageUp") ? 5 : 1));
      } else if (this.keybindings.matches(data, "tui.select.down") || matchesKey(data, "pageDown")) {
        this.view.scroll += matchesKey(data, "pageDown") ? 5 : 1;
      } else if (this.keybindings.matches(data, "tui.select.confirm")) {
        this.view.onConfirm();
      }
      this.tui.requestRender();
      return;
    }

    if (this.keybindings.matches(data, "tui.select.up")) return this.move(-1);
    if (this.keybindings.matches(data, "tui.select.down")) return this.move(1);
    if (matchesKey(data, "left") || matchesKey(data, "shift+tab")) return this.switchTab(-1);
    if (matchesKey(data, "right") || matchesKey(data, "tab")) return this.switchTab(1);
    if (this.keybindings.matches(data, "tui.select.confirm")) return this.activate();

    if (this.tab() === "session") {
      const run = this.selectedRun();
      if (matchesKey(data, "f") && run) return this.openTask("fresh", run);
      if (matchesKey(data, "d") && run) return this.confirmHistoryDelete(run);
    }
    if (this.tab() === "definitions") {
      const definition = this.selectedDefinition();
      if (matchesKey(data, "n")) return this.createDefinition();
      if (matchesKey(data, "h") && definition) return this.toggleDefinition(definition);
      if (matchesKey(data, "d") && definition) return this.deleteDefinition(definition);
    }
  }

  invalidate(): void {
    if (this.view.kind === "editor") this.view.editor.invalidate();
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribeMotion?.();
  }
}

async function openManager(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  state: SubagentRuntimeState,
  runtime?: DisplayRuntimeProvider,
): Promise<void> {
  const parentSessionId = String(ctx.sessionManager?.getSessionId?.() ?? "").trim();
  if (!parentSessionId) {
    ctx.ui.notify("The current Pi session has no stable ID; subagent manager is unavailable.", "error");
    return;
  }
  state.refresh?.(ctx.cwd);
  const services = createProductionServices(pi, ctx, state, parentSessionId, runtime);
  await ctx.ui.custom<void>((tui, theme, keybindings, done) => (
    new SubagentManager(snapshot(state, parentSessionId), tui, theme, keybindings, done, services)
  ));
}

export function registerSubagentManager(
  pi: ExtensionAPI,
  state: SubagentRuntimeState,
  runtime?: DisplayRuntimeProvider,
): void {
  pi.registerMessageRenderer(SUBAGENT_CONFIG_GUIDE_TYPE, renderSubagentConfigGuide);
  pi.registerCommand("subagent", {
    description: "Manage current-session subagents and V2 definitions, or ask Pi to modify configuration.",
    handler: async (args, ctx) => {
      const request = String(args ?? "").trim();
      state.refresh?.(ctx.cwd);
      if (request) {
        const guide = buildSubagentConfigGuide(state.registry, ctx.cwd);
        pi.sendMessage({
          customType: SUBAGENT_CONFIG_GUIDE_TYPE,
          content: guide.content,
          display: true,
          details: guide.details,
        }, { deliverAs: "followUp" });
        pi.sendUserMessage(request, { deliverAs: "followUp" });
        return;
      }
      if (!ctx.hasUI) return;
      await openManager(pi, ctx, state, runtime);
    },
  });
}

export const __testables = {
  SubagentManager,
  displayValue,
  managerPanelWidth,
  managerRowBudget,
  snapshot,
};
