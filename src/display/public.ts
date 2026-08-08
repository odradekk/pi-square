import type {
  AgentToolResult,
  ToolDefinition,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import type { DisplayRuntime } from "./runtime";
import { decorateToolDefinition, type DisplayToolRenderContext, type InternalToolDisplayAdapter } from "./tool-renderer";
import { safeHttpUrl } from "./sanitize";
import { DISPLAY_FAMILIES, type DisplayDescriptionV1, type DisplayFamily, type DisplayMetadataEntry, type DisplayProgressDescription, type DisplayRow } from "./types";

export const TOOL_DISPLAY_ADAPTER_VERSION = 1 as const;
export const TOOL_DISPLAY_ADAPTER_QUEUE_MAX = 128;
export const TOOL_DISPLAY_ADAPTER_FIELDS_MAX = 16;
export const TOOL_DISPLAY_ADAPTER_PATH_SEGMENTS_MAX = 8;
export const TOOL_DISPLAY_ADAPTER_PATH_SEGMENT_CHARS_MAX = 64;
export const TOOL_DISPLAY_ADAPTER_LABEL_CHARS_MAX = 32;
export const TOOL_DISPLAY_ADAPTER_TITLE_CHARS_MAX = 80;

const RUNTIME_SYMBOL = Symbol.for("@odradekk/pi-square.display.runtime.v1");
const QUEUE_SYMBOL = Symbol.for("@odradekk/pi-square.display.adapters.v1");
const FIELD_KINDS = ["text", "path", "url", "count", "command", "preview", "diff", "progress"] as const;
const FIELD_SOURCES = ["args", "details", "result"] as const;
const FIELD_PHASES = ["call", "result", "both"] as const;
const PATH_SEGMENT = /^(?:[A-Za-z_][A-Za-z0-9_:-]{0,63}|[0-9]{1,6})$/;

type AdapterKind = typeof FIELD_KINDS[number];
type AdapterSource = typeof FIELD_SOURCES[number];
type AdapterPhase = typeof FIELD_PHASES[number];

export interface ToolDisplayFieldV1 {
  readonly kind: AdapterKind;
  readonly source: AdapterSource;
  readonly path: readonly string[];
  readonly label?: string;
  readonly phase?: AdapterPhase;
}

export interface ToolDisplayAdapterV1 {
  readonly version: typeof TOOL_DISPLAY_ADAPTER_VERSION;
  readonly title: string;
  readonly family: DisplayFamily;
  readonly fields: readonly ToolDisplayFieldV1[];
}

interface RuntimeGlobal {
  readonly version: 1;
  readonly instanceId: string;
  readonly runtime: DisplayRuntime;
}

interface QueueEntry {
  readonly tool: ToolDefinition<any, any, any>;
  readonly adapter: ToolDisplayAdapterV1;
}

interface AdapterQueueV1 {
  readonly version: typeof TOOL_DISPLAY_ADAPTER_VERSION;
  readonly entries: QueueEntry[];
}

interface OwnershipRecord {
  readonly runtimeId: string;
  readonly tool: ToolDefinition<any, any, any>;
  readonly adapter: ToolDisplayAdapterV1;
  readonly original: ReadonlyMap<PropertyKey, PropertyDescriptor | undefined>;
  readonly installed: ReadonlyMap<PropertyKey, PropertyDescriptor>;
}

const ownership = new Map<ToolDefinition<any, any, any>, OwnershipRecord>();
const registrations = new Map<ToolDefinition<any, any, any>, ToolDisplayAdapterV1>();
const cleanupRuntimeIds = new Set<string>();
const RENDERER_KEYS = ["renderShell", "renderCall", "renderResult"] as const;

function dataObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be a plain object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${label} must be a plain object`);
  if (Object.getOwnPropertySymbols(value).length > 0) throw new TypeError(`${label} must not contain symbol properties`);
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!("value" in descriptor)) throw new TypeError(`${label}.${key} must be a data property`);
  }
  return value as Record<string, unknown>;
}

function dataArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new TypeError(`${label} must be an array`);
  if (Object.getOwnPropertySymbols(value).length > 0) throw new TypeError(`${label} must not contain symbol properties`);
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor)) throw new TypeError(`${label}[${index}] must be a data property`);
  }
  const extra = Object.keys(value).filter((key) => !/^(?:0|[1-9][0-9]*)$/.test(key));
  if (extra.length > 0) throw new TypeError(`${label} contains unknown properties: ${extra.join(", ")}`);
  return value;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new TypeError(`${label} contains unknown field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
}

