import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { getSelectListTheme } from "@earendil-works/pi-coding-agent";
import { type Component, type Focusable, Input, type SelectItem, SelectList, type TUI, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Answer, Question } from "./types";

// ── Types ────────────────────────────────────────────────────────────────

type ActionKind = "option" | "confirm" | "write" | "edit" | "submit" | "back";

interface ActionEntry {
  kind: ActionKind;
  /** Underlying option value, present only for kind === "option". */
  optionValue?: string;
}

type PanelResult =
  | { action: "select"; value: string }
  | { action: "confirm"; values: string[] }
  | { action: "submit-comment" }
  | { action: "back" }
  | { action: "cancel" };

// ── Helpers ──────────────────────────────────────────────────────────────

function fmtTitle(i: number, n: number, text: string): string {
  return n > 1 ? `[${i + 1}/${n}] ${text}` : text;
}

function trunc(s: string, max = 35): string {
  return s.length > max ? s.slice(0, max - 1) + "\u2026" : s;
}

/**
 * Pi's TUI throws hard when a rendered line exceeds the given width, so
 * every line this component composes by hand (as opposed to lines already
 * produced by SelectList/Input, which clamp themselves) must be clamped
 * here before it is pushed.
 */
function fitLine(line: string, width: number): string {
  return truncateToWidth(line, Math.max(1, width), "", true);
}

// ── Build the SelectList item list ──────────────────────────────────────

/**
 * Options, plus synthetic action rows (Confirm / Write-or-Edit answer /
 * Previous question), all rendered by one native SelectList. Each row gets
 * a synthetic id so real option values never collide with action ids.
 */
function buildSelectItems(
  q: Question,
  multi: boolean,
  hasComment: boolean,
  canGoBack: boolean,
  checked: Set<string>,
  comment: string | undefined,
): { items: SelectItem[]; actions: Map<string, ActionEntry> } {
  const items: SelectItem[] = [];
  const actions = new Map<string, ActionEntry>();
  let seq = 0;
  const nextId = () => `row-${seq++}`;

  for (const o of q.options) {
    const id = nextId();
    const mark = multi ? (checked.has(o.value) ? "\u25c6 " : "\u25c7 ") : "";
    items.push({ value: id, label: mark + o.label });
    actions.set(id, { kind: "option", optionValue: o.value });
  }

  if (multi) {
    const id = nextId();
    const n = checked.size;
    items.push({ value: id, label: n > 0 ? `Confirm (${n})` : "Confirm" });
    actions.set(id, { kind: "confirm" });
  }

  if (hasComment) {
    if (comment) {
      const submitId = nextId();
      items.push({ value: submitId, label: `\u201c${trunc(comment)}\u201d` });
      actions.set(submitId, { kind: "submit" });
      const editId = nextId();
      items.push({ value: editId, label: "Edit answer\u2026" });
      actions.set(editId, { kind: "edit" });
    } else {
      const id = nextId();
      items.push({ value: id, label: "Write your own answer\u2026" });
      actions.set(id, { kind: "write" });
    }
  }

  if (canGoBack) {
    const id = nextId();
    items.push({ value: id, label: "\u2039 Previous question" });
    actions.set(id, { kind: "back" });
  }

  return { items, actions };
}

// ── The panel component ──────────────────────────────────────────────────

/**
 * Single overlay session for one question. Internally swaps between a
 * native SelectList (browsing options/actions) and a native Input (typing
 * a free-text comment). Only terminal actions (select / confirm /
 * submit-comment / back / cancel) resolve the panel via `finish`; toggling
 * a checkbox or entering/leaving comment mode just rebuilds state in place.
 */
class AskPanel implements Component, Focusable {
  private mode: "list" | "comment" = "list";
  private selectList!: SelectList;
  private input?: Input;
  private items: SelectItem[] = [];
  private actions = new Map<string, ActionEntry>();
  private readonly checked = new Set<string>();
  private comment: string | undefined;
  private draftBeforeEdit: string | undefined;

  private _focused = false;
  get focused(): boolean {
    return this._focused;
  }
  set focused(value: boolean) {
    this._focused = value;
    if (this.input) this.input.focused = value;
  }

  constructor(
    private readonly title: string,
    private readonly q: Question,
    private readonly multi: boolean,
    private readonly hasComment: boolean,
    private readonly canGoBack: boolean,
    private readonly theme: any,
    private readonly tui: TUI,
    private readonly finish: (result: PanelResult, comment: string | undefined) => void,
  ) {
    this.rebuildList();
  }

  private rebuildList(preserveRowId?: string): void {
    const { items, actions } = buildSelectItems(this.q, this.multi, this.hasComment, this.canGoBack, this.checked, this.comment);
    this.items = items;
    this.actions = actions;
    const list = new SelectList(items, Math.min(items.length, 10), getSelectListTheme());
    if (preserveRowId) {
      const idx = items.findIndex((it) => it.value === preserveRowId);
      if (idx >= 0) list.setSelectedIndex(idx);
    }
    list.onSelect = (item) => this.handleAction(item.value);
    list.onCancel = () => this.finish({ action: "cancel" }, this.comment);
    this.selectList = list;
  }

  /** Select the first row of a given action kind, e.g. jump to "submit" right after saving a comment. */
  private selectRowByKind(kind: ActionKind): void {
    const idx = this.items.findIndex((it) => this.actions.get(it.value)?.kind === kind);
    if (idx >= 0) this.selectList.setSelectedIndex(idx);
  }

