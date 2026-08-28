/**
 * `/shadow` manager view (odradekk/pi-square#149, slices #153–#155;
 * read-only definitions window since #190).
 *
 * A focus-preserving, non-overlay TUI view that inspects every effective
 * Shadow definition with its layer provenance, full source paths, and the
 * copyable file-edit / `/shadow <request>` hint — configuration changes go
 * through the natural-language Guide and ordinary file tools, never here.
 * Runtime services add manual trials across the Shadow-safe read-only
 * evidence catalog (including no-tool trials), with a bounded one-time note,
 * live run observation with cancellation, run and scheduling views, and
 * result-inbox inspection (read, dismiss, delete, explicit send). The view
 * follows the shared operational grammar: one-cell status rail, label-led
 * rows, muted borders, no emoji.
 */

import {
  getSelectListTheme,
  keyHint,
  type ExtensionCommandContext,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import { Editor, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type Focusable, type TUI } from "@earendil-works/pi-tui";
import { DEFAULT_SHADOW_MINDS, type ShadowMindsDefaults } from "../core/config";
import { sanitizeDisplayLine, sanitizeDisplayText } from "../display/sanitize";
import { shadowDefinitionContextFingerprint } from "./definitions";
import type { EffectiveShadowDefinition, ShadowDefinitionRegistry } from "./definitions";
import { canonicalPayloadJson, type ShadowResultEntity } from "./result";
import { SHADOW_MANUAL_NOTE_MAX_CHARS, type ShadowRunView, type ShadowRuntimeSnapshot } from "./runtime";
import { summarizeShadowUsage } from "./diagnostics";
import type { ShadowSchedulerSnapshot } from "./scheduler";

const LIST_WIDTH = 34;
const BODY_PREVIEW_LINES = 8;
const DIAGNOSTIC_LINES = 4;
const RESULT_PAYLOAD_PREVIEW_CHARS = 2_000;

/** Snapshot the view renders; refresh comes from the owning feature state. */
export interface ShadowManagerSnapshot {
  definitions: EffectiveShadowDefinition[];
  invalid: ShadowDefinitionRegistry["invalid"];
  diagnostics: ShadowDefinitionRegistry["diagnostics"];
  /** Effective feature configuration; absent when unknown at open time. */
  config?: { enabled: boolean; defaults: ShadowMindsDefaults };
}

/** Session runtime operations surfaced in the manager (#155). */
export interface ShadowRuntimeServices {
  snapshot(): ShadowRuntimeSnapshot;
  /** Starts one manual run for an effective definition; never throws. */
  runManual(input: {
    shadowId: string;
    note?: string;
    definitionFingerprint?: string;
    defaultThinking?: string;
    timeoutSeconds?: number;
    maxTurns?: number;
    maxToolCalls?: number;
  }): { ok: boolean; message: string };
  cancelRun(runId: string): { ok: boolean; message?: string };
  markResultRead(id: string): boolean;
  dismissResult(id: string): boolean;
  deleteResult(id: string): boolean;
  subscribe(listener: () => void): () => void;
}

/** Deterministic scheduling controls and bounded visibility. */
export interface ShadowSchedulerServices {
  snapshot(): ShadowSchedulerSnapshot;
  pause(): void;
  resume(): void;
}

/** Confirmed delivery actions reachable from the manager (#159). */
export interface ShadowDeliveryServices {
  /** Promotes one inbox result to the parent agent through the confirmed machine. */
  sendResultToAgent(id: string): { ok: boolean; message: string };
  /** Sends one failed run's bounded summary; never automatic. */
  sendErrorSummary(runId: string): { ok: boolean; message: string };
}

export interface ShadowManagerServices {
  runtime?: ShadowRuntimeServices;
  scheduler?: ShadowSchedulerServices;
  delivery?: ShadowDeliveryServices;
}

export function snapshot(
  registry: ShadowDefinitionRegistry,
  config?: { enabled: boolean; defaults: ShadowMindsDefaults },
): ShadowManagerSnapshot {
  return {
    definitions: registry.definitions,
    invalid: registry.invalid,
    diagnostics: registry.diagnostics,
    ...(config ? { config } : {}),
  };
}

function resultSourceLabel(result: ShadowResultEntity): string {
  return result.source === "automatic"
    ? `automatic:${result.primaryTrigger ?? "trigger"}${result.taskIdentity ? ` task ${result.taskIdentity.epoch}` : ""}`
    : "manual";
}

/** Human delivery-state marker for inbox rows and result headers. */
function deliveryLabel(delivery: ShadowResultEntity["delivery"]): string {
  if (delivery === "delivered") return "delivered";
  if (delivery === "pending") return "sending";
  return "inbox";
}

function fit(line: string, width: number): string {
  return truncateToWidth(line, Math.max(1, width), "…", true);
}

function clip(text: string, max: number): string {
  const normalized = sanitizeDisplayLine(text).replace(/\s+/g, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}

interface ChoiceItem {
  id: string;
  label: string;
  detail?: string;
  onSelect(): void;
}

interface ChoiceView {
  kind: "choice";
  eyebrow: string;
  title: string;
  description?: string;
  items: ChoiceItem[];
  index: number;
  /** Live-rebuild scope: runtime state changes refresh the item list. */
  refresh?: "runs" | "inbox";
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

type ManagerView = { kind: "browse" } | ChoiceView | EditorView | ReviewView;

interface InvalidEntry {
  id: string;
  invalid: ShadowDefinitionRegistry["invalid"][number];
}

export class ShadowManager implements Component, Focusable {
  private _focused = false;
  private index = 0;
  private readonly entries: (EffectiveShadowDefinition | InvalidEntry)[];
  private view: ManagerView = { kind: "browse" };
  private history: ManagerView[] = [];
  private flash?: { kind: "success" | "error"; text: string };
  private finished = false;
  private readonly unsubscribeRuntime?: () => void;

  constructor(
    private data: ShadowManagerSnapshot,
    private readonly tui: TUI,
    private readonly theme: any,
    private readonly keybindings: KeybindingsManager,
    private readonly done: () => void,
    private readonly services?: ShadowManagerServices,
  ) {
    this.entries = [
      ...data.definitions,
      ...data.invalid.map((entry) => ({ id: entry.id, invalid: entry })),
    ];
    this.unsubscribeRuntime = services?.runtime?.subscribe(() => {
      this.refreshRuntimeViews();
      this.tui.requestRender();
    });
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    if (this.view.kind === "editor") this.view.editor.focused = value;
  }

  invalidate(): void {
    if (this.view.kind === "editor") this.view.editor.invalidate();
  }

  private count(): number {
    return this.entries.length;
  }

  private selected(): EffectiveShadowDefinition | InvalidEntry | undefined {
    return this.entries[this.index];
  }

  private move(delta: number): void {
    const count = this.count();
    if (count === 0) return;
    this.index = (this.index + delta + count) % count;
    this.tui.requestRender();
  }

  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.unsubscribeRuntime?.();
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

  private errorFlash(text: string): void {
    this.flash = { kind: "error", text };
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

  private activate(): void {
    const selected = this.selected();
    if (!selected) return;
    if ("invalid" in selected) {
      this.openReview({
        eyebrow: "DEFINITIONS / INVALID",
        title: `${selected.id} — excluded from activation`,
        lines: [
          "SOURCES",
          ...selected.invalid.sources,
          "",
          "ERRORS",
          ...selected.invalid.errors,
          "",
          "Repair the file directly or ask through /shadow <request>; reopen /shadow to refresh.",
        ],
        confirmLabel: "back",
        onConfirm: () => this.back(),
      });
      return;
    }
    this.openChoice({
      eyebrow: "DEFINITIONS / ACTIONS",
      title: `${selected.id} · ${selected.name}`,
      description: "Configuration changes go through ordinary file edits or /shadow <request>; the manager stays read-only.",
      items: [
        {
          id: "run-manually",
          label: "Run manually",
          detail: `${toolsLabel(selected)} · ${runBoundLabel(runBounds(selected, this.data.config?.defaults))}`,
          onSelect: () => this.runManually(selected),
        },
        {
          id: "view-definition",
          label: "View definition",
          detail: "Full body, layers, and provenance",
          onSelect: () => this.viewDefinition(selected),
        },
      ],
    });
  }

  /** Scrollable read-only inspection of one effective definition (#190). */
  private viewDefinition(definition: EffectiveShadowDefinition): void {
    const lines: string[] = [
      `Name: ${definition.name}`,
      `ID: ${definition.id}`,
      `State: ${definition.enabled ? "enabled" : "disabled"}${definition.hidden ? " · hidden" : ""}`,
      `Triggers: ${definition.triggers.length > 0 ? definition.triggers.join(", ") : "manual only"}`,
      `Delivery: ${definition.delivery}${definition.completionGate ? " · completion gate" : ""}`,
      `Priority: ${definition.priority}`,
      `Tools: ${toolLabel(definition)}`,
    ];
    if (definition.model) lines.push(`Model: ${definition.model}`);
    if (definition.thinking) lines.push(`Thinking: ${definition.thinking}`);
    const instructionKeys = Object.keys(definition.triggerInstructions);
    if (instructionKeys.length > 0) {
      lines.push("", "TRIGGER INSTRUCTIONS");
      for (const key of instructionKeys) {
        lines.push(`${key}: ${definition.triggerInstructions[key as keyof typeof definition.triggerInstructions] ?? ""}`);
      }
    }
    lines.push("", "LAYERS");
    for (const layer of definition.layers) {
      lines.push(`${layer.scope}: ${layer.filePath} (${layer.contentHash.slice(0, 8)})`);
    }
    lines.push("", "PROVENANCE");
    const sourceKeys = Object.keys(definition.fieldSources);
    for (const key of sourceKeys) {
      const source = definition.fieldSources[key as keyof typeof definition.fieldSources];
      lines.push(`${key}: ${source?.scope ?? "default"}`);
    }
    lines.push("", "BODY");
    lines.push(...definition.body.replace(/\r/g, "").split("\n"));
    lines.push("", `Edit: ${definition.layers.at(-1)?.filePath ?? "(no layer)"} · or /shadow <request>`);
    this.openReview({
      eyebrow: "DEFINITIONS / VIEW",
      title: `${definition.id} · ${definition.name}`,
      lines,
      confirmLabel: "back",
      onConfirm: () => this.back(),
    });
  }

  // ── Manual runs and inbox ────────────────────────────────────────────

  private runManually(definition: EffectiveShadowDefinition): void {
    const runtime = this.services?.runtime;
    if (!runtime) {
      this.errorFlash("Manual runs are unavailable in this session.");
      return;
    }
    if (this.data.config && !this.data.config.enabled) {
      this.errorFlash("Shadow Minds is disabled by the master switch; enable it in agent config to run trials.");
      return;
    }
    this.openEditor({
      eyebrow: "RUN / NOTE",
      title: `Run ${definition.id} manually`,
      description: `Optional one-time note for this run only (at most ${SHADOW_MANUAL_NOTE_MAX_CHARS.toLocaleString("en-US")} characters). Empty runs without a note.`,
      submitLabel: "review run",
      validate: (value) => (value.length > SHADOW_MANUAL_NOTE_MAX_CHARS
        ? `The note must stay within ${SHADOW_MANUAL_NOTE_MAX_CHARS.toLocaleString("en-US")} characters.`
        : undefined),
      onSubmit: (noteValue) => {
        const note = noteValue.trim();
        const bounds = runBounds(definition, this.data.config?.defaults);
        const definitionFingerprint = shadowDefinitionContextFingerprint(definition.layers);
        this.openReview({
          eyebrow: "RUN / REVIEW",
          title: `Start ${definition.id} manual run?`,
          lines: [
            `Definition: ${definition.name} (${definition.id})`,
            `Tools: ${toolsLabel(definition)}`,
            `Bounds: ${runBoundLabel(bounds)}`,
            `Thinking: ${definition.thinking ?? this.data.config?.defaults.thinking ?? "inherit parent"}`,
            `Evidence: the current parent trajectory, reference only`,
            ...(note ? ["", "MANUAL NOTE", note] : []),
          ],
          confirmLabel: "start run",
          onConfirm: () => {
            this.finish();
            const outcome = this.services?.runtime?.runManual({
              shadowId: definition.id,
              definitionFingerprint,
              ...(this.data.config?.defaults.thinking ? { defaultThinking: this.data.config.defaults.thinking } : {}),
              ...bounds,
              ...(note ? { note } : {}),
            });
            // The manager has closed itself; the owning service reports the
            // outcome through the session notify surface.
            void outcome;
          },
        });
      },
    });
  }

  private openRunsEntry(): void {
    if (!this.services?.runtime) {
      this.errorFlash("Manual runs are unavailable in this session.");
      return;
    }
    const snapshot = this.services.runtime.snapshot();
    const running = snapshot.runs.filter((run) => run.phase === "running").length;
    const unread = snapshot.results.filter((result) => result.attention === "unread").length;
    this.openChoice({
      eyebrow: "RUNS / INBOX",
      title: "Shadow runs and results",
      description: "Manual trials, their terminal outcomes, and the session result inbox.",
      items: [
        {
          id: "runs",
          label: "Runs",
          detail: `${running} running · ${snapshot.runs.length - running} settled`,
          onSelect: () => this.openRunsList(),
        },
        {
          id: "inbox",
          label: "Inbox",
          detail: `${snapshot.results.length} results · ${unread} unread${(snapshot.evictionEvents?.length ?? 0) > 0 ? ` · ${snapshot.evictionEvents!.length} eviction events` : ""}`,
          onSelect: () => this.openInboxList(),
        },
        {
          id: "diagnostics",
          label: "Diagnostics",
          detail: `${snapshot.runs.length} runs · ${snapshot.runs.reduce((sum, run) => sum + (run.requests?.length ?? 0), 0)} requests`,
          onSelect: () => this.openDiagnostics(),
        },
      ],
    });
  }

  /** Bounded aggregate usage and cache diagnostics; hashes and counts only. */
  private openDiagnostics(): void {
    if (!this.services?.runtime) {
      this.errorFlash("Diagnostics are unavailable in this session.");
      return;
    }
    const summary = summarizeShadowUsage(this.services.runtime.snapshot().runs);
    const lines: string[] = [];
    lines.push(
      `Runs: ${summary.runs} (${summary.running} running · ${summary.settled} settled) · requests ${summary.requests} · turns ${summary.turns} · tool calls ${summary.toolCalls}`,
    );
    lines.push(
      `Tokens: in ${summary.input} · out ${summary.output} · cost ${summary.cost.toFixed(4)}`,
    );
    if (summary.ttft.count > 0) {
      lines.push(
        `TTFT: ${summary.ttft.count} observed · min ${summary.ttft.minMs}ms · avg ${summary.ttft.avgMs}ms · max ${summary.ttft.maxMs}ms`,
      );
    }
    lines.push(
      "",
      "CACHE",
      `Provider-reported: ${summary.cache.reportedRequests} of ${summary.cache.requests} requests`,
    );
    if (summary.cache.reportedRequests > 0) {
      lines.push(`Measured read: ${summary.cache.cacheRead} · write: ${summary.cache.cacheWrite}`);
    }
    lines.push("Cache reuse is measured and best-effort; providers do not guarantee it.");
    lines.push("", "COHORTS");
    if (summary.cohorts.length === 0) {
      lines.push(`No cohort hashes recorded (${summary.runsWithoutCohorts} runs).`);
    } else {
      for (const group of summary.cohorts) {
        const cache = group.cache.reportedRequests > 0
          ? ` · cache r ${group.cache.cacheRead}/w ${group.cache.cacheWrite}`
          : "";
        lines.push(`${group.size} run${group.size === 1 ? "" : "s"} · ${sanitizeDisplayLine(group.label)}${cache}`);
      }
    }
    this.openReview({
      eyebrow: "RUNS / DIAGNOSTICS",
      title: "Shadow usage and cache diagnostics",
      lines,
      confirmLabel: "back",
      onConfirm: () => this.back(),
    });
  }

  private buildRunItems(): ChoiceItem[] {
    const runtime = this.services?.runtime;
    if (!runtime) return [];
    return runtime.snapshot().runs.slice(0, 12).map((run) => ({
      id: run.id,
      label: `${sanitizeDisplayLine(run.shadowName)} (${sanitizeDisplayLine(run.shadowId)})`,
      detail: sanitizeDisplayLine(runDetailLabel(run)),
      onSelect: () => this.openRunDetail(run.id),
    }));
  }

  private openRunsList(): void {
    const items = this.buildRunItems();
    const scheduler = this.services?.scheduler;
    const pauseItems: ChoiceItem[] = [];
    if (scheduler) {
      const paused = scheduler.snapshot().paused;
      pauseItems.push({
        id: paused ? "resume" : "pause",
        label: paused ? "Resume automatic Shadows" : "Pause automatic Shadows",
        detail: paused
          ? "Automatic triggers resume; paused events are not replayed"
          : "Cancel automatic runs and block new automatic work; manual trials stay available",
        onSelect: () => {
          if (paused) scheduler.resume();
          else scheduler.pause();
          this.flash = { kind: "success", text: paused ? "Automatic Shadows resumed." : "Automatic Shadows paused." };
          this.refreshRuntimeViews();
          this.openRunsList();
          this.tui.requestRender();
        },
      });
      const pending = scheduler.snapshot().pending.slice(0, 8).map((activation) => ({
        id: `pending-${activation.shadowId}`,
        label: `Queued: ${sanitizeDisplayLine(activation.shadowId)}`,
        detail: sanitizeDisplayLine(
          `${activation.bestTrigger} · task ${activation.taskEpoch} · ${activation.reasons.map((reason) => reason.trigger).join(", ")}`,
        ),
        onSelect: () => {},
      }));
      // Enforcement events stay visible: clipped queue entries, exhausted
      // budgets, preemptions, and interruption/pause diagnostics.
      const schedSnap = scheduler.snapshot();
      const diagnostics: ChoiceItem[] = [];
      if (schedSnap.diagnostics.length > 0 || schedSnap.clippedIds.length > 0) {
        diagnostics.push({
          id: "scheduling-diagnostics",
          label: "Scheduling notes",
          detail: `${schedSnap.diagnostics.length} note${schedSnap.diagnostics.length === 1 ? "" : "s"} · ${schedSnap.clippedIds.length} clipped`,
          onSelect: () => {
            this.openReview({
              eyebrow: "RUNS / SCHEDULING",
              title: "Scheduling notes",
              lines: [
                ...(schedSnap.diagnostics.length > 0
                  ? ["NOTES", ...schedSnap.diagnostics.slice(-8).map((line) => sanitizeDisplayLine(line))]
                  : []),
                ...(schedSnap.clippedIds.length > 0
                  ? ["", "CLIPPED QUEUE ENTRIES", ...schedSnap.clippedIds.slice(-8).map((id) => sanitizeDisplayLine(id))]
                  : []),
                ...schedSnap.automaticStartsByTask.map((entry) => `Task ${entry.epoch}: ${entry.starts} automatic starts`),
              ],
              confirmLabel: "back",
              onConfirm: () => this.back(),
            });
          },
        });
      }
      items.unshift(...pauseItems, ...pending, ...diagnostics);
    }
    this.openChoice({
      eyebrow: "RUNS / LIST",
      title: items.length > 0 ? "Select a run" : "No runs yet",
      description: items.length > 0 ? undefined : "Start one from a definition's actions menu.",
      items: items.length > 0 ? items : [{ id: "empty", label: "(none)", onSelect: () => {} }],
      refresh: "runs",
    });
  }

  private openRunDetail(runId: string): void {
    const runtime = this.services?.runtime;
    const run = runtime?.snapshot().runs.find((entry) => entry.id === runId);
    if (!runtime || !run) {
      this.errorFlash("That run is no longer available.");
      return;
    }
    const items: ChoiceItem[] = [];
    if (run.phase === "running") {
      items.push({
        id: "cancel",
        label: "Cancel run",
        detail: "Abort this manual trial",
        onSelect: () => {
          const outcome = this.services!.runtime!.cancelRun(runId);
          if (outcome.ok) this.flash = { kind: "success", text: "Cancellation requested." };
          else this.errorFlash(outcome.message ?? "That run is no longer active.");
          this.refreshRuntimeViews();
          this.tui.requestRender();
        },
      });
    }
    if (run.resultId) items.push({
      id: "result",
      label: "View result",
      detail: "Open the inbox entry this run produced",
      onSelect: () => this.openResultActions(run.resultId!),
    });
    if (run.phase === "error" && this.services?.delivery) {
      items.push({
        id: "send-failure-summary",
        label: "Send failure summary",
        detail: "Deliver a bounded summary of this infrastructure failure to the agent",
        onSelect: () => {
          const outcome = this.services!.delivery!.sendErrorSummary(runId);
          if (outcome.ok) this.flash = { kind: "success", text: outcome.message };
          else this.errorFlash(outcome.message);
          this.tui.requestRender();
        },
      });
    }
    this.openChoice({
      eyebrow: "RUNS / DETAIL",
      title: `${sanitizeDisplayLine(run.shadowName)} · ${run.phase}`,
      description: sanitizeDisplayLine(runDetailLabel(run)),
      items: [
        ...(items.length > 0 ? items : [{ id: "empty" as const, label: "No actions for a settled run without a result.", onSelect: () => {} }]),
        {
          id: "run-facts",
          label: "Facts",
          detail: runFactsDetail(run),
          onSelect: () => {
            this.openReview({
              eyebrow: "RUNS / FACTS",
              title: `${run.shadowId} run facts`,
              lines: runFactsLines(run),
              confirmLabel: "back",
              onConfirm: () => this.back(),
            });
          },
        },
      ],
    });
  }

  private buildInboxItems(): ChoiceItem[] {
    const runtime = this.services?.runtime;
    if (!runtime) return [];
    const snapshot = runtime.snapshot();
    const results = snapshot.results.slice(0, 20).map((result) => ({
      id: result.id,
      label: sanitizeDisplayLine(result.summary || result.shadowName),
      detail: [
        sanitizeDisplayLine(result.shadowId),
        resultSourceLabel(result),
        result.attention,
        deliveryLabel(result.delivery),
      ].join(" · "),
      onSelect: () => this.openResultActions(result.id),
    }));
    const events = (snapshot.evictionEvents ?? []).slice(-5).reverse().map((event) => ({
      id: `eviction-${event.at}-${event.id}`,
      label: `Evicted result ${sanitizeDisplayLine(event.id)}`,
      detail: `${event.reason} retention · ${new Date(event.at).toISOString()}`,
      onSelect: () => {},
    }));
    return [...results, ...events];
  }

  private openInboxList(): void {
    const items = this.buildInboxItems();
    this.openChoice({
      eyebrow: "INBOX / LIST",
      title: items.length > 0 ? "Select a result" : "Inbox is empty",
      description: items.length > 0 ? undefined : "A schema-valid manual submission lands here.",
      items: items.length > 0 ? items : [{ id: "empty", label: "(none)", onSelect: () => {} }],
      refresh: "inbox",
    });
  }

  private openResultActions(resultId: string): void {
    const runtime = this.services?.runtime;
    const result = runtime?.snapshot().results.find((entry) => entry.id === resultId);
    if (!runtime || !result) {
      this.errorFlash("That result is no longer available.");
      return;
    }
    const act = (action: () => boolean, success: string) => {
      const ok = action();
      if (ok) this.flash = { kind: "success", text: success };
      else this.errorFlash("That result is no longer available.");
      this.refreshRuntimeViews();
      this.tui.requestRender();
    };
    const sendItem = this.services?.delivery && result.delivery === "notified"
      ? [{
          id: "send",
          label: "Send to agent",
          detail: "Deliver this result to the parent agent as advisory evidence",
          onSelect: () => {
            const outcome = this.services!.delivery!.sendResultToAgent(resultId);
            if (outcome.ok) this.flash = { kind: "success", text: outcome.message };
            else this.errorFlash(outcome.message);
            this.refreshRuntimeViews();
            this.tui.requestRender();
          },
        }]
      : [];
    this.openChoice({
      eyebrow: "INBOX / RESULT",
      title: sanitizeDisplayLine(result.summary || result.shadowName),
      description: `${sanitizeDisplayLine(result.shadowName)} (${sanitizeDisplayLine(result.shadowId)}) · ${resultSourceLabel(result)} · ${result.attention} · ${deliveryLabel(result.delivery)}`,
      items: [
        ...sendItem,
        {
          id: "payload",
          label: "View payload",
          detail: "The validated submitted JSON",
          onSelect: () => this.openResultPayload(result),
        },
        {
          id: "read",
          label: "Mark read",
          detail: "Keep the result, clear the unread marker",
          onSelect: () => act(() => this.services!.runtime!.markResultRead(resultId), "Marked read."),
        },
        {
          id: "dismiss",
          label: "Dismiss",
          detail: "Collapse it from the unread view; the payload stays until deleted",
          onSelect: () => act(() => this.services!.runtime!.dismissResult(resultId), "Dismissed."),
        },
        {
          id: "delete",
          label: "Delete",
          detail: "Remove the result from this session inbox",
          onSelect: () => act(() => this.services!.runtime!.deleteResult(resultId), "Deleted."),
        },
      ],
    });
  }

  private openResultPayload(result: ShadowResultEntity): void {
    let payloadText: string;
    try {
      payloadText = canonicalPayloadJson(result.payload, 2) || "(null)";
    } catch {
      payloadText = "(unserializable payload)";
    }
    const bounded = payloadText.length > RESULT_PAYLOAD_PREVIEW_CHARS
      ? `${payloadText.slice(0, RESULT_PAYLOAD_PREVIEW_CHARS)}\n… truncated`
      : payloadText;
    this.openReview({
      eyebrow: "INBOX / PAYLOAD",
      title: `${result.shadowId} result`,
      lines: [
        `Submitted: ${new Date(result.createdAt).toISOString()}`,
        ...(result.model ? [`Model: ${result.model}`] : []),
        ...(result.usage ? [`Usage: ${result.usage.turns} turns · ${result.usage.input}/${result.usage.output} tokens`] : []),
        "",
        "PAYLOAD",
        ...bounded.split("\n"),
      ],
      confirmLabel: "done",
      onConfirm: () => this.back(),
    });
  }

  /** Rebuilds live run/inbox item lists after runtime state changes. */
  private refreshRuntimeViews(): void {
    const views = [this.view, ...this.history];
    for (const view of views) {
      if (view.kind !== "choice" || !view.refresh) continue;
      if (view.refresh === "runs") view.items = this.buildRunItems();
      else view.items = this.buildInboxItems();
      if (view.items.length === 0) view.items = [{ id: "empty", label: "(none)", onSelect: () => {} }];
      view.index = Math.min(view.index, Math.max(0, view.items.length - 1));
    }
  }

  // ── Input ────────────────────────────────────────────────────────────

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
      if (this.keybindings.matches(data, "tui.select.up")) {
        this.view.scroll = Math.max(0, this.view.scroll - 1);
      } else if (this.keybindings.matches(data, "tui.select.down")) {
        this.view.scroll += 1;
      } else if (this.keybindings.matches(data, "tui.select.confirm")) {
        this.view.onConfirm();
      }
      this.tui.requestRender();
      return;
    }

    if (this.keybindings.matches(data, "tui.select.up")) return this.move(-1);
    if (this.keybindings.matches(data, "tui.select.down")) return this.move(1);
    if (this.keybindings.matches(data, "tui.select.confirm")) return this.activate();
    if (matchesKey(data, "r") && this.services?.runtime) return this.openRunsEntry();
    if (matchesKey(data, "q")) return this.finish();
  }

  // ── Rendering ────────────────────────────────────────────────────────

  render(terminalWidth: number): string[] {
    const width = Math.max(1, terminalWidth);
    if (this.view.kind !== "browse") return this.renderSubView(this.view, width);
    const lines: string[] = [];
    const identity = `${this.theme.fg("accent", "●")} ${this.theme.fg("toolTitle", "Shadows")}`;
    if (this.data.config) {
      const config = this.data.config;
      if (!config.enabled) {
        lines.push(fit(`${identity}  ${this.theme.fg("dim", "disabled by master switch")}`, width));
      } else {
        lines.push(fit(`${identity}  ${this.theme.fg("dim", "enabled")}`, width));
      }
      lines.push(fit(this.theme.fg("muted", `CONFIG: ${configSummary(config)}`), width));
    } else {
      const state = this.data.definitions.every((definition) => !definition.enabled)
        ? this.theme.fg("dim", "disabled by default")
        : this.theme.fg("dim", `${this.data.definitions.filter((definition) => definition.enabled).length} enabled`);
      lines.push(fit(`${identity}  ${state}`, width));
    }
    lines.push(fit(this.theme.fg("dim", "DEFINITIONS"), width));
    lines.push(fit(this.theme.fg("borderMuted", "─".repeat(width)), width));

    if (this.count() === 0) {
      lines.push(fit(this.theme.fg("dim", "No Shadow definitions discovered."), width));
    }

    if (width < 64) {
      lines.push(...this.renderList(Math.max(1, width)));
      const detail = this.renderDetail(Math.max(1, width));
      if (detail.length > 0) {
        lines.push(fit(this.theme.fg("borderMuted", "─".repeat(width)), width));
        lines.push(...detail.map((line) => fit(line, width)));
      }
    } else {
      const listWidth = Math.min(LIST_WIDTH, Math.max(20, Math.floor(width * 0.4)));
      const detailWidth = Math.max(20, width - listWidth - 3);
      const detail = this.renderDetail(detailWidth);
      const listLines = this.renderList(listWidth - 2);
      const rows = Math.max(listLines.length, detail.length);
      for (let row = 0; row < rows; row += 1) {
        const left = listLines[row] ?? "";
        const pad = " ".repeat(Math.max(1, listWidth - plainLength(left)));
        lines.push(fit(`${left}${pad}${this.theme.fg("borderMuted", "│")} ${detail[row] ?? ""}`, width));
      }
    }
    const diagnostics = this.renderDiagnostics(width);
    if (diagnostics.length > 0) {
      lines.push(fit(this.theme.fg("borderMuted", "─".repeat(width)), width));
      lines.push(...diagnostics);
    }

    lines.push(fit(this.theme.fg("borderMuted", "─".repeat(width)), width));
    if (this.flash) {
      const color = this.flash.kind === "error" ? "error" : "success";
      const marker = this.flash.kind === "error" ? "✗" : "✓";
      lines.push(fit(`${this.theme.fg(color, marker)} ${this.theme.fg(color, this.flash.text)}`, width));
    }
    const runtimeHint = this.services?.runtime ? " · r runs" : "";
    lines.push(
      fit(
        `${keyHint("tui.select.up", "↑/↓")} select · ${keyHint("tui.select.confirm", "enter")} actions${runtimeHint} · ${keyHint("tui.select.cancel", "esc")} close`,
        width,
      ),
    );
    return lines;
  }

  /** Terminal rows available to a sub-view body, mirroring the manager budget. */
  private renderBudget(): number {
    const rows = Number(this.tui.terminal?.rows) || 24;
    return Math.max(6, rows - 6);
  }

  private renderSubView(view: ChoiceView | EditorView | ReviewView, width: number): string[] {
    const lines: string[] = [];
    const eyebrow = view.eyebrow;
    const identity = `${this.theme.fg("accent", "●")} ${this.theme.fg("toolTitle", "Shadows")}`;
    lines.push(fit(`${identity}  ${this.theme.fg("dim", eyebrow)}`, width));
    lines.push(fit(this.theme.bold(this.theme.fg("text", view.title)), width));
    lines.push(fit(this.theme.fg("borderMuted", "─".repeat(width)), width));
    if (view.kind === "choice") {
      if (view.description) lines.push(fit(this.theme.fg("dim", view.description), width), "");
      for (const [position, item] of view.items.entries()) {
        const marker = position === view.index ? this.theme.fg("accent", "›") : " ";
        const label = position === view.index ? this.theme.bold(item.label) : item.label;
        const detail = item.detail ? this.theme.fg("dim", `  ${clip(item.detail, Math.max(10, width - 6))}`) : "";
        lines.push(fit(`${marker} ${this.theme.fg("text", label)}${detail}`, width));
      }
      lines.push(fit(this.theme.fg("borderMuted", "─".repeat(width)), width));
      if (this.flash) {
        const flashColor = this.flash.kind === "error" ? "error" : "success";
        const flashMarker = this.flash.kind === "error" ? "✗" : "✓";
        lines.push(fit(`${this.theme.fg(flashColor, flashMarker)} ${this.theme.fg(flashColor, this.flash.text)}`, width));
      }
      lines.push(fit(this.theme.fg("dim", `${keyHint("tui.select.confirm", "choose")} · ${keyHint("tui.select.cancel", "back")}`), width));
      return lines;
    }
    if (view.kind === "editor") {
      if (view.description) lines.push(fit(this.theme.fg("dim", view.description), width));
      lines.push(fit(`${this.theme.fg("muted", "INPUT")} ${this.theme.fg("borderMuted", "─".repeat(Math.max(0, width - 6)))}`, width));
      for (const line of view.editor.render(width)) lines.push(fit(line, width));
      if (view.error) lines.push(fit(this.theme.fg("error", view.error), width));
      lines.push(fit(this.theme.fg("borderMuted", "─".repeat(width)), width));
      if (this.flash) {
        const flashColor = this.flash.kind === "error" ? "error" : "success";
        const flashMarker = this.flash.kind === "error" ? "✗" : "✓";
        lines.push(fit(`${this.theme.fg(flashColor, flashMarker)} ${this.theme.fg(flashColor, this.flash.text)}`, width));
      }
      lines.push(fit(this.theme.fg("dim", `${keyHint("tui.select.confirm", view.submitLabel)} · ${keyHint("tui.select.cancel", "back")}`), width));
      return lines;
    }
    const wrapped = view.lines.flatMap((line) => wrapTextWithAnsi(sanitizeDisplayText(line), Math.max(1, width)));
    const bodyBudget = Math.max(3, this.renderBudget() - 4);
    const maxScroll = Math.max(0, wrapped.length - bodyBudget);
    view.scroll = Math.min(view.scroll, maxScroll);
    const visible = wrapped.slice(view.scroll, view.scroll + bodyBudget);
    if (view.scroll > 0 && visible.length > 0) {
      visible[0] = this.theme.fg("dim", `… ${view.scroll} earlier lines`);
    }
    if (view.scroll + bodyBudget < wrapped.length && visible.length > 0) {
      visible[visible.length - 1] = this.theme.fg("dim", `… ${wrapped.length - view.scroll - bodyBudget} later lines`);
    }
    const color = view.destructive ? "warning" : "text";
    for (const line of visible) lines.push(this.theme.fg(color, line));
    lines.push(fit(this.theme.fg("borderMuted", "─".repeat(width)), width));
      if (this.flash) {
        const flashColor = this.flash.kind === "error" ? "error" : "success";
        const flashMarker = this.flash.kind === "error" ? "✗" : "✓";
        lines.push(fit(`${this.theme.fg(flashColor, flashMarker)} ${this.theme.fg(flashColor, this.flash.text)}`, width));
      }
    lines.push(fit(this.theme.fg("dim", `${keyHint("tui.select.confirm", view.confirmLabel)} · ${keyHint("tui.select.cancel", "back")}`), width));
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
      return fit(`${marker} ${badge} ${label}`, width);
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
      if (entry.sources[0]) {
        lines.push(fit(this.theme.fg("muted", `EDIT: ${entry.sources[0]}`), width));
        lines.push(fit(this.theme.fg("muted", "Repair: edit the file or /shadow <request>"), width));
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
      rows.push(fit(this.theme.fg("muted", `  ${layer.scope}: ${layer.filePath} (${layer.contentHash.slice(0, 8)})`), width));
    }
    rows.push(this.theme.fg("dim", "PROVENANCE:"));
    const sourceKeys = Object.keys(definition.fieldSources).slice(0, 20);
    for (const key of sourceKeys) {
      const source = definition.fieldSources[key as keyof typeof definition.fieldSources];
      rows.push(fit(this.theme.fg("muted", `  ${key}: ${source?.scope ?? "default"}`), width));
    }
    const editPath = definition.layers.at(-1)?.filePath;
    if (editPath) {
      rows.push(fit(this.theme.fg("muted", `EDIT: ${editPath}`), width));
      rows.push(fit(this.theme.fg("muted", "Changes: edit the file or /shadow <request>"), width));
    }
    rows.push(this.theme.fg("dim", "BODY:"));
    const allBodyLines = definition.body.replace(/\r/g, "").split("\n").filter((line) => line.trim() !== "");
    const bodyLines = allBodyLines.slice(0, BODY_PREVIEW_LINES);
    for (const line of bodyLines) rows.push(fit(this.theme.fg("text", `  ${line}`), width));
    const bodyHidden = allBodyLines.length - bodyLines.length;
    if (bodyHidden > 0) rows.push(fit(this.theme.fg("dim", `  (+${bodyHidden} more body line${bodyHidden === 1 ? "" : "s"} — View definition)`), width));
    return rows;
  }

  private renderDiagnostics(width: number): string[] {
    const lines: string[] = [];
    for (const diagnostic of this.data.diagnostics.slice(0, DIAGNOSTIC_LINES)) {
      lines.push(fit(this.theme.fg("warning", clip(diagnostic.message, width)), width));
    }
    const hidden = this.data.diagnostics.length - DIAGNOSTIC_LINES;
    if (hidden > 0) lines.push(fit(this.theme.fg("dim", `(+${hidden} more diagnostics)`), width));
    return lines;
  }
}

function definitionLabel(definition: EffectiveShadowDefinition): string {
  return `${definition.name} (${definition.id})`;
}

/** Reviewed run bounds for one manual trial. */
interface ManualRunBounds {
  timeoutSeconds: number;
  maxTurns: number;
  maxToolCalls: number;
}

/** Bounded run-review label for one definition's declared tool envelope. */
function toolsLabel(definition: EffectiveShadowDefinition): string {
  if (definition.tools === undefined) return "default local evidence set + submit";
  if (definition.tools.length === 0) return "none — submit_shadow_result only";
  return `${definition.tools.join(", ")} + submit`;
}

function runBounds(definition: EffectiveShadowDefinition, defaults?: ShadowMindsDefaults): ManualRunBounds {
  return {
    timeoutSeconds: definition.timeoutSeconds ?? defaults?.runTimeoutSeconds ?? DEFAULT_SHADOW_MINDS.runTimeoutSeconds,
    maxTurns: definition.maxTurns ?? defaults?.maxModelTurnsPerRun ?? DEFAULT_SHADOW_MINDS.maxModelTurnsPerRun,
    maxToolCalls: definition.maxToolCalls ?? defaults?.maxToolCallsPerRun ?? DEFAULT_SHADOW_MINDS.maxToolCallsPerRun,
  };
}

function runBoundLabel(bounds: ManualRunBounds): string {
  return `timeout ${bounds.timeoutSeconds}s · max ${bounds.maxTurns} turns · max ${bounds.maxToolCalls} tool calls`;
}

/** One-line muted summary of the frozen run facts. */
function runFactsDetail(run: ShadowRunView): string {
  const parts = [
    `tools ${run.toolNames && run.toolNames.length > 0 ? run.toolNames.length + 1 : 1}`,
    run.trajectoryTruncated ? "truncated trajectory" : "full trajectory",
  ];
  return parts.join(" · ");
}

/** Bounded review lines for the frozen envelope, cohorts, and metrics. */
function runFactsLines(run: ShadowRunView): string[] {
  const lines: string[] = [];
  const tools = run.toolNames && run.toolNames.length > 0
    ? `${run.toolNames.join(", ")} + submit_shadow_result`
    : "submit_shadow_result only";
  lines.push(`Tools: ${tools}`);
  if (run.source === "automatic") {
    lines.push(`Source: automatic · ${run.trigger ?? "trigger"}${run.taskEpoch !== undefined ? ` · task ${run.taskEpoch}` : ""}`);
    for (const reason of run.triggerReasons ?? []) {
      const detail = reason.detail !== undefined
        ? reason.detail
        : reason.trigger === "tool_turn" && reason.generation !== undefined ? `generation ${reason.generation}` : reason.trigger;
      lines.push(`Reason: ${sanitizeDisplayLine(detail)}`);
    }
  }
  if (run.toolWarnings && run.toolWarnings.length > 0) {
    lines.push("", "TOOL WARNINGS");
    lines.push(...run.toolWarnings.map((warning) => sanitizeDisplayLine(warning)));
  }
  lines.push("", "CACHE COHORTS");
  const cohorts = run.cohorts;
  if (cohorts) {
    lines.push(`model: ${cohorts.model} · thinking: ${cohorts.thinking}`);
    lines.push(`system: ${cohorts.system}`);
    lines.push(`tools: ${cohorts.toolSchema} · cwd: ${cohorts.cwd}`);
    lines.push(`trajectory: ${cohorts.trajectory}${run.trajectoryTruncated ? " (truncated: dropped)" : ""}`);
    lines.push(`checkpoint: ${cohorts.trajectoryCheckpoint} · truncation: ${cohorts.truncation}`);
    if (cohorts.parentCore !== undefined || cohorts.projectRules !== undefined) {
      lines.push(`parent core: ${cohorts.parentCore ?? "—"} · project rules: ${cohorts.projectRules ?? "—"}`);
    }
  } else {
    lines.push("model: —", "system: —", "tools: —", "trajectory: —");
  }
  if (run.requests && run.requests.length > 0) {
    lines.push("", "REQUESTS");
    run.requests.forEach((request) => {
      const cache = request.cacheReported
        ? `cache r ${request.cacheRead}/w ${request.cacheWrite}`
        : "cache unreported";
      const ttft = request.ttftMs !== undefined ? ` · ttft ${request.ttftMs}ms` : "";
      lines.push(
        `turn ${request.turn}. in ${request.input} · out ${request.output} · ${cache} · ${request.toolCalls} tool calls · cost ${request.cost}${ttft}`,
      );
    });
  }
  return lines;
}

function runDetailLabel(run: ShadowRunView): string {
  const qualifiers: string[] = [];
  if (run.source === "automatic") qualifiers.push(`automatic · ${run.trigger ?? "trigger"}${run.taskEpoch !== undefined ? ` · task ${run.taskEpoch}` : ""}`);
  if (run.trajectoryTruncated) qualifiers.push("trajectory truncated");
  if (run.toolWarnings && run.toolWarnings.length > 0) qualifiers.push(`${run.toolWarnings.length} tool warning${run.toolWarnings.length === 1 ? "" : "s"}`);
  if (run.requests && run.requests.length > 0) qualifiers.push(`${run.requests.length} request${run.requests.length === 1 ? "" : "s"}`);
  const suffix = qualifiers.length > 0 ? ` · ${qualifiers.join(", ")}` : "";
  const base = `${run.phase} · ${run.shadowId}${suffix}`;
  if (run.phase === "running") return base;
  const duration = run.endedAt !== undefined ? ` · ${Math.round((run.endedAt - run.startedAt) / 100) / 10}s` : "";
  return `${base}${duration}${run.message ? ` — ${run.message}` : ""}`;
}

function toolLabel(definition: EffectiveShadowDefinition): string {
  if (definition.tools === undefined) return "default local read-only set";
  if (definition.tools.length === 0) return "none (trajectory only)";
  return definition.tools.join(", ");
}

function configSummary(config: { enabled: boolean; defaults: ShadowMindsDefaults }): string {
  const d = config.defaults;
  return [
    `runs ${d.maxConcurrentRuns}`,
    `timeout ${d.runTimeoutSeconds}s`,
    `turns ${d.maxModelTurnsPerRun}`,
    `tools ${d.maxToolCallsPerRun}`,
    `starts ${d.maxAutomaticStartsPerTask}`,
    `queue ${d.maxQueuedShadowIds}`,
    `gate ${d.completionGateWindowSeconds}s`,
  ].join(" · ");
}

function plainLength(line: string): number {
  return visibleWidth(line);
}

export async function openShadowManager(
  ctx: ExtensionCommandContext,
  data: ShadowManagerSnapshot,
  services?: ShadowManagerServices,
): Promise<void> {
  await ctx.ui.custom<void>((tui, theme, keybindings, done) => (
    new ShadowManager(data, tui, theme, keybindings, done, services)
  ), { overlay: false });
}