function boundedString(value: unknown, maximum: number, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${label} must be a non-empty string`);
  if (Array.from(value).length > maximum) throw new TypeError(`${label} must be at most ${maximum} characters`);
  return value;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) throw new TypeError(`${label} must be one of: ${allowed.join(", ")}`);
  return value as T;
}

export function validateToolDisplayAdapterV1(value: unknown): ToolDisplayAdapterV1 {
  const adapter = dataObject(value, "adapter");
  exactKeys(adapter, ["version", "title", "family", "fields"], "adapter");
  if (adapter.version !== TOOL_DISPLAY_ADAPTER_VERSION) throw new TypeError("adapter.version must be 1");
  const title = boundedString(adapter.title, TOOL_DISPLAY_ADAPTER_TITLE_CHARS_MAX, "adapter.title");
  const family = enumValue(adapter.family, DISPLAY_FAMILIES, "adapter.family");
  const fieldValues = dataArray(adapter.fields, "adapter.fields");
  if (fieldValues.length > TOOL_DISPLAY_ADAPTER_FIELDS_MAX) {
    throw new TypeError(`adapter.fields must contain at most ${TOOL_DISPLAY_ADAPTER_FIELDS_MAX} entries`);
  }
  const fields = fieldValues.map((candidate, index): ToolDisplayFieldV1 => {
    const label = `adapter.fields[${index}]`;
    const field = dataObject(candidate, label);
    exactKeys(field, ["kind", "source", "path", "label", "phase"], label);
    const kind = enumValue(field.kind, FIELD_KINDS, `${label}.kind`);
    const source = enumValue(field.source, FIELD_SOURCES, `${label}.source`);
    const pathValues = dataArray(field.path, `${label}.path`);
    if (pathValues.length === 0 || pathValues.length > TOOL_DISPLAY_ADAPTER_PATH_SEGMENTS_MAX) {
      throw new TypeError(`${label}.path must contain 1-${TOOL_DISPLAY_ADAPTER_PATH_SEGMENTS_MAX} segments`);
    }
    const path = pathValues.map((segment, segmentIndex) => {
      const text = boundedString(segment, TOOL_DISPLAY_ADAPTER_PATH_SEGMENT_CHARS_MAX, `${label}.path[${segmentIndex}]`);
      if (!PATH_SEGMENT.test(text)) throw new TypeError(`${label}.path[${segmentIndex}] is invalid`);
      return text;
    });
    const staticLabel = field.label === undefined
      ? undefined
      : boundedString(field.label, TOOL_DISPLAY_ADAPTER_LABEL_CHARS_MAX, `${label}.label`);
    const phase = field.phase === undefined ? "both" : enumValue(field.phase, FIELD_PHASES, `${label}.phase`);
    return Object.freeze({ kind, source, path: Object.freeze(path), ...(staticLabel ? { label: staticLabel } : {}), phase });
  });
  return Object.freeze({ version: 1, title, family, fields: Object.freeze(fields) });
}

function queue(): AdapterQueueV1 {
  const root = globalThis as Record<PropertyKey, unknown>;
  const rootDescriptor = Object.getOwnPropertyDescriptor(root, QUEUE_SYMBOL);
  if (rootDescriptor && !("value" in rootDescriptor)) throw new Error("incompatible pi-square display adapter queue");
  const current = rootDescriptor && "value" in rootDescriptor ? rootDescriptor.value : undefined;
  if (current !== undefined) {
    const candidate = dataObject(current, "display adapter queue");
    exactKeys(candidate, ["version", "entries"], "display adapter queue");
    if (candidate.version !== 1) throw new Error("incompatible pi-square display adapter queue");
    const entries = dataArray(candidate.entries, "display adapter queue.entries");
    const length = Object.getOwnPropertyDescriptor(entries, "length");
    if (!length || !("value" in length) || length.writable !== true) {
      throw new Error("incompatible pi-square display adapter queue");
    }
    return { version: 1, entries: entries as QueueEntry[] };
  }
  const created: AdapterQueueV1 = { version: 1, entries: [] };
  root[QUEUE_SYMBOL] = created;
  return created;
}

function activeRuntime(): RuntimeGlobal | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, RUNTIME_SYMBOL);
  if (!descriptor || !("value" in descriptor)) return undefined;
  let candidate: Record<string, unknown>;
  try {
    candidate = dataObject(descriptor.value, "display runtime");
    exactKeys(candidate, ["version", "instanceId", "runtime"], "display runtime");
  } catch {
    return undefined;
  }
  const value = candidate as Partial<RuntimeGlobal>;
  return value?.version === 1
    && typeof value.instanceId === "string"
    && value.runtime?.instanceId === value.instanceId
    && !value.runtime.isDisposed
    ? value as RuntimeGlobal
    : undefined;
}

function ownDataValue(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const segment of path) {
    if ((typeof current !== "object" && typeof current !== "function") || current === null) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(current, segment);
    if (!descriptor || !("value" in descriptor)) return undefined;
    current = descriptor.value;
  }
  return current;
}

function resultText(result: AgentToolResult<unknown>): string {
  const content = ownDataValue(result, ["content"]);
  if (!Array.isArray(content)) return "";
  return content.flatMap((item) => {
    const type = ownDataValue(item, ["type"]);
    const text = ownDataValue(item, ["text"]);
    return type === "text" && typeof text === "string" ? [text] : [];
  }).join("\n");
}

function normalizedResult(result: AgentToolResult<unknown>): Record<string, unknown> {
  return { text: resultText(result) };
}

function mappedValue(
  field: ToolDisplayFieldV1,
  args: unknown,
  result: AgentToolResult<unknown> | undefined,
): unknown {
  const root = field.source === "args"
    ? args
    : field.source === "details"
      ? result ? ownDataValue(result, ["details"]) : undefined
      : result
        ? normalizedResult(result)
        : undefined;
  return ownDataValue(root, field.path);
}

function scalar(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") return String(value);
  return undefined;
}

function objectData(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && "value" in descriptor) output[key] = descriptor.value;
  }
  return output;
}

function descriptionFromMappings(
  toolName: string,
  adapter: ToolDisplayAdapterV1,
  phase: "call" | "result",
  args: unknown,
  result: AgentToolResult<unknown> | undefined,
  context: DisplayToolRenderContext<unknown, unknown>,
  options?: ToolRenderResultOptions,
): DisplayDescriptionV1 {
  let target: string | undefined;
  let preview: DisplayDescriptionV1["preview"];
  let diff: DisplayDescriptionV1["diff"];
  let progress: DisplayProgressDescription | undefined;
  const rows: DisplayRow[] = [];
  const metadata: DisplayMetadataEntry[] = [];
  for (const field of adapter.fields) {
    if (field.phase !== "both" && field.phase !== phase) continue;
    const value = mappedValue(field, args, result);
    if (value === undefined || value === null) continue;
    const label = field.label ?? field.path.at(-1) ?? field.kind;
    if (field.kind === "text") {
      const text = scalar(value);
      if (text !== undefined) rows.push({ text: field.label ? `${field.label} ${text}` : text });
    } else if (field.kind === "path" || field.kind === "url" || field.kind === "command") {
      const text = field.kind === "url" ? safeHttpUrl(value) : scalar(value);
      if (text !== undefined) {
        if (target === undefined) target = text;
        else rows.push({ text: `${label} ${text}` });
      }
    } else if (field.kind === "count") {
      const text = scalar(value);
      if (text !== undefined) metadata.push({ label, value: text });
    } else if (field.kind === "preview") {
      const text = scalar(value);
      if (text !== undefined && preview === undefined) preview = { text };
    } else if (field.kind === "diff") {
      const data = objectData(value);
      if (data && typeof data.before === "string" && typeof data.after === "string" && diff === undefined) {
        diff = {
          before: data.before,
          after: data.after,
          ...(typeof data.path === "string" ? { path: data.path } : {}),
          ...(data.projected === true ? { projected: true } : {}),
        };
      }
    } else if (field.kind === "progress") {
      const data = objectData(value);
      if (data && progress === undefined) {
        progress = {
          ...(typeof data.current === "number" && Number.isFinite(data.current) ? { current: data.current } : {}),
          ...(typeof data.total === "number" && Number.isFinite(data.total) ? { total: data.total } : {}),
          ...(typeof data.label === "string" ? { label: data.label } : {}),
        };
      }
    }
  }
  const isError = context.isError;
  const text = result ? resultText(result) : "";
  return {
    version: 1,
    tool: toolName,
    family: adapter.family,
    lifecycle: isError
      ? "failed"
      : phase === "call"
        ? (context.executionStarted ? "running" : context.argsComplete ? "pending" : "queued")
        : options?.isPartial
          ? "running"
          : "completed",
    ...(phase !== "call" && options?.isPartial ? { qualifiers: ["partial"] } : {}),
    title: adapter.title,
    target,
    metadata,
    rows,
    preview,
    diff,
    progress,
    ...(isError && text ? { error: text } : {}),
  };
}

function internalAdapter(toolName: string, adapter: ToolDisplayAdapterV1): InternalToolDisplayAdapter<TSchema, unknown, unknown> {
  return {
    describeCall(args, context) {
      return descriptionFromMappings(toolName, adapter, "call", args, undefined, context);
    },
    describeResult(result, options, context) {
      return descriptionFromMappings(toolName, adapter, "result", context.args, result, context, options);
    },
  };
}

function descriptorsEqual(left: PropertyDescriptor | undefined, right: PropertyDescriptor | undefined): boolean {
  if (!left || !right) return left === right;
  return left.configurable === right.configurable
    && left.enumerable === right.enumerable
    && ("value" in left) === ("value" in right)
    && (!("value" in left) || (
      left.value === right.value
      && left.writable === right.writable
    ))
    && (!("get" in left) || (left.get === right.get && left.set === right.set));
}

function restoreRecord(record: OwnershipRecord): void {
  for (const key of RENDERER_KEYS) {
    if (!descriptorsEqual(Object.getOwnPropertyDescriptor(record.tool, key), record.installed.get(key))) continue;
    const original = record.original.get(key);
    if (original) Object.defineProperty(record.tool, key, original);
    else delete (record.tool as unknown as Record<PropertyKey, unknown>)[key];
  }
  if (ownership.get(record.tool) === record) ownership.delete(record.tool);
}

function activate(
  tool: ToolDefinition<any, any, any>,
  adapter: ToolDisplayAdapterV1,
  runtime: DisplayRuntime,
): void {
  const current = ownership.get(tool);
  if (current) restoreRecord(current);
  const decorated = decorateToolDefinition(tool, runtime, internalAdapter(tool.name, adapter));
  const original = new Map<PropertyKey, PropertyDescriptor | undefined>();
  const installed = new Map<PropertyKey, PropertyDescriptor>();
  for (const key of RENDERER_KEYS) {
    original.set(key, Object.getOwnPropertyDescriptor(tool, key));
    const descriptor = Object.getOwnPropertyDescriptor(decorated, key);
    if (!descriptor) throw new Error(`display renderer ${key} was not created`);
    installed.set(key, descriptor);
  }
  const applied: PropertyKey[] = [];
  try {
    for (const key of RENDERER_KEYS) {
      Object.defineProperty(tool, key, installed.get(key)!);
      applied.push(key);
    }
  } catch (error) {
    for (const key of applied.reverse()) {
      const descriptor = original.get(key);
      if (descriptor) Object.defineProperty(tool, key, descriptor);
      else delete (tool as unknown as Record<PropertyKey, unknown>)[key];
    }
    throw error;
  }
  ownership.set(tool, { runtimeId: runtime.instanceId, tool, adapter, original, installed });
  if (!cleanupRuntimeIds.has(runtime.instanceId)) {
    cleanupRuntimeIds.add(runtime.instanceId);
    runtime.registerCleanup(() => {
      cleanupRuntimeIds.delete(runtime.instanceId);
      restoreDisplayAdapters(runtime.instanceId);
    });
  }
}

function assertTool(value: unknown): ToolDefinition<any, any, any> {
  if (!value || typeof value !== "object") throw new TypeError("tool must be a ToolDefinition object");
  const descriptor = Object.getOwnPropertyDescriptor(value, "name");
  if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "string" || descriptor.value.length === 0) {
    throw new TypeError("tool.name must be an own non-empty string data property");
  }
  return value as ToolDefinition<any, any, any>;
}

export function decorateToolForDisplay<T extends ToolDefinition<any, any, any>>(
  toolValue: T,
  adapterValue: ToolDisplayAdapterV1,
): T {
  const tool = assertTool(toolValue) as T;
  const adapter = validateToolDisplayAdapterV1(adapterValue);
  const previous = registrations.get(tool);
  if (previous === undefined && registrations.size >= TOOL_DISPLAY_ADAPTER_QUEUE_MAX) {
    throw new Error(`pi-square display adapter registry is full (${TOOL_DISPLAY_ADAPTER_QUEUE_MAX})`);
  }
  const active = activeRuntime();
  registrations.set(tool, adapter);
  try {
    if (active) {
      activate(tool, adapter, active.runtime);
      return tool;
    }
    const pending = queue();
    const existing = pending.entries.findIndex((entry) => ownDataValue(entry, ["tool"]) === tool);
    if (existing >= 0) pending.entries[existing] = { tool, adapter };
    else {
      if (pending.entries.length >= TOOL_DISPLAY_ADAPTER_QUEUE_MAX) {
        throw new Error(`pi-square display adapter queue is full (${TOOL_DISPLAY_ADAPTER_QUEUE_MAX})`);
      }
      pending.entries.push({ tool, adapter });
    }
    return tool;
  } catch (error) {
    if (previous === undefined) registrations.delete(tool);
    else {
      registrations.set(tool, previous);
      if (active) {
        try {
          activate(tool, previous, active.runtime);
        } catch {
          // Preserve the original activation error; failed recovery remains descriptor-safe.
        }
      }
    }
    throw error;
  }
}

export function activateQueuedDisplayAdapters(runtime: DisplayRuntime): void {
  let entries: QueueEntry[] = [];
  try {
    const pending = queue();
    entries = (Array.prototype.splice.call(pending.entries, 0, pending.entries.length) as QueueEntry[])
      .slice(0, TOOL_DISPLAY_ADAPTER_QUEUE_MAX);
  } catch {
    // A damaged global queue cannot block already validated in-module registrations.
  }
  for (const candidate of entries) {
    try {
      const entry = dataObject(candidate, "queued adapter");
      exactKeys(entry, ["tool", "adapter"], "queued adapter");
      const tool = assertTool(entry.tool);
      const adapter = validateToolDisplayAdapterV1(entry.adapter);
      if (registrations.has(tool) || registrations.size < TOOL_DISPLAY_ADAPTER_QUEUE_MAX) registrations.set(tool, adapter);
    } catch {
      // A damaged global queue entry is isolated; valid declarations still activate.
    }
  }
  for (const [tool, adapter] of registrations) {
    try {
      activate(tool, adapter, runtime);
    } catch {
      // One non-configurable or otherwise damaged third-party definition must not block runtime installation.
    }
  }
}

export function restoreDisplayAdapters(runtimeId: string): void {
  let pending: AdapterQueueV1 | undefined;
  try {
    pending = queue();
  } catch {
    // Descriptor restoration remains mandatory even if the global queue was damaged.
  }
  for (const record of [...ownership.values()]) {
    if (record.runtimeId !== runtimeId) continue;
    if (pending) {
      const existing = pending.entries.findIndex((entry) => ownDataValue(entry, ["tool"]) === record.tool);
      if (existing >= 0) pending.entries[existing] = { tool: record.tool, adapter: record.adapter };
      else if (pending.entries.length < TOOL_DISPLAY_ADAPTER_QUEUE_MAX) {
        pending.entries.push({ tool: record.tool, adapter: record.adapter });
      }
    }
    restoreRecord(record);
  }
}

export const __testables = {
  QUEUE_SYMBOL,
  RUNTIME_SYMBOL,
  ownership,
  registrations,
  cleanupRuntimeIds,
};
