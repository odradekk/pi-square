import type {
  TodoAction,
  TodoCounts,
  TodoItem,
  TodoParams,
  TodoState,
  TodoStateEntryV1,
  TodoStateEntryV2,
  TodoTransition,
} from "./types";
import {
  TODO_LIMITS,
  TodoOperationError,
  assertKnownIds,
  assertOnlyKeys,
  assertRecord,
  assertSingleInProgress,
  normalizeInputItems,
  normalizeTargetIds,
  normalizeTitle,
  normalizeTodoId,
  normalizeTodoText,
} from "./validation";

export const DEFAULT_TODO_TITLE = "Tasks";
export const TODO_ENTRY_TYPE_V1 = "pi-square.todo.v1";
export const TODO_ENTRY_TYPE_V2 = "pi-square.todo.v2";

export function emptyTodoState(): TodoState {
  return { title: DEFAULT_TODO_TITLE, items: [] };
}

export function cloneTodoState(state: TodoState): TodoState {
  return { title: state.title, items: state.items.map((item) => ({ ...item })) };
}

export function todoCounts(items: TodoItem[]): TodoCounts {
  return {
    total: items.length,
    pending: items.filter((item) => item.status === "pending").length,
    inProgress: items.filter((item) => item.status === "in_progress").length,
    completed: items.filter((item) => item.status === "completed").length,
  };
}

export function currentTodo(items: TodoItem[]): TodoItem | undefined {
  return items.find((item) => item.status === "in_progress");
}

function statesEqual(left: TodoState, right: TodoState): boolean {
  return left.title === right.title
    && left.items.length === right.items.length
    && left.items.every((item, index) => {
      const other = right.items[index];
      return other?.id === item.id && other.text === item.text && other.status === item.status;
    });
}

function finish(previous: TodoState, next: TodoState): TodoTransition {
  assertSingleInProgress(next.items);
  return { state: next, changed: !statesEqual(previous, next) };
}

function activateFirstPending(items: TodoItem[], startAfter = -1): TodoItem[] {
  if (items.some((item) => item.status === "in_progress")) return items;
  const candidateIndexes = [
    ...items.map((_item, index) => index).filter((index) => index > startAfter),
    ...items.map((_item, index) => index).filter((index) => index <= startAfter),
  ];
  const index = candidateIndexes.find((candidate) => items[candidate]?.status === "pending");
  if (index === undefined) return items;
  return items.map((item, itemIndex) => itemIndex === index ? { ...item, status: "in_progress" } : item);
}

function requireAction(params: Record<string, unknown>): TodoAction {
  const actions: TodoAction[] = ["set", "add", "update", "start", "pause", "check", "uncheck", "clear", "list"];
  if (!actions.includes(params.action as TodoAction)) {
    throw new TodoOperationError("TODO_INVALID_INPUT", `unsupported todo action: ${String(params.action)}`);
  }
  return params.action as TodoAction;
}

