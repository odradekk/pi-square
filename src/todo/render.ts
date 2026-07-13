import { stripVTControlCharacters } from "node:util";
import { keyHint, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import type { TodoAction, TodoDetails, TodoItem } from "./types";
import { TODO_LIMITS } from "./validation";

const ACTIONS: TodoAction[] = ["set", "add", "update", "start", "pause", "check", "uncheck", "clear", "list"];

class TodoResultComponent extends Container {}

function sanitizeDisplay(value: unknown): string {
  return stripVTControlCharacters(String(value ?? ""))
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "   ")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
}

function boundedDisplay(value: unknown, maximum: number): string {
  return Array.from(sanitizeDisplay(value)).slice(0, maximum).join("");
}

function inlineDisplay(value: unknown, maximum: number = TODO_LIMITS.text): string {
  return Array.from(sanitizeDisplay(value).replace(/\s+/g, " ").trim()).slice(0, maximum).join("");
}

function firstText(result: any): string {
  if (!Array.isArray(result?.content)) return "";
  return result.content
    .filter((item: any) => item?.type === "text" && typeof item.text === "string")
    .map((item: any) => item.text)
    .join("\n");
}

function itemValid(value: unknown): value is TodoItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<TodoItem>;
  return typeof item.id === "string"
    && Array.from(item.id).length <= TODO_LIMITS.id
    && typeof item.text === "string"
    && Array.from(item.text).length <= TODO_LIMITS.text
    && (item.status === "pending" || item.status === "in_progress" || item.status === "completed");
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function validDetails(value: unknown): TodoDetails | undefined {
  if (!value || typeof value !== "object") return undefined;
  const details = value as Partial<TodoDetails>;
  if (details.version !== 1 || details.stateVersion !== 2) return undefined;
  if (details.status !== "ok" && details.status !== "error") return undefined;
  if (!ACTIONS.includes(details.action as TodoAction) || typeof details.changed !== "boolean") return undefined;
  if (typeof details.title !== "string" || Array.from(details.title).length > TODO_LIMITS.title
    || !Array.isArray(details.items) || details.items.length > TODO_LIMITS.items || !details.items.every(itemValid)) return undefined;
  if (details.widget !== "shown" && details.widget !== "cleared" && details.widget !== "unavailable") return undefined;
  const counts = details.counts;
  if (!counts || !nonNegativeInteger(counts.total) || !nonNegativeInteger(counts.pending)
    || !nonNegativeInteger(counts.inProgress) || !nonNegativeInteger(counts.completed)) return undefined;
  if (counts.total !== details.items.length
    || counts.total !== counts.pending + counts.inProgress + counts.completed
    || counts.inProgress > 1) return undefined;
  const current = details.items.find((item) => item.status === "in_progress");
  if ((details.currentId ?? undefined) !== current?.id) return undefined;
  if (details.status === "error" && (!details.error
    || typeof details.error.code !== "string"
    || Array.from(details.error.code).length > TODO_LIMITS.id
    || typeof details.error.message !== "string"
    || Array.from(details.error.message).length > 1_000)) return undefined;
  return details as TodoDetails;
}

function actionTargets(args: any): string {
  if (typeof args?.id === "string") return inlineDisplay(args.id, TODO_LIMITS.id);
  if (Array.isArray(args?.ids)) {
    return args.ids.slice(0, TODO_LIMITS.items).map((id: unknown) => inlineDisplay(id, TODO_LIMITS.id)).filter(Boolean).join(", ");
  }
  return "";
}

function buildCallText(args: any, theme: Theme, expanded: boolean): string {
  const action = ACTIONS.includes(args?.action) ? args.action as TodoAction : "list";
  let output = theme.fg("toolTitle", theme.bold("TODO")) + "  " + theme.fg("accent", action);
  const target = actionTargets(args);
  if (target) output += theme.fg("muted", ` · ${target}`);
  if ((action === "set" || action === "add") && Array.isArray(args?.todos)) {
    output += theme.fg("muted", ` · ${args.todos.length} item${args.todos.length === 1 ? "" : "s"}`);
  }
  if (action === "check" && args?.advance === false) output += theme.fg("muted", " · no advance");
  if (!expanded) return output;

  if (typeof args?.title === "string") {
    output += `\n\n  ${theme.fg("muted", "Title")}  ${theme.fg("text", boundedDisplay(args.title, TODO_LIMITS.title))}`;
  }
  if (Array.isArray(args?.todos)) {
    args.todos.slice(0, TODO_LIMITS.items).forEach((item: any, index: number) => {
      const number = String(index + 1).padStart(2, "0");
      const status = item?.status === "completed" ? "completed" : item?.status === "in_progress" ? "in_progress" : "pending";
      output += `\n${theme.fg("dim", number)}  ${theme.fg("text", boundedDisplay(item?.text, TODO_LIMITS.text))}`;
      output += theme.fg("muted", `  [${status}${typeof item?.id === "string" ? ` · ${inlineDisplay(item.id, TODO_LIMITS.id)}` : ""}]`);
    });
    if (args.todos.length > TODO_LIMITS.items) {
      output += `\n${theme.fg("muted", `… ${args.todos.length - TODO_LIMITS.items} invalid excess items omitted`)}`;
    }
  } else if (typeof args?.text === "string") {
    output += `\n\n  ${theme.fg("muted", "Text")}  ${theme.fg("text", boundedDisplay(args.text, TODO_LIMITS.text))}`;
  }
  return output;
}

