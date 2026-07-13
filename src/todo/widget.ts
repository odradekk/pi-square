import { stripVTControlCharacters } from "node:util";
import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { DEFAULT_TODO_TITLE, currentTodo, todoCounts } from "./state";
import type { TodoItem, TodoState, TodoWidgetState } from "./types";

const WIDGET_KEY = "todo";
const FORM_MIN_COLUMNS = 60;
const MIN_WIDGET_ROWS = 5;
const MAX_WIDGET_ROWS = 12;

interface WidgetTui {
  terminal: { rows: number };
}

function sanitizeDisplay(value: unknown): string {
  return stripVTControlCharacters(String(value ?? ""))
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function todoPanelWidth(terminalWidth: number): number {
  const safeWidth = Math.max(1, terminalWidth);
  return Math.min(safeWidth, Math.max(FORM_MIN_COLUMNS, Math.floor(safeWidth * 0.5)));
}

export function todoWidgetRowBudget(terminalRows: number): number {
  return Math.min(MAX_WIDGET_ROWS, Math.max(MIN_WIDGET_ROWS, Math.floor(Math.max(1, terminalRows) * 0.3)));
}

function fitLine(line: string, width: number): string {
  return truncateToWidth(line, Math.max(1, width), "…");
}

function headerLine(state: TodoState, width: number, theme: Theme): string {
  const counts = todoCounts(state.items);
  const percent = counts.total === 0 ? 0 : Math.round((counts.completed / counts.total) * 100);
  const customTitle = state.title === DEFAULT_TODO_TITLE ? "" : `  ${sanitizeDisplay(state.title)}`;
  const left = theme.fg("toolTitle", theme.bold("TODO")) + theme.fg("text", customTitle);
  const paused = counts.pending > 0 && counts.inProgress === 0 ? " · PAUSED" : "";
  const right = theme.fg(paused ? "muted" : "accent", `${counts.completed}/${counts.total} · ${percent}%${paused}`);
  const gap = width - visibleWidth(left) - visibleWidth(right);
  if (gap < 2) return fitLine(`${left}  ${right}`, width);
  return `${left}${" ".repeat(gap)}${right}`;
}

function progressLine(state: TodoState, width: number, theme: Theme): string {
  const counts = todoCounts(state.items);
  const completeWidth = counts.total === 0 ? 0 : Math.floor((counts.completed / counts.total) * width);
  const hasCurrent = counts.inProgress === 1 && completeWidth < width;
  const currentWidth = hasCurrent ? 1 : 0;
  const remainingWidth = Math.max(0, width - completeWidth - currentWidth);
  return theme.fg("success", "━".repeat(completeWidth))
    + (hasCurrent ? theme.fg("accent", "◆") : "")
    + theme.fg("borderMuted", "─".repeat(remainingWidth));
}

function itemHeight(item: TodoItem, width: number, allowTwoLines: boolean): number {
  if (item.status !== "in_progress" || !allowTwoLines) return 1;
  const prefixWidth = 7;
  return wrapTextWithAnsi(sanitizeDisplay(item.text), Math.max(1, width - prefixWidth)).length > 1 ? 2 : 1;
}

interface VisibleWindow {
  start: number;
  end: number;
}

function windowHeight(items: TodoItem[], start: number, end: number, width: number, allowTwoLines: boolean): number {
  const itemRows = items.slice(start, end).reduce((sum, item) => sum + itemHeight(item, width, allowTwoLines), 0);
  return itemRows + (start > 0 ? 1 : 0) + (end < items.length ? 1 : 0);
}

function visibleWindow(items: TodoItem[], rowBudget: number, width: number, allowTwoLines: boolean): VisibleWindow {
  if (windowHeight(items, 0, items.length, width, allowTwoLines) <= rowBudget) {
    return { start: 0, end: items.length };
  }

  const activeIndex = items.findIndex((item) => item.status === "in_progress");
  const pendingIndex = items.findIndex((item) => item.status === "pending");
  const focus = activeIndex >= 0 ? activeIndex : Math.max(0, pendingIndex);
  let start = focus;
  let end = focus + 1;
  let preferAfter = true;

  while (true) {
    const candidates = preferAfter
      ? [{ start, end: end + 1, valid: end < items.length }, { start: start - 1, end, valid: start > 0 }]
      : [{ start: start - 1, end, valid: start > 0 }, { start, end: end + 1, valid: end < items.length }];
    const candidate = candidates.find((next) => next.valid
      && windowHeight(items, next.start, next.end, width, allowTwoLines) <= rowBudget);
    if (!candidate) break;
    start = candidate.start;
    end = candidate.end;
    preferAfter = !preferAfter;
  }
  return { start, end };
}

function renderItem(item: TodoItem, index: number, width: number, allowTwoLines: boolean, theme: Theme): string[] {
  const number = String(index + 1).padStart(2, "0");
  const marker = item.status === "completed" ? "✓" : item.status === "in_progress" ? "◆" : "○";
  const markerColor = item.status === "completed" ? "success" : item.status === "in_progress" ? "accent" : "muted";
  const prefix = `${theme.fg(markerColor, marker)}  ${theme.fg("dim", number)}  `;
  const available = Math.max(1, width - visibleWidth(prefix));
  const cleanText = sanitizeDisplay(item.text);
  const wrapped = item.status === "in_progress" && allowTwoLines
    ? wrapTextWithAnsi(cleanText, available).slice(0, 2)
    : [truncateToWidth(cleanText, available, "…")];
  const textColor = item.status === "completed" ? "dim" : "text";
  return wrapped.map((line, lineIndex) => fitLine(
    (lineIndex === 0 ? prefix : " ".repeat(visibleWidth(prefix)))
      + theme.fg(textColor, item.status === "in_progress" ? theme.bold(line) : line),
    width,
  ));
}

export function createTodoWidget(tui: WidgetTui, theme: Theme, source: TodoState): Component {
  const state = { title: source.title, items: source.items.map((item) => ({ ...item })) };
  return {
    render(terminalWidth: number): string[] {
      const panelWidth = todoPanelWidth(terminalWidth);
      if (panelWidth < 8) return [fitLine("TODO", panelWidth)];
      const maxRows = todoWidgetRowBudget(tui.terminal.rows);
      const allowTwoLines = maxRows >= 7;
      const itemBudget = Math.max(1, maxRows - 2);
      const window = visibleWindow(state.items, itemBudget, panelWidth, allowTwoLines);
      const lines = [headerLine(state, panelWidth, theme), progressLine(state, panelWidth, theme)];
      if (window.start > 0) lines.push(theme.fg("dim", `… ${window.start} earlier`));
      for (let index = window.start; index < window.end; index += 1) {
        lines.push(...renderItem(state.items[index]!, index, panelWidth, allowTwoLines, theme));
      }
      if (window.end < state.items.length) lines.push(theme.fg("dim", `… ${state.items.length - window.end} later`));
      return lines.slice(0, maxRows).map((line) => fitLine(line, panelWidth));
    },
    invalidate(): void {},
  };
}

export function showTodoWidget(ui: ExtensionUIContext, state: TodoState): void {
  const snapshot = { title: state.title, items: state.items.map((item) => ({ ...item })) };
  ui.setWidget(WIDGET_KEY, (tui, theme) => createTodoWidget(tui, theme, snapshot), { placement: "aboveEditor" });
}

export function syncTodoWidget(
  context: { hasUI?: boolean; ui?: ExtensionUIContext },
  state: TodoState,
): TodoWidgetState {
  if (!context.hasUI || !context.ui) return "unavailable";
  if (state.items.some((item) => item.status !== "completed")) {
    showTodoWidget(context.ui, state);
    return "shown";
  }
  context.ui.setWidget(WIDGET_KEY, undefined);
  return "cleared";
}

export function hasCurrentTodo(state: TodoState): boolean {
  return currentTodo(state.items) !== undefined;
}