export function applyTodoAction(previous: TodoState, rawParams: unknown): TodoTransition {
  assertRecord(rawParams, "parameters");
  const action = requireAction(rawParams);
  const params = rawParams as Record<string, unknown> & TodoParams;

  switch (action) {
    case "set": {
      assertOnlyKeys(params, ["action", "title", "todos"]);
      const title = params.title === undefined ? DEFAULT_TODO_TITLE : normalizeTitle(params.title);
      let items = normalizeInputItems(params.todos, new Set());
      assertSingleInProgress(items);
      items = activateFirstPending(items);
      return finish(previous, { title, items });
    }

    case "add": {
      assertOnlyKeys(params, ["action", "todos"]);
      if (!Array.isArray(params.todos) || previous.items.length + params.todos.length > TODO_LIMITS.items) {
        throw new TodoOperationError("TODO_ITEM_LIMIT", `a todo list may contain at most ${TODO_LIMITS.items} items`);
      }
      const added = normalizeInputItems(params.todos, new Set(previous.items.map((item) => item.id)));
      let items = [...previous.items.map((item) => ({ ...item })), ...added];
      assertSingleInProgress(items);
      if (previous.items.every((item) => item.status === "completed")) items = activateFirstPending(items);
      return finish(previous, { title: previous.title, items });
    }

    case "update": {
      assertOnlyKeys(params, ["action", "id", "text", "title"]);
      const hasTitle = Object.prototype.hasOwnProperty.call(params, "title");
      const hasText = Object.prototype.hasOwnProperty.call(params, "text");
      const hasId = Object.prototype.hasOwnProperty.call(params, "id");
      if (!hasTitle && !hasText) {
        throw new TodoOperationError("TODO_INVALID_INPUT", "update requires title and/or text");
      }
      if (hasText !== hasId) {
        throw new TodoOperationError("TODO_INVALID_INPUT", "updating text requires exactly one id");
      }
      if (hasId && !hasText) {
        throw new TodoOperationError("TODO_INVALID_INPUT", "id is only valid when updating text");
      }

      const title = hasTitle ? normalizeTitle(params.title) : previous.title;
      let items = previous.items.map((item) => ({ ...item }));
      if (hasText) {
        const id = normalizeTodoId(params.id);
        assertKnownIds(items, [id]);
        const text = normalizeTodoText(params.text);
        items = items.map((item) => item.id === id ? { ...item, text } : item);
      }
      return finish(previous, { title, items });
    }

    case "start": {
      assertOnlyKeys(params, ["action", "id"]);
      const id = normalizeTodoId(params.id);
      assertKnownIds(previous.items, [id]);
      const target = previous.items.find((item) => item.id === id)!;
      if (target.status === "completed") {
        throw new TodoOperationError("TODO_STATE_CONFLICT", `completed todo ${JSON.stringify(id)} must be unchecked before it can start`);
      }
      const items = previous.items.map((item) => {
        if (item.id === id) return { ...item, status: "in_progress" as const };
        if (item.status === "in_progress") return { ...item, status: "pending" as const };
        return { ...item };
      });
      return finish(previous, { title: previous.title, items });
    }

    case "pause": {
      assertOnlyKeys(params, ["action"]);
      const items = previous.items.map((item) => item.status === "in_progress"
        ? { ...item, status: "pending" as const }
        : { ...item });
      return finish(previous, { title: previous.title, items });
    }

    case "check": {
      assertOnlyKeys(params, ["action", "id", "ids", "advance"]);
      if (params.advance !== undefined && typeof params.advance !== "boolean") {
        throw new TodoOperationError("TODO_INVALID_INPUT", "advance must be a boolean");
      }
      const ids = normalizeTargetIds(params);
      assertKnownIds(previous.items, ids);
      const targets = new Set(ids);
      const activeIndex = previous.items.findIndex((item) => item.status === "in_progress");
      const completesActive = activeIndex >= 0 && targets.has(previous.items[activeIndex]!.id);
      let items = previous.items.map((item) => targets.has(item.id)
        ? { ...item, status: "completed" as const }
        : { ...item });
      if (completesActive && params.advance !== false) items = activateFirstPending(items, activeIndex);
      return finish(previous, { title: previous.title, items });
    }

    case "uncheck": {
      assertOnlyKeys(params, ["action", "id", "ids"]);
      const ids = normalizeTargetIds(params);
      assertKnownIds(previous.items, ids);
      const targets = new Set(ids);
      const reopened = new Set(previous.items
        .filter((item) => targets.has(item.id) && item.status === "completed")
        .map((item) => item.id));
      let items = previous.items.map((item) => reopened.has(item.id)
        ? { ...item, status: "pending" as const }
        : { ...item });
      if (!items.some((item) => item.status === "in_progress") && reopened.size > 0) {
        const firstReopened = items.findIndex((item) => reopened.has(item.id));
        items = items.map((item, index) => index === firstReopened
          ? { ...item, status: "in_progress" as const }
          : item);
      }
      return finish(previous, { title: previous.title, items });
    }

    case "clear":
      assertOnlyKeys(params, ["action"]);
      return finish(previous, emptyTodoState());

    case "list":
      assertOnlyKeys(params, ["action"]);
      return finish(previous, cloneTodoState(previous));
  }
}

