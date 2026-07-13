import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ── Types ────────────────────────────────────────────────────────────────

type TodoAction = "create" | "set" | "replace" | "add" | "update" | "check" | "uncheck" | "clear" | "list" | "status";
type WidgetState = "shown" | "cleared" | "unavailable";

interface TodoInputItem {
  id?: string;
  text?: string;
  completed?: boolean;
}

interface TodoItem {
  id: string;
  text: string;
  completed: boolean;
}

interface TodoDetails {
  action: TodoAction;
  title: string;
  totalCount: number;
  completedCount: number;
  incompleteCount: number;
  widget: WidgetState;
  items: TodoItem[];
  error?: string;
}

// ── Schema ───────────────────────────────────────────────────────────────

const TodoActionSchema = Type.Union([
  Type.Literal("create"),
  Type.Literal("set"),
  Type.Literal("replace"),
  Type.Literal("add"),
  Type.Literal("update"),
  Type.Literal("check"),
  Type.Literal("uncheck"),
  Type.Literal("clear"),
  Type.Literal("list"),
  Type.Literal("status"),
], {
  description:
    "create/set/replace = replace the current list; add = append items; " +
    "update = edit text and/or completion; check/uncheck = mark items; " +
    "clear = remove all todos and close the widget; list/status = read current todos.",
});

const TodoItemSchema = Type.Object({
  id: Type.Optional(Type.String({
    description: "Stable id used later by update/check/uncheck. If omitted, an id like todo-1 is generated.",
  })),
  text: Type.String({ description: "Todo item text shown in the widget" }),
  completed: Type.Optional(Type.Boolean({ description: "Whether this item is already complete (default: false)" })),
});

const TodoParams = Type.Object({
  action: TodoActionSchema,
  title: Type.Optional(Type.String({ description: "Optional title shown at the top of the persistent todo widget" })),
  todos: Type.Optional(Type.Array(TodoItemSchema, {
    description: "Items for create/set/replace, or items to append for add",
  })),
  id: Type.Optional(Type.String({ description: "Single item id for update/check/uncheck" })),
  ids: Type.Optional(Type.Array(Type.String(), { description: "Multiple item ids for update/check/uncheck" })),
  text: Type.Optional(Type.String({ description: "New text for update, or a single item text for add" })),
  completed: Type.Optional(Type.Boolean({ description: "Completion state for update" })),
});

// ── Widget rendering ─────────────────────────────────────────────────────

const DEFAULT_TITLE = "Task Todo";
const WIDGET_KEY = "todo";

function showTodoWidget(ui: ExtensionUIContext, title: string, items: TodoItem[]): void {
  const snapshot = {
    title,
    items: items.map((item) => ({ ...item })),
  };

  if (!snapshot.items.some((item) => !item.completed)) {
    ui.setWidget(WIDGET_KEY, undefined);
    return;
  }

  ui.setWidget(WIDGET_KEY, (_tui, theme) => {
    return {
      render(width: number): string[] {
        if (width < 8) return [truncateToWidth(snapshot.title, Math.max(1, width))];

        const completed = snapshot.items.filter((item) => item.completed).length;
        const total = snapshot.items.length;
        const ratioColor = completed > 0 ? "accent" : "dim";
        const header =
          theme.fg("accent", "● ") +
          theme.fg("text", snapshot.title) +
          theme.fg("borderMuted", " · ") +
          theme.fg(ratioColor, `${completed}/${total} done`);
        const out: string[] = [truncateToWidth(header, width), theme.fg("borderMuted", "─".repeat(width))];

        for (const item of snapshot.items) {
          const mark = item.completed ? theme.fg("success", "✓") : theme.fg("dim", "○");
          const id = theme.fg("muted", item.id);
          const separator = theme.fg("borderMuted", " · ");
          const text = theme.fg(item.completed ? "dim" : "text", item.text);
          out.push(truncateToWidth(`${mark} ${id}${separator}${text}`, width));
        }
        return out;
      },

      invalidate(): void {},
    };
  }, { placement: "aboveEditor" });
}

function syncWidget(ctx: any, title: string, items: TodoItem[]): WidgetState {
  const hasUI = Boolean(ctx?.hasUI && ctx.ui);
  if (!hasUI) return "unavailable";

  if (items.some((item) => !item.completed)) {
    showTodoWidget(ctx.ui, title, items);
    return "shown";
  }

  ctx.ui.setWidget(WIDGET_KEY, undefined);
  return "cleared";
}

// ── Pi session persistence ───────────────────────────────────────────────

