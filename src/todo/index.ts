import { stripVTControlCharacters } from "node:util";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { renderTodoCall, renderTodoResult } from "./render";
import {
  TODO_ENTRY_TYPE_V2,
  applyTodoAction,
  cloneTodoState,
  currentTodo,
  emptyTodoState,
  readTodoState,
  stateEntry,
  todoCounts,
} from "./state";
import type { TodoAction, TodoDetails, TodoError, TodoParams, TodoState } from "./types";
import { TODO_LIMITS, TodoOperationError } from "./validation";
import { syncTodoWidget } from "./widget";

const TodoIdSchema = Type.String({
  description: "Stable ASCII id used by later actions; generated as todo-N when omitted",
  minLength: 1,
  maxLength: TODO_LIMITS.id,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$",
});

const TodoTitleSchema = Type.String({
  description: "Concise title shown in the persistent widget",
  minLength: 1,
  maxLength: TODO_LIMITS.title,
});

const TodoTextSchema = Type.String({
  description: "Single-line task text",
  minLength: 1,
  maxLength: TODO_LIMITS.text,
});

const TODO_ACTIONS = [
  "set",
  "add",
  "update",
  "start",
  "pause",
  "check",
  "uncheck",
  "clear",
  "list",
] as const;

const TodoItemSchema = Type.Object({
  id: Type.Optional(TodoIdSchema),
  text: TodoTextSchema,
  status: Type.Optional(StringEnum(["pending", "in_progress", "completed"] as const, {
    description: "Initial state; defaults to pending",
    default: "pending",
  })),
}, { additionalProperties: false });

const TodoItemsSchema = Type.Array(TodoItemSchema, {
  description: "Items for set or add",
  minItems: 1,
  maxItems: TODO_LIMITS.items,
});

export const TodoParamsSchema = Type.Object({
  action: StringEnum(TODO_ACTIONS, {
    description:
      "set replaces the list; add appends; update changes text or title; start/pause select current work; "
      + "check/uncheck change completion; clear removes the list; list reads it",
  }),
  title: Type.Optional(TodoTitleSchema),
  todos: Type.Optional(TodoItemsSchema),
  id: Type.Optional(TodoIdSchema),
  ids: Type.Optional(Type.Array(TodoIdSchema, {
    description: "Multiple item ids for check or uncheck",
    minItems: 1,
    maxItems: TODO_LIMITS.items,
    uniqueItems: true,
  })),
  text: Type.Optional(TodoTextSchema),
  advance: Type.Optional(Type.Boolean({
    description: "Start the next pending item after checking the current item (default: true)",
    default: true,
  })),
}, {
  additionalProperties: false,
  description: "Manage the current session's bounded, persistent three-state task list",
});

function serialize(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function safeMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return stripVTControlCharacters(raw)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .slice(0, 1_000) || "Unknown todo failure";
}

function actionFromParams(params: unknown): TodoAction {
  if (params && typeof params === "object") {
    const action = (params as { action?: unknown }).action;
    if (TODO_ACTIONS.includes(action as TodoAction)) return action as TodoAction;
  }
  return "list";
}

function detailsFor(
  action: TodoAction,
  state: TodoState,
  widget: TodoDetails["widget"],
  changed: boolean,
  error?: TodoError,
): TodoDetails {
  const current = currentTodo(state.items);
  return {
    version: 1,
    status: error ? "error" : "ok",
    action,
    changed,
    stateVersion: 2,
    title: state.title,
    counts: todoCounts(state.items),
    ...(current ? { currentId: current.id } : {}),
    widget,
    items: state.items.map((item) => ({ ...item })),
    ...(error ? { error } : {}),
  };
}

function safeSyncWidget(context: any, state: TodoState): TodoDetails["widget"] {
  try {
    return syncTodoWidget(context, state);
  } catch {
    return "unavailable";
  }
}

interface TodoRuntime {
  tool: ToolDefinition<typeof TodoParamsSchema, TodoDetails>;
  restore(context: unknown): void;
}

export function createTodoRuntime(pi: Pick<ExtensionAPI, "appendEntry">): TodoRuntime {
  let state = emptyTodoState();
  let initialized = false;

  function restore(context: unknown): void {
    state = readTodoState(context);
    initialized = true;
    safeSyncWidget(context, state);
  }

  const tool: ToolDefinition<typeof TodoParamsSchema, TodoDetails> = {
    name: "todo",
    label: "Todo",
    description:
      "Create and maintain a bounded three-state task list for the current Pi session. "
      + "The Agent owns updates; incomplete work remains visible in a read-only above-editor widget. "
      + "Returns versioned JSON with the complete current snapshot.",
    promptSnippet:
      "Use todo for non-trivial work: set a concise plan, keep one item in progress, check items promptly, and pause when waiting.",
    promptGuidelines: [
      "Before non-trivial multi-step work, call todo with action=set and 2-6 short, verifiable items; the first pending item starts automatically.",
      "Complete the current item with action=check; the next pending item starts automatically unless advance is false.",
      "Use action=start to switch current work, action=pause while waiting, action=add for newly discovered work, and action=update only for text or title changes.",
      "Use action=list before replacing an existing list, and action=clear only when abandoning work or when a completed list no longer needs a snapshot.",
      "Todo ids are stable ASCII identifiers. Omit ids when generated todo-N ids are sufficient.",
    ],
    executionMode: "sequential",
    parameters: TodoParamsSchema,

    async execute(_toolCallId, params, _signal, _onUpdate, context) {
      if (!initialized) {
        state = readTodoState(context);
        initialized = true;
      }
      const action = actionFromParams(params);
      const previous = cloneTodoState(state);

      try {
        const transition = applyTodoAction(previous, params as TodoParams);
        if (transition.changed) {
          try {
            pi.appendEntry(TODO_ENTRY_TYPE_V2, stateEntry(transition.state));
          } catch (error) {
            throw new TodoOperationError("TODO_PERSISTENCE_FAILED", safeMessage(error));
          }
          state = transition.state;
        }
        const widget = safeSyncWidget(context, state);
        const details = detailsFor(action, state, widget, transition.changed);
        return {
          content: [{ type: "text" as const, text: serialize(details) }],
          details,
        };
      } catch (error) {
        const todoError: TodoError = error instanceof TodoOperationError
          ? { code: error.code, message: error.message }
          : { code: "TODO_INTERNAL_ERROR", message: safeMessage(error) };
        state = previous;
        const widget = safeSyncWidget(context, state);
        const details = detailsFor(action, state, widget, false, todoError);
        return {
          content: [{ type: "text" as const, text: serialize(details) }],
          isError: true,
          details,
        };
      }
    },

    renderCall(args, theme, context) {
      return renderTodoCall(args, theme, context);
    },
    renderResult(result, options, theme, context) {
      return renderTodoResult(result, options, theme, context);
    },
  };

  return { tool, restore };
}

export default function registerTodo(pi: ExtensionAPI): void {
  const runtime = createTodoRuntime(pi);
  pi.on("session_start", (_event, context) => runtime.restore(context));
  pi.on("session_tree", (_event, context) => runtime.restore(context));
  pi.registerTool(runtime.tool);
}