function legacyId(value: unknown, used: Set<string>): string {
  const candidate = typeof value === "string"
    ? value.trim().replace(/\s+/g, "-").replace(/[^A-Za-z0-9._-]/g, "-").replace(/^-+/, "")
    : "";
  let base = candidate.slice(0, TODO_LIMITS.id);
  if (!base || !/^[A-Za-z0-9]/u.test(base)) base = "todo";
  let id = base;
  let suffix = 2;
  while (used.has(id)) {
    const tail = `-${suffix}`;
    id = `${base.slice(0, TODO_LIMITS.id - tail.length)}${tail}`;
    suffix += 1;
  }
  used.add(id);
  return id;
}

function safeLegacyText(value: unknown, maximum: number, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const cleaned = value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").replace(/\s+/g, " ").trim();
  return Array.from(cleaned || fallback).slice(0, maximum).join("");
}

function parseV1(value: unknown): TodoState | null {
  if (!value || typeof value !== "object") return null;
  const data = value as TodoStateEntryV1;
  if (data.version !== 1 || !Array.isArray(data.items)) return null;
  const used = new Set<string>();
  const items = data.items.slice(0, TODO_LIMITS.items).flatMap((item) => {
    if (!item || typeof item.text !== "string") return [];
    return [{
      id: legacyId(item.id, used),
      text: safeLegacyText(item.text, TODO_LIMITS.text, "Untitled task"),
      status: item.completed === true ? "completed" as const : "pending" as const,
    }];
  });
  return {
    title: safeLegacyText(data.title, TODO_LIMITS.title, DEFAULT_TODO_TITLE),
    items,
  };
}

function parseV2(value: unknown): TodoState | null {
  if (!value || typeof value !== "object") return null;
  const data = value as TodoStateEntryV2;
  if (data.version !== 2 || !Array.isArray(data.items) || data.items.length > TODO_LIMITS.items) return null;
  try {
    const title = normalizeTitle(data.title);
    const used = new Set<string>();
    const items = data.items.map((item, index) => {
      assertRecord(item, `items[${index}]`);
      assertOnlyKeys(item, ["id", "text", "status"], `items[${index}]`);
      const id = normalizeTodoId(item.id, `items[${index}].id`);
      if (used.has(id)) throw new TodoOperationError("TODO_DUPLICATE_ID", `todo id ${JSON.stringify(id)} is duplicated`);
      used.add(id);
      if (item.status !== "pending" && item.status !== "in_progress" && item.status !== "completed") {
        throw new TodoOperationError("TODO_INVALID_INPUT", `items[${index}].status is invalid`);
      }
      return { id, text: normalizeTodoText(item.text, `items[${index}].text`), status: item.status };
    });
    assertSingleInProgress(items);
    return { title, items };
  } catch {
    return null;
  }
}

export function readTodoState(context: unknown): TodoState {
  const branch = (context as { sessionManager?: { getBranch?: () => unknown[] } })?.sessionManager?.getBranch?.();
  if (!Array.isArray(branch)) return emptyTodoState();

  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index] as { type?: unknown; customType?: unknown; data?: unknown } | undefined;
    if (entry?.type !== "custom") continue;
    if (entry.customType === TODO_ENTRY_TYPE_V2) {
      return parseV2(entry.data) ?? emptyTodoState();
    }
    if (entry.customType === TODO_ENTRY_TYPE_V1) {
      return parseV1(entry.data) ?? emptyTodoState();
    }
  }
  return emptyTodoState();
}

export function stateEntry(state: TodoState): TodoStateEntryV2 {
  return { version: 2, title: state.title, items: state.items.map((item) => ({ ...item })) };
}
