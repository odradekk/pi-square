export type TodoAction =
  | "set"
  | "add"
  | "update"
  | "start"
  | "pause"
  | "check"
  | "uncheck"
  | "clear"
  | "list";

export type TodoStatus = "pending" | "in_progress" | "completed";
export type TodoWidgetState = "shown" | "cleared" | "unavailable";

export interface TodoInputItem {
  id?: string;
  text: string;
  status?: TodoStatus;
}

export interface TodoItem {
  id: string;
  text: string;
  status: TodoStatus;
}

export interface TodoState {
  title: string;
  items: TodoItem[];
}

export interface TodoCounts {
  total: number;
  pending: number;
  inProgress: number;
  completed: number;
}

export type TodoErrorCode =
  | "TODO_INVALID_INPUT"
  | "TODO_DUPLICATE_ID"
  | "TODO_ITEM_LIMIT"
  | "TODO_UNKNOWN_ID"
  | "TODO_STATE_CONFLICT"
  | "TODO_PERSISTENCE_FAILED"
  | "TODO_INTERNAL_ERROR";

export interface TodoError {
  code: TodoErrorCode;
  message: string;
}

export interface TodoDetails {
  version: 1;
  status: "ok" | "error";
  action: TodoAction;
  changed: boolean;
  stateVersion: 2;
  title: string;
  counts: TodoCounts;
  currentId?: string;
  widget: TodoWidgetState;
  items: TodoItem[];
  error?: TodoError;
}

export type TodoParams =
  | { action: "set"; title?: string; todos: TodoInputItem[] }
  | { action: "add"; todos: TodoInputItem[] }
  | { action: "update"; id?: string; text?: string; title?: string }
  | { action: "start"; id: string }
  | { action: "pause" }
  | { action: "check"; id?: string; ids?: string[]; advance?: boolean }
  | { action: "uncheck"; id?: string; ids?: string[] }
  | { action: "clear" }
  | { action: "list" };

export interface TodoTransition {
  state: TodoState;
  changed: boolean;
}

export interface TodoStateEntryV1 {
  version: 1;
  title: string;
  items: Array<{ id: string; text: string; completed: boolean }>;
}

export interface TodoStateEntryV2 {
  version: 2;
  title: string;
  items: TodoItem[];
}
