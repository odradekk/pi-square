import type { TodoErrorCode, TodoInputItem, TodoItem, TodoStatus } from "./types";

export const TODO_LIMITS = Object.freeze({
  items: 20,
  id: 64,
  title: 120,
  text: 500,
});

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;
const TODO_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const ITEM_KEYS = new Set(["id", "text", "status"]);

export class TodoOperationError extends Error {
  readonly code: TodoErrorCode;

  constructor(code: TodoErrorCode, message: string) {
    super(message);
    this.name = "TodoOperationError";
    this.code = code;
  }
}

export function countCharacters(value: string): number {
  return Array.from(value).length;
}

export function assertRecord(value: unknown, field: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TodoOperationError("TODO_INVALID_INPUT", `${field} must be an object`);
  }
}

export function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], field = "parameters"): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) {
    throw new TodoOperationError("TODO_INVALID_INPUT", `${field} contains unknown field(s): ${unknown.join(", ")}`);
  }
}

function normalizeDisplayString(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string") {
    throw new TodoOperationError("TODO_INVALID_INPUT", `${field} must be a string`);
  }
  if (CONTROL_CHARACTERS.test(value)) {
    throw new TodoOperationError("TODO_INVALID_INPUT", `${field} contains unsupported control characters`);
  }
  const normalized = value.trim();
  if (!normalized) throw new TodoOperationError("TODO_INVALID_INPUT", `${field} must not be blank`);
  if (countCharacters(normalized) > maximum) {
    throw new TodoOperationError("TODO_INVALID_INPUT", `${field} must be at most ${maximum} characters`);
  }
  return normalized;
}

export function normalizeTitle(value: unknown, field = "title"): string {
  return normalizeDisplayString(value, field, TODO_LIMITS.title);
}

export function normalizeTodoText(value: unknown, field = "text"): string {
  return normalizeDisplayString(value, field, TODO_LIMITS.text);
}

export function normalizeTodoId(value: unknown, field = "id"): string {
  if (typeof value !== "string") {
    throw new TodoOperationError("TODO_INVALID_INPUT", `${field} must be a string`);
  }
  if (countCharacters(value) < 1 || countCharacters(value) > TODO_LIMITS.id || !TODO_ID.test(value)) {
    throw new TodoOperationError(
      "TODO_INVALID_INPUT",
      `${field} must be 1-${TODO_LIMITS.id} characters using letters, numbers, dot, underscore, or hyphen`,
    );
  }
  return value;
}

function normalizeStatus(value: unknown, field: string): TodoStatus {
  if (value === undefined) return "pending";
  if (value === "pending" || value === "in_progress" || value === "completed") return value;
  throw new TodoOperationError("TODO_INVALID_INPUT", `${field} must be pending, in_progress, or completed`);
}

function nextGeneratedId(usedIds: Set<string>): string {
  let index = 1;
  while (usedIds.has(`todo-${index}`)) index += 1;
  return `todo-${index}`;
}

export function normalizeInputItems(
  value: unknown,
  usedIds: Set<string>,
  field = "todos",
): TodoItem[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > TODO_LIMITS.items) {
    throw new TodoOperationError(
      "TODO_ITEM_LIMIT",
      `${field} must contain between 1 and ${TODO_LIMITS.items} items`,
    );
  }

  const reservedIds = new Set(usedIds);
  const normalized = value.map((raw: TodoInputItem, index) => {
    const itemField = `${field}[${index}]`;
    assertRecord(raw, itemField);
    const unknown = Object.keys(raw).filter((key) => !ITEM_KEYS.has(key));
    if (unknown.length > 0) {
      throw new TodoOperationError("TODO_INVALID_INPUT", `${itemField} contains unknown field(s): ${unknown.join(", ")}`);
    }

    const id = raw.id === undefined ? undefined : normalizeTodoId(raw.id, `${itemField}.id`);
    if (id && reservedIds.has(id)) {
      throw new TodoOperationError("TODO_DUPLICATE_ID", `todo id ${JSON.stringify(id)} is duplicated`);
    }
    if (id) reservedIds.add(id);
    return {
      id,
      text: normalizeTodoText(raw.text, `${itemField}.text`),
      status: normalizeStatus(raw.status, `${itemField}.status`),
    };
  });

  return normalized.map((item) => {
    const id = item.id ?? nextGeneratedId(reservedIds);
    reservedIds.add(id);
    usedIds.add(id);
    return { ...item, id };
  });
}

export function normalizeTargetIds(params: Record<string, unknown>): string[] {
  const hasId = Object.prototype.hasOwnProperty.call(params, "id");
  const hasIds = Object.prototype.hasOwnProperty.call(params, "ids");
  if (hasId === hasIds) {
    throw new TodoOperationError("TODO_INVALID_INPUT", "provide exactly one of id or ids");
  }
  if (hasId) return [normalizeTodoId(params.id)];
  if (!Array.isArray(params.ids) || params.ids.length < 1 || params.ids.length > TODO_LIMITS.items) {
    throw new TodoOperationError("TODO_INVALID_INPUT", `ids must contain between 1 and ${TODO_LIMITS.items} values`);
  }

  const ids = params.ids.map((id, index) => normalizeTodoId(id, `ids[${index}]`));
  if (new Set(ids).size !== ids.length) {
    throw new TodoOperationError("TODO_DUPLICATE_ID", "ids must contain unique values");
  }
  return ids;
}

export function assertSingleInProgress(items: TodoItem[]): void {
  if (items.filter((item) => item.status === "in_progress").length > 1) {
    throw new TodoOperationError("TODO_STATE_CONFLICT", "a todo list may contain at most one in_progress item");
  }
}

export function assertKnownIds(items: TodoItem[], ids: string[]): void {
  const known = new Set(items.map((item) => item.id));
  const missing = ids.filter((id) => !known.has(id));
  if (missing.length > 0) {
    throw new TodoOperationError("TODO_UNKNOWN_ID", `unknown todo id(s): ${missing.join(", ")}`);
  }
}
