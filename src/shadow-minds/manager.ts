/**
 * `/shadow` manager view (odradekk/pi-square#149, slices #153–#155).
 *
 * A focus-preserving, non-overlay TUI view that inspects every effective
 * Shadow definition with its layer provenance and, when write services are
 * supplied, creates and edits agent and trusted-project overlays. Every
 * write is reviewed in a scrollable candidate view first, then approved
 * through the session FIFO confirmation coordinator after the manager
 * closes itself, and executed by the safe overlay writer. Package templates
 * stay read-only. Runtime services add manual no-tool trials with a bounded
 * one-time note, live run observation with cancellation, and result-inbox
 * inspection (read, dismiss, delete). The view follows the shared unframed
 * operational grammar: one-cell status rail, label-led rows, muted borders,
 * no emoji.
 */

import {
  getSelectListTheme,
  keyHint,
  type ExtensionCommandContext,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import { Editor, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type Focusable, type TUI } from "@earendil-works/pi-tui";
import type { ShadowMindsDefaults } from "../core/config";
import type { FileIdentity } from "../core/safe-write";
import { sanitizeDisplayLine, sanitizeDisplayText } from "../display/sanitize";
import { shadowDefinitionContextFingerprint } from "./definitions";
import type { EffectiveShadowDefinition, ShadowDefinitionRegistry } from "./definitions";
import { MISSING_OVERLAY_FINGERPRINT } from "./overlays";
import {
  SHADOW_DELIVERIES,
  SHADOW_ID_PATTERN,
  SHADOW_THINKING_LEVELS,
  SHADOW_TRIGGERS,
  validateOutputSchema,
  type ShadowDefinitionFields,
  type ShadowOutputSchema,
  type ShadowTrigger,
} from "./parser";
import type { ShadowResultEntity } from "./result";
import { SHADOW_MANUAL_NOTE_MAX_CHARS, type ShadowRunView, type ShadowRuntimeSnapshot } from "./runtime";
import { newShadowDefinitionDraft } from "./serialize";

const LIST_WIDTH = 34;
const BODY_PREVIEW_LINES = 8;
const DIAGNOSTIC_LINES = 4;
const RESULT_PAYLOAD_PREVIEW_CHARS = 2_000;

type WritableScope = "agent" | "project";

/** Snapshot the view renders; refresh comes from the owning feature state. */
export interface ShadowManagerSnapshot {
  definitions: EffectiveShadowDefinition[];
  invalid: ShadowDefinitionRegistry["invalid"];
  diagnostics: ShadowDefinitionRegistry["diagnostics"];
  projectTrusted: boolean;
  /** Effective feature configuration; absent when unknown at open time. */
  config?: { enabled: boolean; defaults: ShadowMindsDefaults };
}

/** Result of one persistent overlay operation, surfaced outside the manager. */
export interface ShadowWriteOutcome {
  ok: boolean;
  message: string;
}

/** Bounded approval request routed through the FIFO confirmation coordinator. */
export interface ShadowApprovalRequest {
  title: string;
  lines: string[];
  destructive?: boolean;
}

/** Session runtime operations surfaced in the manager (#155). */
export interface ShadowRuntimeServices {
  snapshot(): ShadowRuntimeSnapshot;
  /** Starts one manual run for an effective definition; never throws. */
  runManual(input: { shadowId: string; note?: string }): { ok: boolean; message: string };
  cancelRun(runId: string): { ok: boolean; message?: string };
  markResultRead(id: string): boolean;
  dismissResult(id: string): boolean;
  deleteResult(id: string): boolean;
  subscribe(listener: () => void): () => void;
}

export interface ShadowManagerServices {
  runtime?: ShadowRuntimeServices;
  refresh(): ShadowManagerSnapshot;
  /** Maps an on-disk overlay path to its writable scope, when it is one. */
  scopeOf(filePath: string): WritableScope | undefined;
  /** Canonical overlay path plus review fingerprint for one scope and ID. */
  overlaySnapshot(scope: WritableScope, id: string, filePath?: string): Promise<{
    filePath: string;
    fingerprint: string;
    contextFingerprint: string;
    identity?: FileIdentity;
    content: string;
  }>;
  /** In-memory candidate: serialized layer, canonical path, effective merge. */
  preview(scope: WritableScope, fields: ShadowDefinitionFields, expectedContextFingerprint?: string, filePath?: string): {
    content: string;
    filePath: string;
    definition?: EffectiveShadowDefinition;
    errors: string[];
    contextFingerprint?: string;
  };
  /** Effective merge after deleting the exact reviewed layer. */
  previewDelete(scope: WritableScope, id: string, filePath: string, expectedContextFingerprint?: string): {
    definition?: EffectiveShadowDefinition;
    errors: string[];
    contextFingerprint?: string;
  };
  /** FIFO-coordinated native confirmation; the manager has closed itself. */
  approve(request: ShadowApprovalRequest): Promise<boolean>;
  save(
    scope: WritableScope,
    fields: ShadowDefinitionFields,
    reviewFilePath: string,
    reviewFingerprint: string,
    reviewContextFingerprint: string,
    reviewIdentity?: FileIdentity,
  ): Promise<ShadowWriteOutcome>;
  deleteOverlay(
    scope: WritableScope,
    id: string,
    filePath: string,
    reviewFingerprint: string,
    reviewContextFingerprint: string,
    reviewIdentity?: FileIdentity,
  ): Promise<ShadowWriteOutcome>;
}

export function snapshot(
  registry: ShadowDefinitionRegistry,
  projectTrusted: boolean,
  config?: { enabled: boolean; defaults: ShadowMindsDefaults },
): ShadowManagerSnapshot {
  return {
    definitions: registry.definitions,
    invalid: registry.invalid,
    diagnostics: registry.diagnostics,
    projectTrusted,
    ...(config ? { config } : {}),
  };
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

/** Editable overlay fields with their labels, in manager menu order. */
const EDIT_FIELDS = [
  "name",
  "body",
  "enabled",
  "hidden",
  "priority",
  "triggers",
  "delivery",
  "completionGate",
  "model",
  "thinking",
  "timeoutSeconds",
  "maxTurns",
  "maxToolCalls",
  "tools",
  "requiredTools",
  "parentModels",
  "debug",
  "triggerInstructions",
  "outputSchema",
] as const;
type EditField = (typeof EDIT_FIELDS)[number];

const FIELD_LABELS: Record<EditField, string> = {
  name: "name",
  body: "body",
  enabled: "enabled",
  hidden: "hidden",
  priority: "priority",
  triggers: "triggers",
  delivery: "delivery",
  completionGate: "completionGate",
  model: "model",
  thinking: "thinking",
  timeoutSeconds: "timeoutSeconds",
  maxTurns: "maxTurns",
  maxToolCalls: "maxToolCalls",
  tools: "tools",
  requiredTools: "requiredTools",
  parentModels: "parentModels",
  debug: "debug",
  triggerInstructions: "triggerInstructions",
  outputSchema: "outputSchema",
};

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

  // ── Write flows ─────────────────────────────────────────────────────

  /** Closes the manager, then routes the approval and the write outward. */
  private async commit(
    approval: ShadowApprovalRequest,
    action: () => Promise<ShadowWriteOutcome>,
  ): Promise<void> {
    this.finish();
    let approved = false;
    try {
      approved = await this.services?.approve(approval) ?? false;
    } catch {
      return;
    }
    if (!approved) return;
    try {
      await action();
    } catch {
      // Production services convert write failures into bounded outcomes. A
      // custom service must not create an unhandled rejection after close.
    }
  }

  private chooseScope(title: string, description: string, onSelect: (scope: WritableScope) => void): void {
    const items: ChoiceItem[] = [
      {
        id: "project",
        label: "Project",
        detail: this.data.projectTrusted
          ? "Write to the discovered .pi/shadow-minds directory"
          : "unavailable — the project is not trusted",
        onSelect: () => onSelect("project"),
      },
      {
        id: "agent",
        label: "Agent",
        detail: "Write to the user-level Shadow directory",
        onSelect: () => onSelect("agent"),
      },
    ];
    if (!this.data.projectTrusted) items.shift();
    this.openChoice({ eyebrow: "OVERLAYS / SCOPE", title, description, items });
  }

  /** Fields of the existing same-scope layer, or a minimal base overlay. */
  private layerFields(definition: EffectiveShadowDefinition, scope: WritableScope): ShadowDefinitionFields {
    const existing = definition.layers.find((layer) => layer.scope === scope);
    if (existing) return structuredClone(existing.fields);
    return { id: definition.id };
  }

  private async reviewSave(
    before: EffectiveShadowDefinition | undefined,
    scope: WritableScope,
    fields: ShadowDefinitionFields,
    capturedReview?: {
      filePath: string;
      fingerprint: string;
      contextFingerprint: string;
      identity?: FileIdentity;
      content: string;
    },
  ): Promise<void> {
    if (!this.services) {
      this.errorFlash("Overlay writes are unavailable in this session.");
      return;
    }
    // Bind the review to the exact layer and complete ID context that was
    // visible when the manager opened. A later edit to any contributing layer
    // is stale rather than silently adopted into this candidate.
    const existingLayer = before?.layers.find((layer) => layer.scope === scope);
    const review = capturedReview ?? await this.services.overlaySnapshot(scope, fields.id, existingLayer?.filePath);
    const expectedContextFingerprint = before
      ? shadowDefinitionContextFingerprint(before.layers)
      : review.contextFingerprint;
    if (review.contextFingerprint !== expectedContextFingerprint) {
      this.errorFlash("The Shadow definition changed since the manager opened; reopen /shadow and review the current layers.");
      return;
    }
    const preview = this.services.preview(scope, fields, expectedContextFingerprint, review.filePath);
    if (preview.errors.length > 0 || !preview.definition || preview.contextFingerprint !== review.contextFingerprint) {
      this.errorFlash(preview.errors.join(" ") || "The Shadow definition changed; reopen /shadow and review the current layers.");
      return;
    }
    const previewDefinition = preview.definition;
    const change = effectiveChange(before, previewDefinition);
    const body = [
      `Path: ${preview.filePath}`,
      "",
      "LAYER MARKDOWN",
      ...preview.content.trimEnd().split("\n"),
      "",
      "EFFECTIVE CHANGE",
      ...change,
    ];
    this.openReview({
      eyebrow: "OVERLAYS / REVIEW",
      title: `Save ${fields.id} ${scope} overlay?`,
      lines: body,
      confirmLabel: "save overlay",
      onConfirm: () => {
        void this.commit(
          {
            title: `Save ${scope} Shadow overlay`,
            lines: [
              `Path: ${preview.filePath}`,
              `Definition: ${previewDefinition.id}`,
              ...change.slice(0, 6),
            ],
          },
          async () => this.services!.save(
            scope,
            fields,
            review.filePath,
            review.fingerprint,
            review.contextFingerprint,
            review.identity,
          ),
        );
      },
    });
  }

  private setFieldValue(
    definition: EffectiveShadowDefinition,
    scope: WritableScope,
    field: EditField,
    fields: ShadowDefinitionFields,
    value: unknown,
  ): void {
    if (value === undefined) delete (fields as unknown as Record<string, unknown>)[field];
    else (fields as unknown as Record<string, unknown>)[field] = value;
    void this.reviewSave(definition, scope, fields);
  }

  private editFieldValue(
    definition: EffectiveShadowDefinition,
    scope: WritableScope,
    field: EditField,
    fields: ShadowDefinitionFields,
  ): void {
    const current = (fields as unknown as Record<string, unknown>)[field];
    if (field === "delivery") {
      this.openChoice({
        eyebrow: "OVERLAYS / VALUE",
        title: `Set ${field}`,
        items: SHADOW_DELIVERIES.map((delivery) => ({
          id: delivery,
          label: delivery,
          onSelect: () => this.setFieldValue(definition, scope, field, fields, delivery),
        })),
      });
      return;
    }
    if (field === "thinking") {
      this.openChoice({
        eyebrow: "OVERLAYS / VALUE",
        title: `Set ${field}`,
        items: SHADOW_THINKING_LEVELS.map((level) => ({
          id: level,
          label: level,
          onSelect: () => this.setFieldValue(definition, scope, field, fields, level),
        })),
      });
      return;
    }
    if (field === "triggerInstructions") {
      this.editTriggerInstruction(definition, scope, fields);
      return;
    }
    if (field === "outputSchema") {
      this.openChoice({
        eyebrow: "OVERLAYS / VALUE",
        title: "Set outputSchema",
        description: "Schemas are replaced atomically; choose inherit, the default summary schema, or author the bounded JSON object schema.",
        items: [
          {
            id: "inherit",
            label: "Inherit lower layer",
            detail: "Remove outputSchema from this overlay",
            onSelect: () => this.setFieldValue(definition, scope, field, fields, undefined),
          },
          {
            id: "default",
            label: "Restore default summary schema",
            detail: "Write an explicit null",
            onSelect: () => this.setFieldValue(definition, scope, field, fields, null),
          },
          {
            id: "custom",
            label: "Set custom schema",
            detail: "Enter a bounded JSON object schema",
            onSelect: () => this.openEditor({
              eyebrow: "OVERLAYS / VALUE",
              title: "outputSchema JSON",
              description: "Object root only; every object must set additionalProperties: false.",
              initial: JSON.stringify(definition.outputSchema, null, 2),
              submitLabel: "review change",
              validate: (value) => {
                try {
                  const parsed = JSON.parse(value) as unknown;
                  return validateOutputSchema(parsed).join(" ") || undefined;
                } catch (error) {
                  return `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`;
                }
              },
              onSubmit: (value) => this.setFieldValue(
                definition,
                scope,
                field,
                fields,
                JSON.parse(value) as ShadowOutputSchema,
              ),
            }),
          },
        ],
      });
      return;
    }
    const isBoolean = ["enabled", "hidden", "completionGate", "debug"].includes(field);
    if (isBoolean) {
      this.openChoice({
        eyebrow: "OVERLAYS / VALUE",
        title: `Set ${field}`,
        items: [true, false].map((value) => ({
          id: String(value),
          label: String(value),
          onSelect: () => this.setFieldValue(definition, scope, field, fields, value),
        })),
      });
      return;
    }
    const isArray = ["triggers", "tools", "requiredTools", "parentModels"].includes(field);
    const initial = isArray
      ? ((current as string[] | undefined) ?? (field === "triggers" ? definition.triggers : (definition as unknown as Record<string, unknown>)[field] as string[] | undefined) ?? []).join("\n")
      : typeof current === "string"
        ? current
        : current === undefined || current === null
          ? ""
          : String(current);
    this.openEditor({
      eyebrow: "OVERLAYS / VALUE",
      title: `Set ${field}`,
      description: isArray
        ? field === "triggers"
          ? `One trigger per line. Allowed: ${SHADOW_TRIGGERS.join(", ")}.`
          : "One entry per line. An empty value produces an empty list."
        : field === "body"
          ? "The responsibility prompt. Non-empty."
          : "Empty inherits the lower layer.",
      initial,
      submitLabel: "review change",
      validate: (value) => {
        if (isArray) {
          const entries = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
          if (field === "triggers" && entries.some((entry) => !SHADOW_TRIGGERS.includes(entry as ShadowTrigger))) {
            return `Triggers must be among ${SHADOW_TRIGGERS.join(", ")}.`;
          }
          return undefined;
        }
        if (field === "priority" || field === "timeoutSeconds" || field === "maxTurns" || field === "maxToolCalls") {
          if (value.trim() === "") return undefined;
          if (!/^-?\d+$/.test(value.trim())) return "Enter an integer.";
          return undefined;
        }
        if (field === "body" && value.trim() === "") return "The body must be non-empty.";
        return undefined;
      },
      onSubmit: (value) => {
        if (isArray) {
          const entries = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
          this.setFieldValue(definition, scope, field, fields, entries);
          return;
        }
        if (field === "priority" || field === "timeoutSeconds" || field === "maxTurns" || field === "maxToolCalls") {
          this.setFieldValue(definition, scope, field, fields, value.trim() === "" ? undefined : Number.parseInt(value.trim(), 10));
          return;
        }
        this.setFieldValue(definition, scope, field, fields, value.trim() === "" ? undefined : value.trim());
      },
    });
  }

  private editTriggerInstruction(
    definition: EffectiveShadowDefinition,
    scope: WritableScope,
    fields: ShadowDefinitionFields,
  ): void {
    const map = { ...(fields.triggerInstructions ?? {}) };
    this.openChoice({
      eyebrow: "OVERLAYS / VALUE",
      title: "triggerInstructions",
      description: "Instructions merge per trigger key; an explicit null removes one key.",
      items: SHADOW_TRIGGERS.map((trigger) => {
        const value = map[trigger];
        const inherited = definition.triggerInstructions[trigger];
        return {
          id: trigger,
          label: trigger,
          detail: value === null
            ? "explicit null (removes the key)"
            : typeof value === "string"
              ? clip(value, 80)
              : inherited
                ? `inherited: ${clip(inherited, 60)}`
                : "unset",
          onSelect: () => {
            this.openEditor({
              eyebrow: "OVERLAYS / VALUE",
              title: `triggerInstructions.${trigger}`,
              description: "Empty inherits; the literal null removes the key for this trigger.",
              initial: typeof value === "string" ? value : "",
              submitLabel: "review change",
              onSubmit: (edited) => {
                const trimmed = edited.trim();
                if (trimmed === "") delete map[trigger];
                else if (trimmed === "null") map[trigger] = null;
                else map[trigger] = trimmed;
                if (Object.keys(map).length === 0) this.setFieldValue(definition, scope, "triggerInstructions", fields, undefined);
                else this.setFieldValue(definition, scope, "triggerInstructions", fields, { ...map });
              },
            });
          },
        };
      }),
    });
  }

  private chooseFieldMode(
    definition: EffectiveShadowDefinition,
    scope: WritableScope,
    field: EditField,
  ): void {
    const fields = this.layerFields(definition, scope);
    this.openChoice({
      eyebrow: "OVERLAYS / OVERLAY",
      title: `${definition.id} · ${FIELD_LABELS[field]}`,
      description: "Inherit omits the field from this overlay; set defines a value here.",
      items: [
        {
          id: "inherit",
          label: "Inherit lower layer",
          detail: "Remove this field from the overlay",
          onSelect: () => this.setFieldValue(definition, scope, field, fields, undefined),
        },
        {
          id: "set",
          label: "Set value",
          detail: "Define a value in this overlay",
          onSelect: () => this.editFieldValue(definition, scope, field, fields),
        },
      ],
    });
  }

  private editDefinition(definition: EffectiveShadowDefinition): void {
    this.chooseScope(`Edit ${definition.id}`, "Choose the overlay scope to edit.", (scope) => {
      this.openChoice({
        eyebrow: "OVERLAYS / FIELD",
        title: `${definition.id} · ${scope}`,
        description: "Choose one effective field to modify.",
        items: EDIT_FIELDS.map((field) => ({
          id: field,
          label: FIELD_LABELS[field],
          detail: `${displayFieldValue(definition, field)} · ${definition.fieldSources[field]?.scope ?? "default"}`,
          onSelect: () => this.chooseFieldMode(definition, scope, field),
        })),
      });
    });
  }

  private toggleField(definition: EffectiveShadowDefinition, field: "enabled" | "hidden"): void {
    const next = !definition[field];
    this.chooseScope(`${next ? "Enable" : "Disable"} ${definition.id}`, `The overlay sets ${field}: ${next}.`, (scope) => {
      void this.reviewSave(definition, scope, { ...this.layerFields(definition, scope), [field]: next });
    });
  }

  private createDefinition(): void {
    if (!this.services) {
      this.errorFlash("Overlay writes are unavailable in this session.");
      return;
    }
    this.chooseScope("Create Shadow definition", "New definitions default to disabled with no automatic triggers.", (scope) => {
      this.openEditor({
        eyebrow: "OVERLAYS / NEW",
        title: "Definition id",
        description: "Stable id; the overlay file is <id>.md. Letters, digits, dot, underscore, hyphen.",
        initial: "",
        submitLabel: "continue",
        validate: (value) => {
          const id = value.trim();
          if (!SHADOW_ID_PATTERN.test(id)) return `The id must match ${SHADOW_ID_PATTERN}.`;
          if (this.entries.some((entry) => entry.id === id)) return `Shadow definition '${id}' already exists; edit or repair it instead.`;
          return undefined;
        },
        onSubmit: (idValue) => {
          const id = idValue.trim();
          this.openEditor({
            eyebrow: "OVERLAYS / NEW",
            title: `${id} · name`,
            description: "Human-readable role name. Empty uses the id.",
            initial: "",
            submitLabel: "continue",
            onSubmit: (nameValue) => {
              const name = nameValue.trim() || id;
              this.openEditor({
                eyebrow: "OVERLAYS / NEW",
                title: `${id} · responsibility body`,
                description: "The Markdown responsibility prompt.",
                initial: "",
                submitLabel: "review definition",
                validate: (value) => (value.trim() ? undefined : "A non-empty body is required."),
                onSubmit: (bodyValue) => {
                  void (async () => {
                    const existing = await this.services!.overlaySnapshot(scope, id);
                    if (existing.fingerprint !== MISSING_OVERLAY_FINGERPRINT) {
                      this.errorFlash(`An overlay for '${id}' already exists in the ${scope} scope; edit it instead.`);
                      return;
                    }
                    await this.reviewSave(undefined, scope, newShadowDefinitionDraft(id, name, bodyValue.trim()), existing);
                  })();
                },
              });
            },
          });
        },
      });
    });
  }

  private deleteOverlay(): void {
    const selected = this.selected();
    if (!selected || !this.services) {
      if (!this.services) this.errorFlash("Overlay writes are unavailable in this session.");
      return;
    }
    const sources = "invalid" in selected
      ? selected.invalid.sources
      : selected.layers.filter((layer) => layer.scope === "agent" || layer.scope === "project").map((layer) => layer.filePath);
    if (sources.length === 0) {
      this.errorFlash("Package templates are read-only. Use hide to overlay instead.");
      return;
    }
    this.openChoice({
      eyebrow: "OVERLAYS / DELETE",
      title: `Delete ${selected.id} overlay`,
      description: "Only agent and project overlays can be deleted.",
      items: sources.flatMap((filePath) => {
        const scope = this.services!.scopeOf(filePath);
        if (!scope) return [];
        return [{
          id: filePath,
          label: `${scope} overlay`,
          detail: filePath,
          onSelect: () => {
            const target = scope;
            void (async () => {
              const review = await this.services!.overlaySnapshot(target, selected.id, filePath);
              const expectedContextFingerprint = "invalid" in selected
                ? review.contextFingerprint
                : shadowDefinitionContextFingerprint(selected.layers);
              if (review.contextFingerprint !== expectedContextFingerprint) {
                this.errorFlash("The Shadow definition changed since the manager opened; reopen /shadow and review the current layers.");
                return;
              }
              const deletion = this.services!.previewDelete(target, selected.id, review.filePath, expectedContextFingerprint);
              if (deletion.errors.length > 0 || deletion.contextFingerprint !== review.contextFingerprint) {
                this.errorFlash(deletion.errors.join(" ") || "The Shadow definition changed; reopen /shadow and review the current layers.");
                return;
              }
              const before = "invalid" in selected ? undefined : selected;
              const change = deletion.definition
                ? effectiveChange(before, deletion.definition)
                : ["definition: present → removed"];
              this.openReview({
                eyebrow: "OVERLAYS / DELETE / REVIEW",
                title: `Delete ${target} overlay?`,
                lines: [
                  `Path: ${review.filePath}`,
                  "",
                  "LAYER MARKDOWN",
                  ...review.content.trimEnd().split("\n"),
                  "",
                  "EFFECTIVE CHANGE",
                  ...change,
                ],
                confirmLabel: "delete overlay",
                destructive: true,
                onConfirm: () => {
                  void this.commit(
                    {
                      title: `Delete ${target} Shadow overlay`,
                      lines: [`Path: ${review.filePath}`, `Definition: ${selected.id}`, ...change.slice(0, 6)],
                      destructive: true,
                    },
                    async () => this.services!.deleteOverlay(
                      target,
                      selected.id,
                      review.filePath,
                      review.fingerprint,
                      review.contextFingerprint,
                      review.identity,
                    ),
                  );
                },
              });
            })();
          },
        }];
      }),
    });
  }

  private activate(): void {
    const selected = this.selected();
    if (!selected) return;
    if ("invalid" in selected) {
      this.deleteOverlay();
      return;
    }
    this.openChoice({
      eyebrow: "OVERLAYS / ACTIONS",
      title: `${selected.id} · ${selected.name}`,
      description: selected.layers.some((layer) => layer.scope !== "package")
        ? undefined
        : "Package templates are read-only; edits create overlays.",
      items: [
        ...(isNoToolTrial(selected)
          ? [{
              id: "run-manually",
              label: "Run manually",
              detail: `no-tool trial · ${runBoundLabel(selected, this.data.config?.defaults)}`,
              onSelect: () => this.runManually(selected),
            }]
          : []),
        {
          id: "toggle-enabled",
          label: selected.enabled ? "Disable" : "Enable",
          detail: `enabled: ${selected.enabled}`,
          onSelect: () => this.toggleField(selected, "enabled"),
        },
        {
          id: "toggle-hidden",
          label: selected.hidden ? "Unhide" : "Hide",
          detail: `hidden: ${selected.hidden}`,
          onSelect: () => this.toggleField(selected, "hidden"),
        },
        {
          id: "edit",
          label: "Edit fields",
          detail: "Overlay one field at a time",
          onSelect: () => this.editDefinition(selected),
        },
        {
          id: "delete",
          label: "Delete overlay",
          detail: "Remove an agent or project layer",
          onSelect: () => this.deleteOverlay(),
        },
      ],
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
        this.openReview({
          eyebrow: "RUN / REVIEW",
          title: `Start ${definition.id} manual run?`,
          lines: [
            `Definition: ${definition.name} (${definition.id})`,
            `Tools: none — submit_shadow_result only`,
            `Bounds: ${runBoundLabel(definition, this.data.config?.defaults)}`,
            `Evidence: the current parent trajectory, reference only`,
            ...(note ? ["", "MANUAL NOTE", note] : []),
          ],
          confirmLabel: "start run",
          onConfirm: () => {
            this.finish();
            const outcome = this.services?.runtime?.runManual({
              shadowId: definition.id,
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
          detail: `${snapshot.results.length} results · ${unread} unread`,
          onSelect: () => this.openInboxList(),
        },
      ],
    });
  }

  private buildRunItems(): ChoiceItem[] {
    const runtime = this.services?.runtime;
    if (!runtime) return [];
    return runtime.snapshot().runs.slice(0, 12).map((run) => ({
      id: run.id,
      label: `${run.shadowName} (${run.shadowId})`,
      detail: runDetailLabel(run),
      onSelect: () => this.openRunDetail(run.id),
    }));
  }

  private openRunsList(): void {
    const items = this.buildRunItems();
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
    this.openChoice({
      eyebrow: "RUNS / DETAIL",
      title: `${run.shadowName} · ${run.phase}`,
      description: runDetailLabel(run),
      items: items.length > 0 ? items : [{ id: "empty", label: "No actions for a settled run without a result.", onSelect: () => {} }],
    });
  }

  private buildInboxItems(): ChoiceItem[] {
    const runtime = this.services?.runtime;
    if (!runtime) return [];
    return runtime.snapshot().results.slice(0, 20).map((result) => ({
      id: result.id,
      label: result.summary || result.shadowName,
      detail: `${result.shadowId} · ${result.attention} · ${result.delivery}`,
      onSelect: () => this.openResultActions(result.id),
    }));
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
    this.openChoice({
      eyebrow: "INBOX / RESULT",
      title: result.summary || result.shadowName,
      description: `${result.shadowName} (${result.shadowId}) · ${result.attention} · ${result.delivery}`,
      items: [
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
      payloadText = JSON.stringify(result.payload, null, 2) ?? "(null)";
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
    if (matchesKey(data, "n")) return this.createDefinition();
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
        `${keyHint("tui.select.up", "↑/↓")} select · ${keyHint("tui.select.confirm", "enter")} actions · n new${runtimeHint} · ${keyHint("tui.select.cancel", "esc")} close`,
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
      const fileName = layer.filePath.split(/[\\/]/).pop() ?? layer.filePath;
      rows.push(fit(this.theme.fg("muted", `  ${layer.scope}: ${fileName} (${layer.contentHash.slice(0, 8)})`), width));
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

function definitionLabel(definition: EffectiveShadowDefinition): string {
  return `${definition.name} (${definition.id})`;
}

/** A manual trial exists only for the explicit empty tool list (#155). */
function isNoToolTrial(definition: EffectiveShadowDefinition): boolean {
  return definition.tools !== undefined && definition.tools.length === 0;
}

function runBoundLabel(definition: EffectiveShadowDefinition, defaults?: ShadowMindsDefaults): string {
  const timeout = definition.timeoutSeconds ?? defaults?.runTimeoutSeconds ?? 120;
  const turns = definition.maxTurns ?? defaults?.maxModelTurnsPerRun ?? 8;
  const toolCalls = definition.maxToolCalls ?? defaults?.maxToolCallsPerRun ?? 16;
  return `timeout ${timeout}s · max ${turns} turns · max ${toolCalls} tool calls`;
}

function runDetailLabel(run: ShadowRunView): string {
  const base = `${run.phase} · ${run.shadowId}`;
  if (run.phase === "running") return base;
  const duration = run.endedAt !== undefined ? ` · ${(run.endedAt - run.startedAt) / 1000}s` : "";
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
    `concurrency ${d.maxConcurrentRuns}`,
    `timeout ${d.runTimeoutSeconds}s`,
    `turns ${d.maxModelTurnsPerRun}`,
    `tool calls ${d.maxToolCallsPerRun}`,
    `starts/task ${d.maxAutomaticStartsPerTask}`,
    `gate window ${d.completionGateWindowSeconds}s`,
  ].join(" · ");
}

function plainLength(line: string): number {
  return visibleWidth(line);
}

function displayFieldValue(definition: EffectiveShadowDefinition, field: EditField): string {
  if (field === "triggerInstructions") {
    const keys = Object.keys(definition.triggerInstructions);
    return keys.length > 0 ? keys.join(",") : "(default)";
  }
  const value = (definition as unknown as Record<string, unknown>)[field];
  if (value === undefined) return "(default)";
  if (value === null) return "default schema";
  if (Array.isArray(value)) return value.length === 0 ? "[]" : value.join(",");
  if (typeof value === "string") return clip(value, 40);
  return String(value);
}

/** One line per changed effective field between two merges. */
function effectiveChange(
  before: EffectiveShadowDefinition | undefined,
  after: EffectiveShadowDefinition,
): string[] {
  const rows: string[] = [];
  const keys = [
    "name",
    "enabled",
    "hidden",
    "priority",
    "triggers",
    "delivery",
    "completionGate",
    "model",
    "thinking",
    "timeoutSeconds",
    "maxTurns",
    "maxToolCalls",
    "tools",
    "requiredTools",
    "parentModels",
    "debug",
  ] as const;
  for (const key of keys) {
    const previous = before ? (before as unknown as Record<string, unknown>)[key] : undefined;
    const next = (after as unknown as Record<string, unknown>)[key];
    const same = Array.isArray(previous) && Array.isArray(next)
      ? previous.join(",") === next.join(",")
      : JSON.stringify(previous) === JSON.stringify(next);
    if (!same) {
      rows.push(`${key}: ${shortValue(previous)} → ${shortValue(next)}`);
    }
  }
  const previousBody = before?.body;
  if (previousBody !== after.body) rows.push(`body: ${shortValue(previousBody ?? "(none)")} → ${shortValue(after.body)}`);
  const previousInstructions = before?.triggerInstructions ?? {};
  const nextInstructions = after.triggerInstructions;
  if (JSON.stringify(previousInstructions) !== JSON.stringify(nextInstructions)) {
    rows.push(`triggerInstructions: ${shortValue(previousInstructions)} → ${shortValue(nextInstructions)}`);
  }
  const schemaChanged = JSON.stringify(before?.outputSchema) !== JSON.stringify(after.outputSchema);
  if (schemaChanged) {
    rows.push(`outputSchema: ${before ? "replaced" : "(none) → defined"}`);
  }
  if (rows.length === 0) rows.push("no effective field changes");
  return rows;
}

function shortValue(value: unknown): string {
  if (value === undefined) return "(default)";
  if (Array.isArray(value)) return value.length === 0 ? "[]" : value.join(",");
  if (typeof value === "string") return clip(value, 80);
  if (value !== null && typeof value === "object") return clip(JSON.stringify(value), 120);
  return String(value);
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
