import { stripVTControlCharacters } from "node:util";
import {
  getSelectListTheme,
  keyHint,
  type ExtensionUIContext,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  Editor,
  type Component,
  type Focusable,
  matchesKey,
  type TUI,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type {
  AnswerDraft,
  AskProgress,
  NormalizedQuestion,
  PromptOutcome,
} from "./types";
import { ASK_LIMITS, countCharacters, validateComment } from "./validation";

type WizardMode = "question" | "comment" | "review" | "cancel";
type QuestionAction =
  | { kind: "option"; optionIndex: number }
  | { kind: "comment" }
  | { kind: "skip" }
  | { kind: "back" }
  | { kind: "advance" };
type ReviewAction = { kind: "edit"; questionIndex: number } | { kind: "back" } | { kind: "submit" };
type CancelAction = { kind: "keep" } | { kind: "discard" };
type RowAction = QuestionAction | ReviewAction | CancelAction;
type WizardItemKind = "option" | "comment" | "review" | "secondary" | "primary" | "danger";

interface WizardItem {
  value: string;
  label: string;
  kind: WizardItemKind;
  description?: string;
  detail?: string;
  selected?: boolean;
  selectionType?: "single" | "multi";
}

const DEFAULT_COMMENT_PLACEHOLDER = "Add optional context";
const FORM_MIN_COLUMNS = 60;
const WIDE_LAYOUT_COLUMNS = 60;
const COMPACT_HEADER_COLUMNS = 48;

function sanitizeDisplay(value: unknown): string {
  return stripVTControlCharacters(String(value ?? ""))
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "   ")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
}

function inlineDisplay(value: unknown): string {
  return sanitizeDisplay(value).replace(/\s+/g, " ").trim();
}

function fitLine(line: string, width: number): string {
  return truncateToWidth(line, Math.max(1, width), "", true);
}

function wrappedLines(value: string, width: number): string[] {
  const safeWidth = Math.max(1, width);
  return value.split("\n").flatMap((line) => wrapTextWithAnsi(line || " ", safeWidth));
}

function emptyDraft(): AnswerDraft {
  return { selected: [], skipped: false, completed: false };
}

function hasAnswer(draft: AnswerDraft): boolean {
  return draft.selected.length > 0 || Boolean(draft.comment?.trim());
}

function answerSummary(question: NormalizedQuestion, draft: AnswerDraft): string {
  if (draft.skipped) return "Skipped";
  const labels = draft.selected.map((value) => question.options.find((option) => option.value === value)?.label ?? value);
  const pieces = labels.map(inlineDisplay);
  if (draft.comment?.trim()) pieces.push(`Comment: ${inlineDisplay(draft.comment)}`);
  return pieces.join(", ") || "Unanswered";
}

function answerDetail(question: NormalizedQuestion, draft: AnswerDraft): string {
  if (draft.skipped) return "Skipped by the user";
  const lines: string[] = [];
  if (draft.selected.length > 0) {
    lines.push("Selected");
    for (const value of draft.selected) {
      const option = question.options.find((candidate) => candidate.value === value);
      lines.push(`  • ${option?.label ?? value}${option ? ` (${option.value})` : ""}`);
    }
  }
  if (draft.comment !== undefined) {
    if (lines.length > 0) lines.push("");
    lines.push("Comment", ...draft.comment.split("\n").map((line) => `  ${line || " "}`));
  }
  return lines.join("\n") || "No answer";
}

function fitStyledLine(line: string, width: number): string {
  const safeWidth = Math.max(1, width);
  const fitted = truncateToWidth(line, safeWidth, "…");
  return fitted + " ".repeat(Math.max(0, safeWidth - visibleWidth(fitted)));
}