  private handleAction(rowId: string): void {
    const entry = this.actions.get(rowId);
    if (!entry) return;

    switch (entry.kind) {
      case "option":
        if (this.multi) {
          if (entry.optionValue) {
            if (this.checked.has(entry.optionValue)) this.checked.delete(entry.optionValue);
            else this.checked.add(entry.optionValue);
          }
          this.rebuildList(rowId);
          this.tui.requestRender();
          return;
        }
        this.finish({ action: "select", value: entry.optionValue! }, this.comment);
        return;

      case "confirm": {
        const ordered = this.q.options.filter((o) => this.checked.has(o.value)).map((o) => o.value);
        this.finish({ action: "confirm", values: ordered }, this.comment);
        return;
      }

      case "write":
      case "edit":
        this.enterCommentMode();
        return;

      case "submit":
        this.finish({ action: "submit-comment" }, this.comment);
        return;

      case "back":
        this.finish({ action: "back" }, this.comment);
        return;
    }
  }

  private enterCommentMode(): void {
    this.draftBeforeEdit = this.comment;
    const input = new Input();
    input.setValue(this.comment ?? "");
    input.focused = this._focused;
    input.onSubmit = (value) => {
      this.comment = value.trim() || undefined;
      this.mode = "list";
      this.rebuildList();
      this.selectRowByKind(this.comment ? "submit" : "write");
      this.tui.requestRender();
    };
    input.onEscape = () => {
      this.comment = this.draftBeforeEdit;
      this.mode = "list";
      this.tui.requestRender();
    };
    this.input = input;
    this.mode = "comment";
  }

  render(width: number): string[] {
    const theme = this.theme;
    const w = Math.max(1, width);
    const out: string[] = [];

    for (const line of wrapTextWithAnsi(this.title, w)) {
      out.push(fitLine(theme.fg("accent", theme.bold(line)), w));
    }

    if (this.mode === "comment" && this.input) {
      for (const line of this.input.render(w)) out.push(fitLine(line, w));
      out.push(fitLine(theme.fg("dim", "enter save \u2022 esc back"), w));
    } else {
      for (const line of this.selectList.render(w)) out.push(fitLine(line, w));
      out.push(fitLine(theme.fg("dim", "\u2191\u2193 navigate \u2022 enter select \u2022 esc cancel"), w));
    }

    return out;
  }

  invalidate(): void {
    this.selectList?.invalidate?.();
    this.input?.invalidate?.();
  }

  handleInput(data: string): void {
    if (this.mode === "comment") {
      this.input?.handleInput(data);
    } else {
      this.selectList.handleInput(data);
    }
    this.tui.requestRender();
  }
}

// ── Ask one question ─────────────────────────────────────────────────────

const WIDGET_KEY = "ask";

/**
 * Docked above the editor (not a modal overlay) so chat history stays
 * visible while answering. Because setWidget()-hosted components don't
 * receive keyboard focus on their own, raw input is captured via
 * onTerminalInput and routed to the panel manually while it is active.
 */
function showQuestionPanel(
  ui: ExtensionUIContext,
  title: string,
  q: Question,
  multi: boolean,
  hasComment: boolean,
  canGoBack: boolean,
  signal?: AbortSignal,
): Promise<{ result: PanelResult; comment: string | undefined }> {
  return new Promise((resolve) => {
    let finished = false;
    let unsubscribeInput: (() => void) | undefined;

    const finish = (result: PanelResult, comment: string | undefined) => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener("abort", onAbort);
      unsubscribeInput?.();
      ui.setWidget(WIDGET_KEY, undefined);
      resolve({ result, comment });
    };
    const onAbort = () => finish({ action: "cancel" }, undefined);

    if (signal?.aborted) {
      finish({ action: "cancel" }, undefined);
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });

    let panel: AskPanel | undefined;

    unsubscribeInput = ui.onTerminalInput((data) => {
      panel?.handleInput(data);
      return { consume: true };
    });

    ui.setWidget(
      WIDGET_KEY,
      (tui, theme) => {
        panel = new AskPanel(title, q, multi, hasComment, canGoBack, theme, tui, finish);
        return panel;
      },
      { placement: "aboveEditor" },
    );
  });
}

async function askOne(
  ui: ExtensionUIContext,
  q: Question,
  idx: number,
  total: number,
  canGoBack: boolean,
  signal?: AbortSignal,
): Promise<Answer | "back"> {
  if (signal?.aborted) return { questionId: q.id, selected: [], skipped: true };

  const title = fmtTitle(idx, total, q.text);
  const multi = q.type === "multi";
  const hasComment = q.allowComment !== false;

  const { result, comment } = await showQuestionPanel(ui, title, q, multi, hasComment, canGoBack, signal);

  switch (result.action) {
    case "select":
      return { questionId: q.id, selected: [result.value], comment, skipped: false };

    case "confirm":
      return { questionId: q.id, selected: result.values, comment, skipped: result.values.length === 0 && !comment };

    case "submit-comment":
      return { questionId: q.id, selected: [], comment, skipped: false };

    case "back":
      return "back";

    case "cancel":
      return { questionId: q.id, selected: [], skipped: true };
  }
}

// ── Public entry point ───────────────────────────────────────────────────

export async function promptQuestions(
  ui: ExtensionUIContext,
  questions: Question[],
  signal?: AbortSignal,
): Promise<Answer[]> {
  const answers: Answer[] = [];
  let i = 0;

  while (i < questions.length) {
    if (signal?.aborted) break;

    const q = questions[i];
    const result = await askOne(ui, q, i, questions.length, i > 0, signal);

    if (result === "back") { i--; answers.pop(); continue; }
    answers.push(result);
    i++;
  }

  return answers;
}