const TODO_ENTRY_TYPE = "pi-square.todo.v1";

interface TodoStateEntry {
  version: 1;
  title: string;
  items: TodoItem[];
}

function readBranchState(ctx: any): { title: string; items: TodoItem[] } | null {
  const entries: any[] = ctx?.sessionManager?.getBranch?.() ?? [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== "custom" || entry.customType !== TODO_ENTRY_TYPE) continue;
    const data = entry.data as TodoStateEntry | undefined;
    if (data?.version !== 1 || typeof data.title !== "string" || !Array.isArray(data.items)) return null;

    const usedIds = new Set<string>();
    const items: TodoItem[] = [];
    for (const item of data.items) {
      if (!item || typeof item.id !== "string" || typeof item.text !== "string") continue;
      const id = normalizeId(item.id);
      const text = item.text.trim();
      if (!id || !text || usedIds.has(id)) continue;
      usedIds.add(id);
      items.push({ id, text, completed: item.completed === true });
    }
    return { title: data.title.trim() || DEFAULT_TITLE, items };
  }
  return null;
}

// ── State helpers ────────────────────────────────────────────────────────

function normalizeId(id: string): string {
  return id.trim().replace(/\s+/g, "-");
}

function nextGeneratedId(used: Set<string>): string {
  let i = 1;
  while (used.has(`todo-${i}`)) i++;
  return `todo-${i}`;
}

function makeUniqueId(base: string, used: Set<string>): string {
  const normalized = normalizeId(base);
  let id = normalized || nextGeneratedId(used);
  if (!used.has(id)) return id;

  let i = 2;
  while (used.has(`${id}-${i}`)) i++;
  return `${id}-${i}`;
}

function normalizeInputItems(rawItems: TodoInputItem[], usedIds: Set<string>): TodoItem[] {
  return rawItems.map((raw) => {
    const text = typeof raw.text === "string" ? raw.text.trim() : "";
    if (!text) throw new Error("Todo item text must be a non-empty string.");

    const baseId = typeof raw.id === "string" && raw.id.trim()
      ? raw.id
      : nextGeneratedId(usedIds);
    const id = makeUniqueId(baseId, usedIds);
    usedIds.add(id);

    return {
      id,
      text,
      completed: raw.completed === true,
    };
  });
}

function idsFromParams(params: any): string[] {
  const ids = new Set<string>();
  if (typeof params.id === "string" && params.id.trim()) ids.add(normalizeId(params.id));
  if (Array.isArray(params.ids)) {
    for (const id of params.ids) {
      if (typeof id === "string" && id.trim()) ids.add(normalizeId(id));
    }
  }
  return [...ids];
}

function snapshotDetails(action: TodoAction, title: string, items: TodoItem[], widget: WidgetState, error?: string): TodoDetails {
  const completedCount = items.filter((item) => item.completed).length;
  return {
    action,
    title,
    totalCount: items.length,
    completedCount,
    incompleteCount: items.length - completedCount,
    widget,
    items: items.map((item) => ({ ...item })),
    ...(error ? { error } : {}),
  };
}

function formatTodoStatus(details: TodoDetails): string {
  if (details.error) {
    return `Error: ${details.error}`;
  }

  if (details.items.length === 0) {
    const widgetNote = details.widget === "unavailable"
      ? "Widget unavailable (no interactive UI)."
      : "Widget cleared.";
    return `No active todos. ${widgetNote}`;
  }

  const lines = [
    `# ${details.title}`,
    `${details.completedCount}/${details.totalCount} completed. Widget: ${details.widget}.`,
    "",
    ...details.items.map((item) => `- [${item.completed ? "x" : " "}] ${item.id}: ${item.text}`),
  ];
  return lines.join("\n");
}

// ── Extension ────────────────────────────────────────────────────────────