class AskWizard implements Component, Focusable {
  private mode: WizardMode = "question";
  private modeBeforeCancel: Exclude<WizardMode, "cancel"> = "question";
  private rowBeforeCancel?: string;
  private currentQuestion = 0;
  private reviewReturnIndex?: number;
  private readonly drafts: AnswerDraft[];
  private items: WizardItem[] = [];
  private actions = new Map<string, RowAction>();
  private focusedIndex = 0;
  private focusedRowId?: string;
  private detailRowId?: string;
  private questionWindowStart = 0;
  private reviewWindowStart = 0;
  private questionOffset = 0;
  private descriptionOffset = 0;
  private editor?: Editor;
  private commentBeforeEdit?: string;
  private lastValidComment = "";
  private validationMessage?: string;
  private finished = false;
  private _focused = false;

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    if (this.editor) this.editor.focused = value && this.mode === "comment";
  }

  constructor(
    private readonly questions: NormalizedQuestion[],
    private readonly tui: TUI,
    private readonly theme: any,
    private readonly keybindings: KeybindingsManager,
    private readonly finish: (outcome: PromptOutcome) => void,
    private readonly onProgress?: (progress: AskProgress) => void,
  ) {
    this.drafts = questions.map(emptyDraft);
    this.rebuildQuestionList();
    this.emitProgress();
  }

  private finishOnce(outcome: PromptOutcome): void {
    if (this.finished) return;
    this.finished = true;
    this.finish(outcome);
  }

  private counts(): { answeredCount: number; skippedCount: number } {
    return {
      answeredCount: this.drafts.filter((draft) => draft.completed && !draft.skipped).length,
      skippedCount: this.drafts.filter((draft) => draft.completed && draft.skipped).length,
    };
  }

  private emitProgress(): void {
    const counts = this.counts();
    this.onProgress?.({
      phase: this.mode === "review" ? "reviewing" : "asking",
      totalQuestions: this.questions.length,
      ...(this.mode === "question" || this.mode === "comment"
        ? { currentQuestion: this.currentQuestion + 1 }
        : {}),
      ...counts,
    });
  }

  private selectedQuestion(): NormalizedQuestion {
    return this.questions[this.currentQuestion]!;
  }

  private selectedDraft(): AnswerDraft {
    return this.drafts[this.currentQuestion]!;
  }

  private formWidth(terminalWidth: number): number {
    const safeWidth = Math.max(1, terminalWidth);
    return Math.min(safeWidth, Math.max(FORM_MIN_COLUMNS, Math.floor(safeWidth * 0.5)));
  }

  private optionVisualBudget(width: number, mode: "question" | "review"): number {
    const terminalRows = Number(this.tui.terminal?.rows) || 24;
    const actionLines = this.actionLineCount(width);
    if (mode === "review") {
      const reserved = 12 + this.descriptionPageSize() + actionLines;
      return Math.max(3, Math.min(12, terminalRows - reserved));
    }

    const hasComment = this.items.some((item) => item.kind === "comment");
    const hasDetail = this.items.some((item) => item.kind === "option" && (
      item.detail || visibleWidth(item.label) > Math.max(1, width - 7)
    ));
    const reserved = 12
      + this.questionPageSize()
      + actionLines
      + (hasComment ? 4 : 0)
      + (hasDetail ? 3 + this.descriptionPageSize() : 0);
    return Math.max(3, Math.min(12, terminalRows - reserved));
  }

  private installList(items: WizardItem[], actions: Map<string, RowAction>, preferredRowId?: string): void {
    this.items = items;
    this.actions = actions;
    const rowId = preferredRowId ?? this.focusedRowId;
    const preferredIndex = rowId ? items.findIndex((item) => item.value === rowId) : -1;
    this.focusedIndex = preferredIndex >= 0 ? preferredIndex : 0;
    this.syncFocusedItem(true);
  }

  private syncFocusedItem(resetDescription: boolean): void {
    const item = this.items[this.focusedIndex];
    this.focusedRowId = item?.value;
    if (item?.kind === "option" || item?.kind === "review") {
      if (this.detailRowId !== item.value) resetDescription = true;
      this.detailRowId = item.value;
    }
    if (resetDescription) this.descriptionOffset = 0;
  }

  private moveFocus(delta: -1 | 1): void {
    if (this.items.length === 0) return;
    this.focusedIndex = (this.focusedIndex + delta + this.items.length) % this.items.length;
    this.syncFocusedItem(true);
    this.tui.requestRender();
  }

  private rebuildQuestionList(preferredRowId?: string): void {
    const question = this.selectedQuestion();
    const draft = this.selectedDraft();
    const items: WizardItem[] = [];
    const actions = new Map<string, RowAction>();

    question.options.forEach((option, optionIndex) => {
      const rowId = `option-${optionIndex}`;
      const selected = draft.selected.includes(option.value);
      items.push({
        value: rowId,
        label: inlineDisplay(option.label),
        kind: "option",
        selected,
        selectionType: question.type,
        ...(option.description
          ? { description: sanitizeDisplay(option.description), detail: sanitizeDisplay(option.description) }
          : {}),
      });
      actions.set(rowId, { kind: "option", optionIndex });
    });

    if (question.allowComment) {
      const rowId = "comment";
      const count = draft.comment ? countCharacters(draft.comment) : 0;
      items.push({
        value: rowId,
        label: count > 0 ? `Edit comment · ${count} chars` : "Add comment",
        kind: "comment",
        description: draft.comment
          ? inlineDisplay(draft.comment)
          : inlineDisplay(question.commentPlaceholder ?? DEFAULT_COMMENT_PLACEHOLDER),
      });
      actions.set(rowId, { kind: "comment" });
    }

    if (this.currentQuestion > 0) {
      items.push({ value: "back", label: "‹ Back", kind: "secondary" });
      actions.set("back", { kind: "back" });
    }
    if (!question.required) {
      items.push({ value: "skip", label: "Skip", kind: "secondary" });
      actions.set("skip", { kind: "skip" });
    }

    const advanceLabel = this.reviewReturnIndex === this.currentQuestion
      ? "Return to review →"
      : this.questions.length === 1
        ? "Submit answer →"
        : this.currentQuestion === this.questions.length - 1
          ? "Review answers →"
          : "Continue →";
    items.push({ value: "advance", label: advanceLabel, kind: "primary" });
    actions.set("advance", { kind: "advance" });
    this.installList(items, actions, preferredRowId);
  }

  private rebuildReviewList(preferredRowId?: string): void {
    const items: WizardItem[] = [];
    const actions = new Map<string, RowAction>();
    this.questions.forEach((question, questionIndex) => {
      const rowId = `review-${questionIndex}`;
      const draft = this.drafts[questionIndex]!;
      items.push({
        value: rowId,
        label: inlineDisplay(question.text),
        kind: "review",
        selected: !draft.skipped,
        description: answerSummary(question, draft),
        detail: answerDetail(question, draft),
      });
      actions.set(rowId, { kind: "edit", questionIndex });
    });
    items.push({ value: "review-back", label: "‹ Last question", kind: "secondary" });
    actions.set("review-back", { kind: "back" });
    items.push({ value: "review-submit", label: "Submit all →", kind: "primary" });
    actions.set("review-submit", { kind: "submit" });
    this.installList(items, actions, preferredRowId ?? "review-submit");
    if (!items.some((item) => item.kind === "review" && item.value === this.detailRowId)) {
      this.detailRowId = "review-0";
      this.descriptionOffset = 0;
    }
  }

  private rebuildCancelList(): void {
    const items: WizardItem[] = [
      { value: "cancel-keep", label: "Keep answering", kind: "primary" },
      { value: "cancel-discard", label: "Discard and cancel", kind: "danger" },
    ];
    const actions = new Map<string, RowAction>([
      ["cancel-keep", { kind: "keep" }],
      ["cancel-discard", { kind: "discard" }],
    ]);
    this.installList(items, actions, "cancel-keep");
  }

  private activate(rowId: string): void {
    const action = this.actions.get(rowId);
    if (!action) return;

    switch (action.kind) {
      case "option":
        this.toggleOption(action.optionIndex, rowId);
        return;
      case "comment":
        this.enterCommentMode();
        return;
      case "skip":
        this.skipQuestion();
        return;
      case "back":
        if (this.mode === "review") this.editQuestion(this.questions.length - 1, false);
        else this.goBack();
        return;
      case "advance":
        this.advance();
        return;
      case "edit":
        this.editQuestion(action.questionIndex, true);
        return;
      case "submit": {
        const incomplete = this.drafts.findIndex((draft, index) => {
          const question = this.questions[index]!;
          if (!draft.completed) return true;
          if (draft.skipped) return question.required;
          return !hasAnswer(draft);
        });
        if (incomplete >= 0) {
          this.editQuestion(incomplete, true);
          this.validationMessage = "Complete this question before submitting";
          this.tui.requestRender();
          return;
        }
        this.finishOnce({ status: "submitted", drafts: this.drafts.map((draft) => ({ ...draft, selected: [...draft.selected] })) });
        return;
      }
      case "keep":
        this.keepAnswering();
        return;
      case "discard":
        this.finishOnce({ status: "cancelled", reason: "user" });
        return;
    }
  }

  private toggleOption(optionIndex: number, rowId: string): void {
    const question = this.selectedQuestion();
    const draft = this.selectedDraft();
    const value = question.options[optionIndex]?.value;
    if (value === undefined) return;

    if (question.type === "single") {
      draft.selected = draft.selected[0] === value ? [] : [value];
    } else if (draft.selected.includes(value)) {
      draft.selected = draft.selected.filter((selected) => selected !== value);
    } else {
      draft.selected = [...draft.selected, value];
    }
    draft.skipped = false;
    draft.completed = false;
    this.validationMessage = undefined;
    this.rebuildQuestionList(rowId);
    this.tui.requestRender();
  }

  private enterCommentMode(): void {
    const draft = this.selectedDraft();
    this.commentBeforeEdit = draft.comment;
    this.lastValidComment = draft.comment ?? "";
    const editor = new Editor(this.tui, {
      borderColor: (text) => this.theme.fg("border", text),
      selectList: getSelectListTheme(),
    }, { paddingX: 0, autocompleteMaxVisible: 0 });
    editor.setText(this.lastValidComment);
    editor.focused = this._focused;
    editor.onChange = (value) => {
      const message = validateComment(value);
      if (message) {
        editor.setText(this.lastValidComment);
        this.validationMessage = message;
      } else {
        this.lastValidComment = value;
        this.validationMessage = undefined;
      }
      this.tui.requestRender();
    };
    editor.onSubmit = (value) => this.saveComment(value);
    this.editor = editor;
    this.mode = "comment";
    this.validationMessage = undefined;
    this.emitProgress();
    this.tui.requestRender();
  }

  private saveComment(value: string): void {
    const message = validateComment(value);
    if (message) {
      this.validationMessage = message;
      this.tui.requestRender();
      return;
    }
    const draft = this.selectedDraft();
    draft.comment = value.trim().length > 0 ? value : undefined;
    draft.skipped = false;
    draft.completed = false;
    this.mode = "question";
    this.editor = undefined;
    this.validationMessage = undefined;
    this.rebuildQuestionList("comment");
    this.emitProgress();
    this.tui.requestRender();
  }

  private cancelCommentEdit(): void {
    this.selectedDraft().comment = this.commentBeforeEdit;
    this.editor = undefined;
    this.mode = "question";
    this.validationMessage = undefined;
    this.rebuildQuestionList("comment");
    this.emitProgress();
    this.tui.requestRender();
  }

  private skipQuestion(): void {
    const draft = this.selectedDraft();
    draft.selected = [];
    draft.comment = undefined;
    draft.skipped = true;
    draft.completed = true;
    this.validationMessage = undefined;
    this.moveForward();
  }

  private advance(): void {
    const question = this.selectedQuestion();
    const draft = this.selectedDraft();
    if (!hasAnswer(draft)) {
      this.validationMessage = question.required
        ? "Select at least one option or add a comment"
        : "Choose an answer or use Skip this question";
      this.tui.requestRender();
      return;
    }
    draft.skipped = false;
    draft.completed = true;
    this.validationMessage = undefined;
    this.moveForward();
  }

  private moveForward(): void {
    if (this.reviewReturnIndex === this.currentQuestion) {
      this.reviewReturnIndex = undefined;
      this.mode = "review";
      this.rebuildReviewList(`review-${this.currentQuestion}`);
    } else if (this.currentQuestion < this.questions.length - 1) {
      this.currentQuestion += 1;
      this.questionOffset = 0;
      this.mode = "question";
      this.focusedRowId = undefined;
      this.rebuildQuestionList();
    } else if (this.questions.length > 1) {
      this.reviewReturnIndex = undefined;
      this.mode = "review";
      this.rebuildReviewList();
    } else {
      this.finishOnce({ status: "submitted", drafts: this.drafts.map((draft) => ({ ...draft, selected: [...draft.selected] })) });
      return;
    }
    this.emitProgress();
    this.tui.requestRender();
  }

  private goBack(): void {
    if (this.currentQuestion === 0) return;
    this.currentQuestion -= 1;
    this.questionOffset = 0;
    this.mode = "question";
    this.focusedRowId = undefined;
    this.validationMessage = undefined;
    this.rebuildQuestionList();
    this.emitProgress();
    this.tui.requestRender();
  }

  private editQuestion(questionIndex: number, returnToReview: boolean): void {
    this.currentQuestion = questionIndex;
    this.questionOffset = 0;
    this.reviewReturnIndex = returnToReview ? questionIndex : undefined;
    this.mode = "question";
    this.focusedRowId = undefined;
    this.validationMessage = undefined;
    this.rebuildQuestionList();
    this.emitProgress();
    this.tui.requestRender();
  }

  private isDirty(): boolean {
    return this.drafts.some((draft) => draft.selected.length > 0 || Boolean(draft.comment?.trim()));
  }

  private requestCancel(): void {
    if (!this.isDirty()) {
      this.finishOnce({ status: "cancelled", reason: "user" });
      return;
    }
    this.modeBeforeCancel = this.mode === "cancel" ? "question" : this.mode;
    this.rowBeforeCancel = this.focusedRowId;
    this.mode = "cancel";
    this.validationMessage = undefined;
    this.rebuildCancelList();
    this.tui.requestRender();
  }

  private keepAnswering(): void {
    this.mode = this.modeBeforeCancel;
    this.validationMessage = undefined;
    const preferredRowId = this.rowBeforeCancel;
    this.rowBeforeCancel = undefined;
    if (this.mode === "review") this.rebuildReviewList(preferredRowId);
    else this.rebuildQuestionList(preferredRowId);
    this.emitProgress();
    this.tui.requestRender();
  }

  private focusedItem(): WizardItem | undefined {
    return this.items[this.focusedIndex];
  }

  private currentDetailItem(): WizardItem | undefined {
    return this.items.find((item) => item.value === this.detailRowId && (item.kind === "option" || item.kind === "review"));
  }

  private descriptionPageSize(): number {
    const terminalRows = Number(this.tui.terminal?.rows) || 24;
    return Math.max(2, Math.min(4, Math.floor(terminalRows / 12)));
  }

  private questionPageSize(): number {
    const terminalRows = Number(this.tui.terminal?.rows) || 24;
    return Math.max(3, Math.min(5, Math.floor(terminalRows / 8)));
  }

  private composeSides(left: string, right: string, width: number): string {
    const safeWidth = Math.max(1, width);
    const gap = safeWidth - visibleWidth(left) - visibleWidth(right);
    if (gap >= 2) return fitLine(`${left}${" ".repeat(gap)}${right}`, safeWidth);
    return fitLine(`${left}${this.theme.fg("dim", " · ")}${right}`, safeWidth);
  }

  private paintRow(content: string, width: number, focused: boolean): string {
    const fitted = fitStyledLine(content, width);
    return focused ? this.theme.bg("selectedBg", fitted) : fitted;
  }

  private sectionHeader(label: string, width: number, detail = ""): string {
    const left = this.theme.fg("muted", label.toUpperCase());
    const right = detail ? this.theme.fg("dim", detail) : "";
    return this.composeSides(left, right, width);
  }

  private renderStepRail(): string {
    return this.questions.map((_question, index) => {
      const marker = index === this.currentQuestion
        ? this.theme.fg("accent", "●")
        : this.drafts[index]?.completed
          ? this.theme.fg("success", "●")
          : this.theme.fg("dim", "○");
      if (index === this.questions.length - 1) return marker;
      const connector = index < this.currentQuestion || this.drafts[index]?.completed
        ? this.theme.fg("muted", "━")
        : this.theme.fg("dim", "━");
      return `${marker}${connector}`;
    }).join("");
  }

  private renderHeader(width: number): string[] {
    const brand = this.theme.fg("toolTitle", this.theme.bold("ASK"));
    if (this.mode === "review") {
      const { answeredCount, skippedCount } = this.counts();
      const status = width < COMPACT_HEADER_COLUMNS
        ? `${answeredCount}/${this.questions.length}${skippedCount > 0 ? ` · ${skippedCount} skipped` : ""}`
        : `${answeredCount} answered${skippedCount > 0 ? ` · ${skippedCount} skipped` : ""}`;
      return [this.composeSides(`${brand}  ${this.theme.fg("accent", "REVIEW")}`, this.theme.fg("muted", status), width)];
    }
    if (this.mode === "cancel") {
      return [this.composeSides(brand, this.theme.fg("warning", "CANCEL"), width)];
    }

    const question = this.selectedQuestion();
    const position = `${String(this.currentQuestion + 1).padStart(2, "0")} / ${String(this.questions.length).padStart(2, "0")}`;
    const requirement = question.required ? "REQUIRED" : "OPTIONAL";
    if (width < COMPACT_HEADER_COLUMNS || this.questions.length === 1) {
      const compact = this.questions.length === 1 ? brand : `${brand}  ${this.theme.fg("muted", position)}`;
      return [this.composeSides(compact, this.theme.fg("dim", requirement), width)];
    }
    const left = `${brand}  ${this.theme.fg("muted", position)}  ${this.renderStepRail()}`;
    return [this.composeSides(left, this.theme.fg("dim", requirement), width)];
  }

  private visualHeight(item: WizardItem, width: number): number {
    return item.kind === "option" && width >= WIDE_LAYOUT_COLUMNS && Boolean(item.description) ? 2 : 1;
  }

  private visibleWindow(items: WizardItem[], width: number, mode: "question" | "review"): {
    visible: WizardItem[];
    before: number;
    after: number;
  } {
    if (items.length === 0) return { visible: [], before: 0, after: 0 };
    const focusValue = this.focusedItem()?.kind === (mode === "question" ? "option" : "review")
      ? this.focusedRowId
      : this.detailRowId;
    const focusIndex = Math.max(0, items.findIndex((item) => item.value === focusValue));
    let start = mode === "question" ? this.questionWindowStart : this.reviewWindowStart;
    start = Math.max(0, Math.min(start, items.length - 1));
    if (focusIndex < start) start = focusIndex;

    const budget = this.optionVisualBudget(width, mode);
    const endFor = (candidate: number) => {
      let used = 0;
      let end = candidate;
      while (end < items.length) {
        const height = this.visualHeight(items[end]!, width);
        if (end > candidate && used + height > budget) break;
        used += height;
        end += 1;
      }
      return end;
    };
    let end = endFor(start);
    while (focusIndex >= end && start < focusIndex) {
      start += 1;
      end = endFor(start);
    }
    if (mode === "question") this.questionWindowStart = start;
    else this.reviewWindowStart = start;
    return { visible: items.slice(start, end), before: start, after: items.length - end };
  }

  private renderOption(item: WizardItem, width: number): string[] {
    const focused = item.value === this.focusedRowId;
    const focus = focused ? this.theme.fg("accent", "›") : " ";
    const checked = item.selectionType === "multi"
      ? (item.selected ? "■" : "□")
      : (item.selected ? "●" : "○");
    const marker = this.theme.fg(item.selected ? "accent" : "dim", checked);
    const label = item.selected || focused
      ? this.theme.bold(this.theme.fg("text", item.label))
      : this.theme.fg("text", item.label);
    const output = [this.paintRow(`${focus}  ${marker}  ${label}`, width, focused)];
    if (width >= WIDE_LAYOUT_COLUMNS && item.description) {
      output.push(this.paintRow(`      ${this.theme.fg("dim", inlineDisplay(item.description))}`, width, focused));
    }
    return output;
  }

  private renderOptions(width: number): string[] {
    const options = this.items.filter((item) => item.kind === "option");
    const selected = options.filter((item) => item.selected).length;
    const mode = this.selectedQuestion().type === "single" ? "Select one" : "Select any";
    const window = this.visibleWindow(options, width, "question");
    const output = [this.sectionHeader(mode, width, selected > 0 ? `${selected} selected` : "")];
    if (window.before > 0) output.push(fitLine(this.theme.fg("muted", `  ↑ ${window.before} more`), width));
    for (const item of window.visible) output.push(...this.renderOption(item, width));
    if (window.after > 0) output.push(fitLine(this.theme.fg("muted", `  ↓ ${window.after} more`), width));
    return output;
  }

  private renderDetail(width: number): string[] {
    const detailWidth = Math.max(1, width - 4);
    const needsLabelDetail = (item: WizardItem) => item.kind === "option" && visibleWidth(item.label) > Math.max(1, width - 7);
    const detailItems = this.items.filter((item) => (
      item.kind === "option" || item.kind === "review"
    ) && (item.detail || needsLabelDetail(item)));
    if (detailItems.length === 0) return [];
    const item = this.currentDetailItem() ?? detailItems[0]!;
    const rawParts: string[] = [];
    if (needsLabelDetail(item)) rawParts.push(item.label);
    if (item.detail) rawParts.push(item.detail);
    const lines = wrappedLines(sanitizeDisplay(rawParts.join("\n\n") || "No additional details"), detailWidth);
    const pageSize = this.descriptionPageSize();
    const maxOffset = Math.max(0, lines.length - pageSize);
    this.descriptionOffset = Math.min(this.descriptionOffset, maxOffset);
    const page = lines.slice(this.descriptionOffset, this.descriptionOffset + pageSize);
    const start = lines.length > 0 ? this.descriptionOffset + 1 : 0;
    const end = Math.min(lines.length, this.descriptionOffset + pageSize);
    const output = ["", this.sectionHeader("Details", width, lines.length > pageSize ? `${start}–${end} / ${lines.length}` : "")];
    for (const line of page) output.push(fitLine(`  ${this.theme.fg("dim", line)}`, width));
    while (page.length < pageSize) {
      output.push("");
      page.push("");
    }
    if (lines.length > pageSize) output.push(fitLine(this.theme.fg("muted", "  PageUp/PageDown to read more"), width));
    return output;
  }

  private renderCommentAction(width: number): string[] {
    const item = this.items.find((candidate) => candidate.kind === "comment");
    if (!item) return [];
    const focused = item.value === this.focusedRowId;
    const focus = focused ? this.theme.fg("accent", "›") : " ";
    const icon = this.selectedDraft().comment ? "✎" : "+";
    const output = [
      "",
      this.sectionHeader("Additional context", width),
      this.paintRow(`${focus}  ${this.theme.fg("accent", icon)}  ${this.theme.fg("text", item.label)}`, width, focused),
    ];
    if (item.description) output.push(this.paintRow(`      ${this.theme.fg("dim", item.description)}`, width, focused));
    return output;
  }

  private renderReviewItem(item: WizardItem, width: number): string {
    const focused = item.value === this.focusedRowId;
    const questionIndex = Number(item.value.slice("review-".length));
    const draft = this.drafts[questionIndex];
    const focus = focused ? this.theme.fg("accent", "›") : " ";
    const status = draft?.skipped ? this.theme.fg("muted", "–") : this.theme.fg("success", "✓");
    const number = this.theme.fg("dim", String(questionIndex + 1).padStart(2, "0"));
    const fixedWidth = visibleWidth(`${focus}  x  00  `);
    let content: string;
    if (width >= WIDE_LAYOUT_COLUMNS && item.description) {
      const summaryWidth = Math.max(12, Math.floor(width * 0.32));
      const questionWidth = Math.max(8, width - fixedWidth - summaryWidth - 2);
      const question = truncateToWidth(item.label, questionWidth, "…");
      const summary = truncateToWidth(item.description, summaryWidth, "…");
      const gap = Math.max(2, width - fixedWidth - visibleWidth(question) - visibleWidth(summary));
      content = `${focus}  ${status}  ${number}  ${this.theme.fg("text", question)}${" ".repeat(gap)}${this.theme.fg("dim", summary)}`;
    } else {
      content = `${focus}  ${status}  ${number}  ${this.theme.fg("text", item.label)}`;
    }
    return this.paintRow(content, width, focused);
  }

  private renderReview(width: number): string[] {
    const rows = this.items.filter((item) => item.kind === "review");
    const window = this.visibleWindow(rows, width, "review");
    const output = [this.sectionHeader("Answers", width, `${rows.length} questions`)];
    if (window.before > 0) output.push(fitLine(this.theme.fg("muted", `  ↑ ${window.before} more`), width));
    for (const item of window.visible) output.push(this.renderReviewItem(item, width));
    if (window.after > 0) output.push(fitLine(this.theme.fg("muted", `  ↓ ${window.after} more`), width));
    output.push(...this.renderDetail(width));
    return output;
  }

  private actionContent(item: WizardItem, focused: boolean): string {
    const focus = focused ? this.theme.fg("accent", "›") : " ";
    const label = item.kind === "primary"
      ? this.theme.fg("accent", this.theme.bold(item.label))
      : item.kind === "danger"
        ? this.theme.fg("warning", item.label)
        : this.theme.fg("muted", item.label);
    return `${focus} ${label}`;
  }

  private actionSegment(item: WizardItem, focused: boolean): string {
    const segment = ` ${this.actionContent(item, focused)} `;
    return focused ? this.theme.bg("selectedBg", segment) : segment;
  }

  private actionItems(): WizardItem[] {
    return this.items.filter((item) => item.kind === "secondary" || item.kind === "primary" || item.kind === "danger");
  }

  private actionLineCount(width: number): number {
    const actions = this.actionItems();
    const requiredWidth = actions.reduce((total, item) => total + visibleWidth(item.label) + 4, 0)
      + Math.max(0, actions.length - 1) * 2;
    return requiredWidth <= width ? Math.min(1, actions.length) : actions.length;
  }

  private renderCommandBar(width: number): string[] {
    const actions = this.actionItems();
    if (actions.length === 0) return [];
    const output = ["", fitLine(this.theme.fg("borderMuted", "─".repeat(width)), width)];
    const requiredWidth = actions.reduce((total, item) => total + visibleWidth(item.label) + 4, 0)
      + Math.max(0, actions.length - 1) * 2;
    if (requiredWidth <= width) {
      const segments = actions.map((item) => this.actionSegment(item, item.value === this.focusedRowId));
      const last = actions.at(-1);
      if (last?.kind === "primary" && segments.length > 1) {
        const left = segments.slice(0, -1).join("  ");
        const right = segments.at(-1)!;
        const gap = Math.max(2, width - visibleWidth(left) - visibleWidth(right));
        output.push(fitLine(`${left}${" ".repeat(gap)}${right}`, width));
      } else {
        output.push(fitLine(segments.join("  "), width));
      }
      return output;
    }
    for (const item of actions) {
      const focused = item.value === this.focusedRowId;
      output.push(this.paintRow(this.actionContent(item, focused), width, focused));
    }
    return output;
  }

  private renderQuestionText(width: number): string[] {
    const lines = wrappedLines(sanitizeDisplay(this.selectedQuestion().text), width);
    const pageSize = this.questionPageSize();
    const maxOffset = Math.max(0, lines.length - pageSize);
    this.questionOffset = Math.min(this.questionOffset, maxOffset);
    const page = lines.slice(this.questionOffset, this.questionOffset + pageSize);
    const start = this.questionOffset + 1;
    const end = Math.min(lines.length, this.questionOffset + pageSize);
    const detail = lines.length > pageSize ? `${start}–${end} / ${lines.length}` : "";
    const output = [this.sectionHeader("Question", width, detail)];
    for (const line of page) output.push(fitLine(this.theme.fg("text", this.theme.bold(line)), width));
    if (lines.length > pageSize) {
      output.push(fitLine(this.theme.fg("muted", "Shift+PageUp/PageDown to read more"), width));
    }
    return output;
  }

  private renderQuestion(width: number): string[] {
    return [
      ...this.renderQuestionText(width),
      "",
      ...this.renderOptions(width),
      ...this.renderDetail(width),
      ...this.renderCommentAction(width),
    ];
  }

  private renderComment(width: number): string[] {
    const question = this.selectedQuestion();
    const output = [...this.renderQuestionText(width), "", this.sectionHeader("Additional context", width)];
    const placeholder = sanitizeDisplay(question.commentPlaceholder ?? DEFAULT_COMMENT_PLACEHOLDER);
    if ((this.editor?.getText() ?? "").length === 0) {
      for (const line of wrappedLines(placeholder, Math.max(1, width - 2))) {
        output.push(fitLine(this.theme.fg("dim", `  ${line}`), width));
      }
    }
    output.push(...(this.editor?.render(width) ?? []).map((line) => fitLine(line, width)));
    const count = countCharacters(this.editor?.getExpandedText() ?? "");
    output.push(this.composeSides("", this.theme.fg(count >= ASK_LIMITS.comment ? "warning" : "muted", `${count} / ${ASK_LIMITS.comment}`), width));
    return output;
  }

  private footer(width: number): string {
    if (this.mode === "comment") {
      return fitLine(
        keyHint("tui.select.confirm", "save")
          + this.theme.fg("dim", " · shift+enter newline · ")
          + keyHint("tui.select.cancel", "back"),
        width,
      );
    }
    const compact = width < WIDE_LAYOUT_COLUMNS;
    return fitLine(
      keyHint("tui.select.up", compact ? "move" : "move focus")
        + this.theme.fg("dim", compact ? " · enter · " : " · enter activate · ")
        + (this.mode === "question" && !compact ? this.theme.fg("dim", "space select · ") : "")
        + keyHint("tui.select.cancel", this.mode === "cancel" ? "keep" : "cancel"),
      width,
    );
  }

  render(width: number): string[] {
    const terminalWidth = Math.max(1, width);
    const safeWidth = this.formWidth(terminalWidth);
    const output = [...this.renderHeader(safeWidth), ""];
    if (this.mode === "question") output.push(...this.renderQuestion(safeWidth));
    else if (this.mode === "comment") output.push(...this.renderComment(safeWidth));
    else if (this.mode === "review") output.push(...this.renderReview(safeWidth));
    else {
      output.push(fitLine(this.theme.fg("warning", this.theme.bold("Discard this questionnaire?")), safeWidth));
      for (const line of wrappedLines("Your unsubmitted selections and comments will be permanently discarded.", safeWidth)) {
        output.push(fitLine(this.theme.fg("dim", line), safeWidth));
      }
    }
    if (this.validationMessage) {
      output.push("");
      const lines = wrappedLines(this.validationMessage, Math.max(1, safeWidth - 3));
      lines.forEach((line, index) => {
        const prefix = index === 0 ? `${this.theme.fg("error", "!")}  ` : "   ";
        output.push(fitLine(`${prefix}${this.theme.fg("error", line)}`, safeWidth));
      });
    }
    if (this.mode !== "comment") output.push(...this.renderCommandBar(safeWidth));
    output.push("", this.footer(safeWidth));
    return output.map((line) => fitLine(fitLine(line, safeWidth), terminalWidth));
  }

  handleInput(data: string): void {
    if (this.finished) return;
    if (this.mode === "comment") {
      if (this.keybindings.matches(data, "tui.select.cancel")) this.cancelCommentEdit();
      else this.editor?.handleInput(data);
      this.tui.requestRender();
      return;
    }

    if (this.mode === "question" && matchesKey(data, "space")) {
      const action = this.focusedRowId ? this.actions.get(this.focusedRowId) : undefined;
      if (action?.kind === "option") this.toggleOption(action.optionIndex, this.focusedRowId!);
      return;
    }

    if (this.mode === "question" && matchesKey(data, "shift+pageDown")) {
      this.questionOffset += this.questionPageSize();
      this.tui.requestRender();
      return;
    }
    if (this.mode === "question" && matchesKey(data, "shift+pageUp")) {
      this.questionOffset = Math.max(0, this.questionOffset - this.questionPageSize());
      this.tui.requestRender();
      return;
    }

    const detail = this.currentDetailItem()?.detail;
    if (detail && this.keybindings.matches(data, "tui.select.pageDown")) {
      this.descriptionOffset += this.descriptionPageSize();
      this.tui.requestRender();
      return;
    }
    if (detail && this.keybindings.matches(data, "tui.select.pageUp")) {
      this.descriptionOffset = Math.max(0, this.descriptionOffset - this.descriptionPageSize());
      this.tui.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.up")) {
      this.moveFocus(-1);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.down")) {
      this.moveFocus(1);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.confirm")) {
      if (this.focusedRowId) this.activate(this.focusedRowId);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      if (this.mode === "cancel") this.keepAnswering();
      else this.requestCancel();
    }
  }

  invalidate(): void {
    this.editor?.invalidate?.();
  }
}

export async function promptQuestions(
  ui: ExtensionUIContext,
  questions: NormalizedQuestion[],
  signal?: AbortSignal,
  onProgress?: (progress: AskProgress) => void,
): Promise<PromptOutcome> {
  if (signal?.aborted) return { status: "cancelled", reason: "aborted" };

  let close: ((outcome: PromptOutcome) => void) | undefined;
  let aborted = false;
  const onAbort = () => {
    aborted = true;
    close?.({ status: "cancelled", reason: "aborted" });
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    return await ui.custom<PromptOutcome>((tui, theme, keybindings, done) => {
      close = done;
      if (aborted || signal?.aborted) done({ status: "cancelled", reason: "aborted" });
      return new AskWizard(questions, tui, theme, keybindings, done, onProgress);
    });
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}