export function renderTodoCall(args: any, theme: Theme, context: any): Component {
  const component = context?.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
  component.setText(buildCallText(args, theme, Boolean(context?.expanded)));
  return component;
}

function summary(details: TodoDetails, theme: Theme): string {
  if (details.status === "error") {
    return theme.fg("error", `! ${details.error?.code ?? "TODO_ERROR"}: ${sanitizeDisplay(details.error?.message ?? "Todo failed")}`);
  }
  if (details.counts.total === 0) {
    return details.action === "clear"
      ? theme.fg("success", "✓ Todo list cleared")
      : theme.fg("dim", "No todos");
  }
  let output = theme.fg("success", "✓") + " " + theme.fg("text", `${details.counts.completed}/${details.counts.total} complete`);
  const currentIndex = details.currentId ? details.items.findIndex((item) => item.id === details.currentId) : -1;
  if (currentIndex >= 0) output += theme.fg("accent", ` · current ${String(currentIndex + 1).padStart(2, "0")}`);
  else if (details.counts.pending > 0) output += theme.fg("muted", " · paused");
  output += theme.fg("muted", ` · ${details.counts.pending} pending · ${details.changed ? "changed" : "unchanged"}`);
  return output;
}

function renderItem(item: TodoItem, index: number, theme: Theme): string {
  const marker = item.status === "completed" ? "✓" : item.status === "in_progress" ? "◆" : "○";
  const color = item.status === "completed" ? "success" : item.status === "in_progress" ? "accent" : "muted";
  const number = String(index + 1).padStart(2, "0");
  return `${theme.fg("dim", number)}  ${theme.fg(color, marker)} ${theme.fg(item.status === "completed" ? "dim" : "text", sanitizeDisplay(item.text))}`
    + theme.fg("dim", `  (${inlineDisplay(item.id)} · ${item.status})`);
}

function addHint(component: TodoResultComponent, theme: Theme, label: string): void {
  component.addChild({
    render(width: number): string[] {
      const hint = theme.fg("muted", "(") + keyHint("app.tools.expand", label) + theme.fg("muted", ")");
      return [truncateToWidth(hint, Math.max(1, width), "...")];
    },
    invalidate(): void {},
  });
}

export function renderTodoResult(
  result: any,
  options: { expanded: boolean; isPartial: boolean },
  theme: Theme,
  context: any,
): Component {
  const component = context?.lastComponent instanceof TodoResultComponent
    ? context.lastComponent
    : new TodoResultComponent();
  component.clear();
  const details = validDetails(result?.details);

  if (!details) {
    const fallback = sanitizeDisplay(firstText(result));
    if (options.expanded && fallback) {
      component.addChild(new Text(`\n${theme.fg("toolOutput", fallback)}`, 0, 0));
      addHint(component, theme, "to collapse");
    } else {
      const label = context?.isError ? inlineDisplay(fallback || "Todo failed") : "Todo result";
      component.addChild(new Text(`\n${theme.fg(context?.isError ? "error" : "muted", label)}`, 0, 0));
      if (fallback) addHint(component, theme, "to expand");
    }
    component.invalidate();
    return component;
  }

  component.addChild(new Text(`\n${summary(details, theme)}`, 0, 0));
  if (options.expanded && details.items.length > 0) {
    let body = `\n\n${theme.fg("toolTitle", theme.bold(sanitizeDisplay(details.title)))}`;
    body += `\n${details.items.map((item, index) => renderItem(item, index, theme)).join("\n")}`;
    component.addChild(new Text(body, 0, 0));
    addHint(component, theme, "to collapse");
  } else if (!options.expanded && details.items.length > 0) {
    addHint(component, theme, "to expand");
  }
  component.invalidate();
  return component;
}