export default function todo(pi: ExtensionAPI) {
  let title = DEFAULT_TITLE;
  let items: TodoItem[] = [];
  let initialized = false;

  function restoreSessionState(ctx: any): void {
    const restored = readBranchState(ctx);
    title = restored?.title ?? DEFAULT_TITLE;
    items = restored?.items ?? [];
    initialized = true;
  }

  function restoreAndSync(ctx: any): void {
    restoreSessionState(ctx);
    syncWidget(ctx, title, items);
  }

  pi.on("session_start", (_event, ctx) => restoreAndSync(ctx));
  pi.on("session_tree", (_event, ctx) => restoreAndSync(ctx));

  pi.registerTool({
    name: "todo",
    label: "Todo",
    description:
      "Create, update, check off, clear, or inspect the current Pi session todo list. " +
      "When any todo item is incomplete, the current list is displayed as a persistent above-editor widget. " +
      "The widget automatically closes when every item is complete or when the list is cleared.",
    promptSnippet:
      "Use todo to maintain a concise task checklist. Incomplete todos stay visible above the editor; " +
      "mark each item complete as soon as it is done.",
    promptGuidelines: [
      "Before starting a non-trivial or multi-step task, call todo with action=list to inspect any current list, then action=create/set to publish the planned checklist.",
      "Keep todo items short, concrete, and verifiable; prefer 2-6 items for normal coding tasks.",
      "After finishing each listed item, immediately call todo with action=check and that item's id.",
      "Use action=update when the plan changes, action=add when a new necessary step appears, and action=clear only when abandoning the list or after the task no longer needs a visible checklist.",
      "Route questions to the user through ask; reserve todo for task state.",
    ],
    executionMode: "sequential",
    parameters: TodoParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!initialized) restoreSessionState(ctx);

      const action = params.action as TodoAction;
      let error: string | undefined;
      let mutated = false;

      try {
        const nextTitle = typeof params.title === "string" && params.title.trim()
          ? params.title.trim()
          : undefined;

        switch (action) {
          case "create":
          case "set":
          case "replace": {
            if (!Array.isArray(params.todos)) {
              throw new Error("action=create/set/replace requires a todos array.");
            }
            title = nextTitle ?? DEFAULT_TITLE;
            items = normalizeInputItems(params.todos, new Set<string>());
            mutated = true;
            break;
          }

          case "add": {
            const rawItems: TodoInputItem[] = Array.isArray(params.todos)
              ? params.todos
              : (typeof params.text === "string" ? [{ id: params.id, text: params.text, completed: params.completed }] : []);
            if (rawItems.length === 0) {
              throw new Error("action=add requires todos or text.");
            }
            if (nextTitle) title = nextTitle;
            items = items.concat(normalizeInputItems(rawItems, new Set(items.map((item) => item.id))));
            mutated = true;
            break;
          }

          case "update": {
            const targetIds = idsFromParams(params);
            if (targetIds.length === 0) throw new Error("action=update requires id or ids.");
            const missing = targetIds.filter((id) => !items.some((item) => item.id === id));
            if (missing.length > 0) throw new Error(`Unknown todo id(s): ${missing.join(", ")}.`);

            const hasText = typeof params.text === "string";
            const hasCompleted = typeof params.completed === "boolean";
            if (!hasText && !hasCompleted && !nextTitle) {
              throw new Error("action=update requires text, completed, or title.");
            }
            const newText = hasText ? String(params.text).trim() : undefined;
            if (hasText && !newText) throw new Error("Updated todo text must be non-empty.");
            if (nextTitle) title = nextTitle;

            items = items.map((item) => targetIds.includes(item.id)
              ? {
                ...item,
                ...(newText ? { text: newText } : {}),
                ...(hasCompleted ? { completed: params.completed } : {}),
              }
              : item,
            );
            mutated = true;
            break;
          }

          case "check":
          case "uncheck": {
            const targetIds = idsFromParams(params);
            if (targetIds.length === 0) throw new Error(`action=${action} requires id or ids.`);
            const missing = targetIds.filter((id) => !items.some((item) => item.id === id));
            if (missing.length > 0) throw new Error(`Unknown todo id(s): ${missing.join(", ")}.`);
            if (nextTitle) title = nextTitle;
            const completed = action === "check";
            items = items.map((item) => targetIds.includes(item.id) ? { ...item, completed } : item);
            mutated = true;
            break;
          }

          case "clear":
            title = nextTitle ?? DEFAULT_TITLE;
            items = [];
            mutated = true;
            break;

          case "list":
          case "status":
            if (nextTitle) {
              title = nextTitle;
              mutated = true;
            }
            break;

          default:
            throw new Error(`Unsupported todo action: ${String(action)}.`);
        }

        if (mutated) {
          const snapshot: TodoStateEntry = {
            version: 1,
            title,
            items: items.map((item) => ({ ...item })),
          };
          pi.appendEntry(TODO_ENTRY_TYPE, snapshot);
        }
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }

      const widget = syncWidget(ctx, title, items);
      const details = snapshotDetails(action, title, items, widget, error);

      return {
        content: [{ type: "text" as const, text: formatTodoStatus(details) }],
        details,
      };
    },
  });
}
