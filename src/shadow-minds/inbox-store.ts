/**
 * Persistent Shadow result inbox partition (odradekk/pi-square#157).
 *
 * Owns the authoritative result storage beneath the parent session
 * directory: one hidden partition per parent session ID holding one
 * versioned atomic JSON entity per result, a bounded index of ordering and
 * summary metadata only, quarantine for corrupt files, index rebuild from a
 * bounded validated scan, count- and byte-bounded retention that evicts
 * resolved entries before unread notified ones with visible eviction
 * events, and orphan-partition reconciliation. Every entity read from disk
 * is strictly validated before it can surface, so unvalidated disk content
 * never reaches the parent model. Non-persisted sessions keep the in-memory
 * inbox; this store implements the same `ShadowInbox` surface plus the
 * atomic `send` delivery transition the confirmed-delivery slice drives.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { canonicalSchemaJson } from "./prompt";
import {
  SHADOW_INBOX_DEFAULT_MAX_RESULTS,
  evictionCandidate,
  summarizeShadowResult,
  type ShadowInbox,
  type ShadowInboxAddInput,
  type ShadowResultAttention,
  type ShadowResultDelivery,
  type ShadowResultEntity,
} from "./result";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { sanitizeDisplayText } from "../display/sanitize";
import {
  SHADOW_DELIVERIES,
  SHADOW_PAYLOAD_MAX_CHARS,
  SHADOW_TRIGGERS,
  validateOutputSchema,
  validateShadowPayload,
  type ShadowOutputSchema,
} from "./parser";

/** Hidden partition directory beneath the parent session directory. */
export const SHADOW_PARTITION_DIR = ".pi-square-shadow";

/** Package hard caps for inbox retention. */
export const SHADOW_INBOX_MAX_RESULTS_HARD = 100;
export const SHADOW_INBOX_MAX_BYTES_HARD = 16 * 1024 * 1024;

const INDEX_SUMMARY_MAX_CHARS = 160;
const INDEX_EVENTS_MAX = 32;
const INDEX_SCAN_MAX_FILES = 512;
const RESULT_ENTITY_MAX_BYTES = 256 * 1024;
const RESULT_INDEX_MAX_BYTES = 256 * 1024;
const DEBUG_INDEX_MAX_BYTES = 256 * 1024;
const ID_MAX_CHARS = 128;
const RECONCILE_MAX_PARTITIONS = 1_000;

export interface ShadowInboxEvictionEvent {
  kind: "evicted";
  id: string;
  at: number;
  reason: "count" | "bytes";
}

interface StoredIndexEntry {
  id: string;
  createdAt: number;
  delivery: ShadowResultDelivery;
  attention: ShadowResultAttention;
  bytes: number;
  summary: string;
  referenced?: boolean;
}

interface StoredIndex {
  version: 1;
  sessionId: string;
  maxResults: number;
  maxBytes: number;
  updatedAt: number;
  results: StoredIndexEntry[];
  events: ShadowInboxEvictionEvent[];
}

const SAFE_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function requireSafePathSegment(value: string, label: string): string {
  if (!SAFE_PATH_SEGMENT.test(value)) throw new Error(`Shadow ${label} must be one safe path segment.`);
  return value;
}

/** Resolves one session's Shadow partition path. */
export function shadowPartitionPath(sessionDir: string, sessionId: string): string {
  return join(resolve(sessionDir), SHADOW_PARTITION_DIR, requireSafePathSegment(sessionId, "session id"));
}

function atomicWriteText(path: string, content: string): void {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(tmp, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  try {
    writeFileSync(fd, content, "utf8");
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    rmSync(tmp, { force: true });
    throw error;
  }
  closeSync(fd);
  try {
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

function atomicWriteJson(path: string, value: unknown): void {
  atomicWriteText(path, JSON.stringify(value, null, 2));
}
function requireRegularFile(path: string): boolean {
  try {
    const stats = lstatSync(path);
    return stats.isFile() && !stats.isSymbolicLink();
  } catch {
    return false;
  }
}

function requireSafeDirectory(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    return;
  }
  const stats = lstatSync(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`Shadow storage path '${path}' must be a real directory.`);
  }
}

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}
function schemaHashOf(schema: ShadowOutputSchema): string {
  return createHash("sha256").update(canonicalSchemaJson(schema)).digest("hex").slice(0, 16);
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isUsage(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return ["input", "output", "cacheRead", "cacheWrite", "cost", "turns"].every(
    (key) => typeof record[key] === "number" && Number.isFinite(record[key]),
  );
}

/**
 * Strictly validates one persisted entity. Known fields must be present and
 * bounded; a value that fails any check marks the file corrupt. Returns the
 * typed entity or undefined.
 */
function validatePersistedEntity(value: unknown): LoadedEntity["entity"] & { validationSchema: ShadowOutputSchema } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.version !== 1) return undefined;
  if (!isBoundedString(record.id, ID_MAX_CHARS) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(record.id)) return undefined;
  if (!isBoundedString(record.shadowId, 64)) return undefined;
  if (!isBoundedString(record.shadowName, 120)) return undefined;
  if (record.trigger !== "manual") return undefined;
  if (record.note !== undefined && !isBoundedString(record.note, 8_000)) return undefined;
  if (record.payload === null || typeof record.payload !== "object" || Array.isArray(record.payload)) return undefined;
  const validationSchema = record.validationSchema;
  if (validateOutputSchema(validationSchema).length > 0) return undefined;
  if (!isBoundedString(record.schemaHash, 128) || record.schemaHash !== schemaHashOf(validationSchema as ShadowOutputSchema)) return undefined;
  if (validateShadowPayload(validationSchema as ShadowOutputSchema, record.payload).length > 0) return undefined;
  // Keep the encoded hard bound as defense in depth even though payload
  // validation applies it too.
  if (JSON.stringify(record.payload).length > SHADOW_PAYLOAD_MAX_CHARS) return undefined;
  if (!isBoundedString(record.summary, 300) || record.summary !== summarizeShadowResult(record.payload)) return undefined;
  if (record.delivery !== "notified" && record.delivery !== "pending" && record.delivery !== "delivered") return undefined;
  if (record.attention !== "unread" && record.attention !== "read" && record.attention !== "dismissed") return undefined;
  if (!isFiniteNonNegative(record.createdAt)) return undefined;
  if (record.model !== undefined && !isBoundedString(record.model, 120)) return undefined;
  if (record.usage !== undefined && !isUsage(record.usage)) return undefined;
  if (record.definitionHash !== undefined && !isBoundedString(record.definitionHash, 128)) return undefined;
  if (record.schemaHash !== undefined && !isBoundedString(record.schemaHash, 128)) return undefined;
  if (record.lifecycle !== undefined && record.lifecycle !== "submitted") return undefined;
  if (record.toolCalls !== undefined && (!Number.isInteger(record.toolCalls) || (record.toolCalls as number) < 0 || (record.toolCalls as number) > 128)) return undefined;
  if (record.trajectoryTruncated !== undefined && typeof record.trajectoryTruncated !== "boolean") return undefined;
  if (record.requests !== undefined) {
    if (!Array.isArray(record.requests) || record.requests.length > 64) return undefined;
    for (const metric of record.requests) {
      if (!metric || typeof metric !== "object" || Array.isArray(metric)) return undefined;
      const item = metric as Record<string, unknown>;
      if (!["input", "output", "cacheRead", "cacheWrite", "cost"].every((key) => isFiniteNonNegative(item[key]))) return undefined;
      if (item.ttftMs !== undefined && !isFiniteNonNegative(item.ttftMs)) return undefined;
    }
  }
  if (record.configuredDelivery !== undefined && !SHADOW_DELIVERIES.includes(record.configuredDelivery as never)) return undefined;
  if (record.triggers !== undefined) {
    if (!Array.isArray(record.triggers) || record.triggers.length > 4) return undefined;
    if (!record.triggers.every((trigger) => SHADOW_TRIGGERS.includes(trigger as never))) return undefined;
  }
  if (record.referenced !== undefined && typeof record.referenced !== "boolean") return undefined;
  if (record.taskIdentity !== undefined) {
    const identity = record.taskIdentity as Record<string, unknown>;
    if (!identity || typeof identity !== "object" || !Number.isInteger(identity.epoch) || (identity.epoch as number) < 0) return undefined;
    if (identity.parentEntryId !== undefined && !isBoundedString(identity.parentEntryId, 64)) return undefined;
  }
  return {
    validationSchema: structuredClone(validationSchema) as ShadowOutputSchema,
    id: record.id,
    shadowId: record.shadowId,
    shadowName: record.shadowName,
    trigger: "manual",
    ...(typeof record.note === "string" ? { note: record.note } : {}),
    payload: structuredClone(record.payload),
    summary: record.summary as string,
    delivery: record.delivery as ShadowResultDelivery,
    attention: record.attention as ShadowResultAttention,
    createdAt: record.createdAt as number,
    ...(typeof record.model === "string" ? { model: record.model } : {}),
    ...(record.usage !== undefined ? { usage: structuredClone(record.usage) as ShadowResultEntity["usage"] } : {}),
    ...(typeof record.definitionHash === "string" ? { definitionHash: record.definitionHash } : {}),
    ...(typeof record.schemaHash === "string" ? { schemaHash: record.schemaHash } : {}),
    ...(record.lifecycle === "submitted" ? { lifecycle: "submitted" as const } : {}),
    ...(typeof record.toolCalls === "number" ? { toolCalls: record.toolCalls } : {}),
    ...(typeof record.trajectoryTruncated === "boolean" ? { trajectoryTruncated: record.trajectoryTruncated } : {}),
    ...(Array.isArray(record.requests) ? { requests: structuredClone(record.requests) as NonNullable<ShadowResultEntity["requests"]> } : {}),
    ...(typeof record.configuredDelivery === "string"
      ? { configuredDelivery: record.configuredDelivery as ShadowResultEntity["configuredDelivery"] }
      : {}),
    ...(Array.isArray(record.triggers) ? { triggers: [...record.triggers] as ShadowResultEntity["triggers"] } : {}),
    ...(record.taskIdentity !== undefined
      ? { taskIdentity: structuredClone(record.taskIdentity) as ShadowResultEntity["taskIdentity"] }
      : {}),
    ...(record.referenced === true ? { referenced: true } : {}),
  };
}

function validatePersistedIndex(value: unknown): StoredIndex | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || !isBoundedString(record.sessionId, 128)) return undefined;
  if (!Number.isInteger(record.maxResults) || (record.maxResults as number) < 1) return undefined;
  if (!Number.isInteger(record.maxBytes) || (record.maxBytes as number) < 1) return undefined;
  if (!Array.isArray(record.results) || !Array.isArray(record.events)) return undefined;
  const results: StoredIndexEntry[] = [];
  for (const entry of record.results.slice(0, SHADOW_INBOX_MAX_RESULTS_HARD)) {
    if (!entry || typeof entry !== "object") return undefined;
    const item = entry as Record<string, unknown>;
    if (!isBoundedString(item.id, ID_MAX_CHARS)) return undefined;
    if (!isFiniteNonNegative(item.createdAt)) return undefined;
    if (item.delivery !== "notified" && item.delivery !== "pending" && item.delivery !== "delivered") return undefined;
    if (item.attention !== "unread" && item.attention !== "read" && item.attention !== "dismissed") return undefined;
    if (!Number.isInteger(item.bytes) || (item.bytes as number) < 0) return undefined;
    if (!isBoundedString(item.summary, INDEX_SUMMARY_MAX_CHARS)) return undefined;
    if (item.referenced !== undefined && typeof item.referenced !== "boolean") return undefined;
    results.push({
      id: item.id,
      createdAt: item.createdAt as number,
      delivery: item.delivery as ShadowResultDelivery,
      attention: item.attention as ShadowResultAttention,
      bytes: item.bytes as number,
      summary: item.summary as string,
      ...(item.referenced === true ? { referenced: true } : {}),
    });
  }
  const events: ShadowInboxEvictionEvent[] = [];
  for (const event of record.events.slice(0, INDEX_EVENTS_MAX)) {
    if (!event || typeof event !== "object") return undefined;
    const item = event as Record<string, unknown>;
    if (item.kind !== "evicted" || !isBoundedString(item.id, ID_MAX_CHARS)) return undefined;
    if (!isFiniteNonNegative(item.at)) return undefined;
    if (item.reason !== "count" && item.reason !== "bytes") return undefined;
    events.push({ kind: "evicted", id: item.id, at: item.at, reason: item.reason });
  }
  return {
    version: 1,
    sessionId: record.sessionId,
    maxResults: Math.min(record.maxResults as number, SHADOW_INBOX_MAX_RESULTS_HARD),
    maxBytes: Math.min(record.maxBytes as number, SHADOW_INBOX_MAX_BYTES_HARD),
    updatedAt: isFiniteNonNegative(record.updatedAt) ? record.updatedAt : 0,
    results,
    events,
  };
}

interface LoadedEntity {
  entity: ShadowResultEntity;
  validationSchema: ShadowOutputSchema;
  bytes: number;
}

export interface PersistentShadowInbox extends ShadowInbox {
  /** Recorded eviction and load events, oldest first. */
  events(): ShadowInboxEvictionEvent[];
  /** Bounded diagnostics from the last load (quarantine, rebuild). */
  diagnostics(): string[];
}

export interface PersistentShadowInboxOptions {
  sessionDir: string;
  sessionId: string;
  maxResults?: number;
  maxBytes?: number;
  makeId?: () => string;
  now?: () => number;
}

/**
 * Opens the persistent result inbox for one parent session partition. The
 * partition is created on demand; entities and the index are validated on
 * load, corrupt files are quarantined, a corrupt index is rebuilt from a
 * bounded scan, and retention is re-applied before any entity surfaces.
 */
export function createPersistentShadowInbox(options: PersistentShadowInboxOptions): PersistentShadowInbox {
  const partition = shadowPartitionPath(options.sessionDir, options.sessionId);
  const partitionRoot = join(resolve(options.sessionDir), SHADOW_PARTITION_DIR);
  const resultsDir = join(partition, "results");
  const quarantineDir = join(partition, "quarantine");
  const indexPath = join(partition, "index.json");
  const now = options.now ?? (() => Date.now());
  const makeId = options.makeId ?? (() => `shr-${randomUUID()}`);
  const maxResults = Math.min(
    SHADOW_INBOX_MAX_RESULTS_HARD,
    Math.max(1, Math.trunc(options.maxResults ?? SHADOW_INBOX_DEFAULT_MAX_RESULTS)),
  );
  const maxBytes = Math.min(
    SHADOW_INBOX_MAX_BYTES_HARD,
    Math.max(1, Math.trunc(options.maxBytes ?? SHADOW_INBOX_MAX_BYTES_HARD)),
  );

  const diagnostics: string[] = [];
  const events: ShadowInboxEvictionEvent[] = [];
  const loaded = new Map<string, LoadedEntity>();

  const clone = <T>(value: T): T => structuredClone(value);

  const entityPath = (id: string): string => join(resultsDir, `${requireSafePathSegment(id, "result id")}.json`);

  const quarantine = (id: string, path: string, cause: string): void => {
    try {
      requireSafeDirectory(quarantineDir);
      renameSync(path, join(quarantineDir, `${id}-${now().toString(36)}.json`));
      diagnostics.push(`Result ${id} was quarantined (${cause}).`);
    } catch {
      // A file that cannot be moved is removed; it can never surface.
      try {
        rmSync(path, { force: true });
      } catch {
        // Unreadable paths never load; nothing more to do.
      }
      diagnostics.push(`Result ${id} was unreadable and removed (${cause}).`);
    }
  };

  const loadEntityFile = (id: string): LoadedEntity | undefined => {
    if (!SAFE_PATH_SEGMENT.test(id)) return undefined;
    const path = entityPath(id);
    if (!requireRegularFile(path)) {
      if (existsSync(path)) quarantine(id, path, "not a regular file");
      return undefined;
    }
    let raw: string;
    try {
      if (lstatSync(path).size > RESULT_ENTITY_MAX_BYTES) {
        quarantine(id, path, "file exceeds the entity byte bound");
        return undefined;
      }
      raw = readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      quarantine(id, path, "invalid JSON");
      return undefined;
    }
    const validated = validatePersistedEntity(parsed);
    if (!validated) {
      quarantine(id, path, "shape or schema validation failed");
      return undefined;
    }
    const { validationSchema, ...entity } = validated;
    if (entity.id !== id) {
      quarantine(id, path, "file name and entity id differ");
      return undefined;
    }
    let bytes = 0;
    try {
      bytes = statSync(path).size;
    } catch {
      bytes = raw.length;
    }
    return { entity, validationSchema, bytes };
  };

  const writeEntity = (entry: LoadedEntity): void => {
    mkdirSync(resultsDir, { recursive: true });
    atomicWriteJson(entityPath(entry.entity.id), {
      version: 1,
      ...entry.entity,
      validationSchema: entry.validationSchema,
    });
    entry.bytes = statSync(entityPath(entry.entity.id)).size;
  };

  const writeIndex = (): boolean => {
    const ordered = [...loaded.values()].sort((a, b) => b.entity.createdAt - a.entity.createdAt);
    const index: StoredIndex = {
      version: 1,
      sessionId: options.sessionId,
      maxResults,
      maxBytes,
      updatedAt: now(),
      results: ordered.map((entry) => ({
        id: entry.entity.id,
        createdAt: entry.entity.createdAt,
        delivery: entry.entity.delivery,
        attention: entry.entity.attention,
        bytes: entry.bytes,
        summary: entry.entity.summary.slice(0, INDEX_SUMMARY_MAX_CHARS),
        ...(entry.entity.referenced ? { referenced: true } : {}),
      })),
      events: events.slice(-INDEX_EVENTS_MAX),
    };
    try {
      atomicWriteJson(indexPath, index);
      return true;
    } catch (error) {
      diagnostics.push(`The inbox index could not be updated (${error instanceof Error ? error.message : String(error)}); it will rebuild from validated entities.`);
      return false;
    }
  };

  const removeEntity = (id: string, reason: "count" | "bytes"): boolean => {
    const entry = loaded.get(id);
    if (!entry) return false;
    try {
      rmSync(entityPath(id));
    } catch {
      diagnostics.push(`Result ${id} could not be evicted (${reason}); retention will retry.`);
      return false;
    }
    loaded.delete(id);
    events.push({ kind: "evicted", id, at: now(), reason });
    if (events.length > INDEX_EVENTS_MAX * 2) events.splice(0, events.length - INDEX_EVENTS_MAX);
    diagnostics.push(`Result ${id} was evicted (${reason}).`);
    return true;
  };

  const enforceRetention = (): void => {
    while (loaded.size > maxResults) {
      const candidate = pickEviction();
      if (!candidate) break;
      if (!removeEntity(candidate, "count")) break;
    }
    let totalBytes = 0;
    for (const entry of loaded.values()) totalBytes += entry.bytes;
    while (totalBytes > maxBytes && loaded.size > 1) {
      const candidate = pickEviction();
      if (!candidate) break;
      const entry = loaded.get(candidate)!;
      if (!removeEntity(candidate, "bytes")) break;
      totalBytes -= entry.bytes;
    }
  };

  const pickEviction = (): string | undefined => {
    const candidate = evictionCandidate([...loaded.values()].map((entry) => entry.entity));
    return candidate?.id;
  };

  // ── Load ──
  requireSafeDirectory(partitionRoot);
  requireSafeDirectory(partition);
  requireSafeDirectory(resultsDir);
  let indexValid = false;
  if (existsSync(indexPath) && requireRegularFile(indexPath) && lstatSync(indexPath).size <= RESULT_INDEX_MAX_BYTES) {
    try {
      const parsed = validatePersistedIndex(JSON.parse(readFileSync(indexPath, "utf8")));
      if (parsed && parsed.sessionId === options.sessionId) {
        indexValid = true;
        events.push(...parsed.events.slice(-INDEX_EVENTS_MAX));
        for (const entry of parsed.results) {
          const loadedEntity = loadEntityFile(entry.id);
          if (!loadedEntity) continue;
          loaded.set(loadedEntity.entity.id, loadedEntity);
        }
      }
    } catch {
      indexValid = false;
    }
  }
  // Always reconcile the valid index with a bounded validated directory scan.
  // This recovers an authoritative entity written just before a process crash
  // prevented the subsequent index update. A corrupt/missing index is diagnosed
  // as a rebuild; a valid index remains the source of persisted events/reference
  // hints while unindexed valid entities are adopted.
  if (!indexValid) {
    diagnostics.push("The inbox index was missing or corrupt and was rebuilt from a validated scan.");
  }
  let names: string[] = [];
  try {
    names = readdirSync(resultsDir).filter((name) => name.endsWith(".json")).sort();
  } catch {
    names = [];
  }
  for (const name of names.slice(0, INDEX_SCAN_MAX_FILES)) {
    const id = name.slice(0, -".json".length);
    if (loaded.has(id)) continue;
    const loadedEntity = loadEntityFile(id);
    if (loadedEntity) loaded.set(loadedEntity.entity.id, loadedEntity);
  }
  enforceRetention();
  writeIndex();

  return {
    persistent: true,
    add(input: ShadowInboxAddInput): ShadowResultEntity {
      const validationSchema = input.validationSchema;
      if (validateOutputSchema(validationSchema).length > 0 || validateShadowPayload(validationSchema as ShadowOutputSchema, input.payload).length > 0) {
        throw new Error("Shadow result payload or validation schema is invalid.");
      }
      const expectedSchemaHash = schemaHashOf(validationSchema as ShadowOutputSchema);
      if (input.schemaHash !== undefined && input.schemaHash !== expectedSchemaHash) {
        throw new Error("Shadow result schema hash does not match its validation schema.");
      }
      const entity: ShadowResultEntity = {
        id: makeId(),
        shadowId: input.shadowId,
        shadowName: input.shadowName,
        trigger: "manual",
        ...(input.note?.trim() ? { note: input.note.trim() } : {}),
        payload: clone(input.payload),
        summary: summarizeShadowResult(input.payload),
        delivery: "notified",
        attention: "unread",
        createdAt: input.createdAt,
        ...(input.model ? { model: input.model } : {}),
        ...(input.usage ? { usage: clone(input.usage) } : {}),
        ...(input.definitionHash ? { definitionHash: input.definitionHash } : {}),
        schemaHash: expectedSchemaHash,
        ...(input.lifecycle ? { lifecycle: input.lifecycle } : {}),
        ...(input.toolCalls !== undefined ? { toolCalls: input.toolCalls } : {}),
        ...(input.trajectoryTruncated !== undefined ? { trajectoryTruncated: input.trajectoryTruncated } : {}),
        ...(input.requests ? { requests: clone(input.requests) } : {}),
        ...(input.configuredDelivery ? { configuredDelivery: input.configuredDelivery } : {}),
        ...(input.triggers ? { triggers: [...input.triggers] } : {}),
        ...(input.taskIdentity ? { taskIdentity: clone(input.taskIdentity) } : {}),
      };
      const loadedEntry: LoadedEntity = {
        entity,
        validationSchema: structuredClone(validationSchema) as ShadowOutputSchema,
        bytes: 0,
      };
      writeEntity(loadedEntry);
      loaded.set(entity.id, loadedEntry);
      enforceRetention();
      writeIndex();
      return clone(entity);
    },
    list(): ShadowResultEntity[] {
      return [...loaded.values()]
        .sort((a, b) => b.entity.createdAt - a.entity.createdAt)
        .map((entry) => clone(entry.entity));
    },
    send(id: string): boolean {
      const entry = loaded.get(id);
      if (!entry || entry.entity.delivery !== "notified") return false;
      const next = clone(entry);
      next.entity.delivery = "pending";
      writeEntity(next);
      loaded.set(id, next);
      writeIndex();
      return true;
    },
    markRead(id: string): boolean {
      const entry = loaded.get(id);
      if (!entry) return false;
      const next = clone(entry);
      next.entity.attention = "read";
      writeEntity(next);
      loaded.set(id, next);
      writeIndex();
      return true;
    },
    dismiss(id: string): boolean {
      const entry = loaded.get(id);
      if (!entry) return false;
      const next = clone(entry);
      next.entity.attention = "dismissed";
      writeEntity(next);
      loaded.set(id, next);
      writeIndex();
      return true;
    },
    delete(id: string): boolean {
      if (!loaded.has(id)) return false;
      try {
        rmSync(entityPath(id));
      } catch {
        return false;
      }
      loaded.delete(id);
      writeIndex();
      return true;
    },
    markReferenced(id: string): boolean {
      const entry = loaded.get(id);
      if (!entry || entry.entity.referenced) return false;
      const next = clone(entry);
      next.entity.referenced = true;
      writeEntity(next);
      loaded.set(id, next);
      writeIndex();
      return true;
    },
    clear(): void {
      // The partition is the authoritative record and deliberately survives
      // session-scoped resets; per-session clearing removes nothing.
    },
    events(): ShadowInboxEvictionEvent[] {
      return events.slice(-INDEX_EVENTS_MAX);
    },
    diagnostics(): string[] {
      return [...diagnostics];
    },
  };
}


// ── Debug histories ─────────────────────────────────────────────────

/** Debug retention: at most this many native logs per Shadow. */
export const SHADOW_DEBUG_MAX_LOGS_PER_SHADOW = 20;
/** Debug retention: total debug bytes across the partition. */
export const SHADOW_DEBUG_MAX_TOTAL_BYTES = 128 * 1024 * 1024;

const DEBUG_INDEX_MAX_RUNS = 200;
const DEBUG_SANITIZE_MAX_BYTES = 8 * 1024 * 1024;

interface DebugIndexRun {
  runId: string;
  shadowId: string;
  startedAt: number;
  endedAt: number;
  phase: string;
  bytes: number;
}

interface DebugIndex {
  version: 1;
  runs: DebugIndexRun[];
}

/** Resolves one debug run's directory inside the partition. */
export function shadowDebugRunDir(sessionDir: string, sessionId: string, runId: string): string {
  return join(
    shadowPartitionPath(sessionDir, sessionId),
    "debug",
    requireSafePathSegment(runId, "run id"),
  );
}

/**
 * Opens the native persisted child SessionManager for one debug run. The
 * child session JSONL lands inside the run directory and is sanitized,
 * indexed, and retention-swept by `finalizeShadowDebugRun` after the run.
 */
export function openShadowDebugSessionManager(debugDir: string, cwd: string): SessionManager {
  mkdirSync(debugDir, { recursive: true });
  return SessionManager.open(join(debugDir, "session.jsonl"), debugDir, cwd);
}

function debugIndexPath(partition: string): string {
  return join(partition, "debug", "index.json");
}

function readDebugIndex(partition: string): DebugIndex {
  try {
    const path = debugIndexPath(partition);
    if (!requireRegularFile(path) || lstatSync(path).size > DEBUG_INDEX_MAX_BYTES) return { version: 1, runs: [] };
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.runs)) {
      const runs = parsed.runs.filter((run: unknown) =>
        run && typeof run === "object"
        && typeof (run as DebugIndexRun).runId === "string"
        && SAFE_PATH_SEGMENT.test((run as DebugIndexRun).runId)
        && typeof (run as DebugIndexRun).shadowId === "string"
        && (run as DebugIndexRun).shadowId.length > 0
        && (run as DebugIndexRun).shadowId.length <= 64
        && typeof (run as DebugIndexRun).phase === "string"
        && (run as DebugIndexRun).phase.length > 0
        && (run as DebugIndexRun).phase.length <= 32
        && Number.isFinite((run as DebugIndexRun).startedAt)
        && Number.isFinite((run as DebugIndexRun).endedAt)
        && Number.isInteger((run as DebugIndexRun).bytes)
        && (run as DebugIndexRun).bytes >= 0);
      return { version: 1, runs: runs.slice(0, DEBUG_INDEX_MAX_RUNS) };
    }
  } catch {
    // A corrupt or missing index rebuilds from the sweep scan below.
  }
  return { version: 1, runs: [] };
}

function writeDebugIndex(partition: string, index: DebugIndex): void {
  mkdirSync(join(partition, "debug"), { recursive: true });
  atomicWriteJson(debugIndexPath(partition), index);
}

/** Recursively sanitizes string values of one parsed JSONL record. */
function sanitizeDebugValue(value: unknown): unknown {
  if (typeof value === "string") return sanitizeText(value);
  if (Array.isArray(value)) return value.map(sanitizeDebugValue);
  if (value !== null && typeof value === "object") {
    const output: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(value as Record<string, unknown>)) {
      const safeKey = sanitizeText(key).slice(0, 256);
      if (!safeKey || safeKey === "__proto__" || safeKey === "prototype" || safeKey === "constructor") continue;
      output[safeKey] = sanitizeDebugValue((value as Record<string, unknown>)[key]);
    }
    return output;
  }
  return value;
}

function sanitizeText(text: string): string {
  return sanitizeDisplayText(text);
}

/**
 * Finalizes one debug run: the native child session JSONL is sanitized in
 * place (every string value passes the shared credential cleaner) and one
 * bounded metadata record lands in the partition's debug index.
 */
export function finalizeShadowDebugRun(
  sessionDir: string,
  sessionId: string,
  meta: { runId: string; shadowId: string; startedAt: number; endedAt: number; phase: string },
): void {
  const partition = shadowPartitionPath(sessionDir, sessionId);
  const runDir = shadowDebugRunDir(sessionDir, sessionId, meta.runId);
  const sessionFile = join(runDir, "session.jsonl");
  let bytes = 0;
  try {
    if (!requireRegularFile(sessionFile)) {
      rmSync(runDir, { recursive: true, force: true });
      return;
    }
    const size = lstatSync(sessionFile).size;
    if (size > DEBUG_SANITIZE_MAX_BYTES) {
      // A log too large to sanitize cannot be vouched credential-free, so
      // it is dropped rather than retained unsanitized.
      rmSync(runDir, { recursive: true, force: true });
      return;
    }
    const raw = readFileSync(sessionFile, "utf8");
    const sanitized = raw
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => {
        try {
          return JSON.stringify(sanitizeDebugValue(JSON.parse(line)));
        } catch {
          return JSON.stringify({ type: "debug_corrupt_line", dropped: true });
        }
      })
      .join("\n") + "\n";
    atomicWriteText(sessionFile, sanitized);
    bytes = statSync(sessionFile).size;
  } catch {
    // A debug history that cannot be fully sanitized and atomically replaced is
    // never retained or indexed.
    try {
      rmSync(runDir, { recursive: true, force: true });
    } catch {
      // The next session-start/debug sweep retries residue removal.
    }
    return;
  }
  const index = readDebugIndex(partition);
  index.runs = index.runs.filter((run) => run.runId !== meta.runId);
  index.runs.push({
    runId: requireSafePathSegment(meta.runId, "run id"),
    shadowId: requireSafePathSegment(meta.shadowId.slice(0, 64), "Shadow id"),
    startedAt: meta.startedAt,
    endedAt: meta.endedAt,
    phase: meta.phase.slice(0, 32),
    bytes,
  });
  index.runs.sort((left, right) => left.startedAt - right.startedAt);
  writeDebugIndex(partition, { version: 1, runs: index.runs.slice(-DEBUG_INDEX_MAX_RUNS) });
  sweepShadowDebugRetention(sessionDir, sessionId);
}

/** Lists the partition's bounded debug-run metadata, oldest first. */
export function listShadowDebugRuns(sessionDir: string, sessionId: string): DebugIndexRun[] {
  return readDebugIndex(shadowPartitionPath(sessionDir, sessionId)).runs;
}

/**
 * Enforces debug retention: at most 20 logs per Shadow and a total byte
 * bound, removing the oldest runs first. Removed run directories and their
 * index entries are reported.
 */
export function sweepShadowDebugRetention(
  sessionDir: string,
  sessionId: string,
  bounds?: { maxTotalBytes?: number },
): { removed: string[] } {
  const partition = shadowPartitionPath(sessionDir, sessionId);
  try {
    const partitionStats = lstatSync(partition);
    if (!partitionStats.isDirectory() || partitionStats.isSymbolicLink()) return { removed: [] };
  } catch {
    return { removed: [] };
  }
  const maxTotalBytes = Math.min(
    SHADOW_DEBUG_MAX_TOTAL_BYTES,
    Math.max(1, Math.trunc(bounds?.maxTotalBytes ?? SHADOW_DEBUG_MAX_TOTAL_BYTES)),
  );
  const removed: string[] = [];
  const index = readDebugIndex(partition);
  const runs = [...index.runs];

  // Crash residue: run directories the index never adopted were never
  // sanitized, so they are removed rather than trusted.
  const indexedIds = new Set(runs.map((run) => run.runId));
  const debugRoot = join(partition, "debug");
  if (existsSync(debugRoot)) {
    let directories: string[] = [];
    try {
      directories = readdirSync(debugRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      directories = [];
    }
    for (const name of directories.slice(0, DEBUG_INDEX_MAX_RUNS)) {
      if (indexedIds.has(name)) continue;
      try {
        rmSync(join(debugRoot, name), { recursive: true, force: true });
        removed.push(name);
      } catch {
        // Retried on the next sweep.
      }
    }
  }

  const dropRun = (run: DebugIndexRun): void => {
    try {
      rmSync(shadowDebugRunDir(sessionDir, sessionId, run.runId), { recursive: true, force: true });
    } catch {
      // Best-effort removal; the index entry is dropped regardless.
    }
    removed.push(run.runId);
  };

  // Per-Shadow count bound, oldest first.
  const byShadow = new Map<string, DebugIndexRun[]>();
  for (const run of runs) {
    const list = byShadow.get(run.shadowId) ?? [];
    list.push(run);
    byShadow.set(run.shadowId, list);
  }
  const droppedIds = new Set<string>();
  for (const list of byShadow.values()) {
    const ordered = list.sort((left, right) => left.startedAt - right.startedAt);
    while (ordered.length > SHADOW_DEBUG_MAX_LOGS_PER_SHADOW) {
      const victim = ordered.shift()!;
      dropRun(victim);
      droppedIds.add(victim.runId);
    }
  }

  // Total byte bound, oldest first across all Shadows.
  let kept = runs.filter((run) => !droppedIds.has(run.runId));
  let totalBytes = kept.reduce((sum, run) => sum + run.bytes, 0);
  while (totalBytes > maxTotalBytes && kept.length > 0) {
    const victim = kept.sort((left, right) => left.startedAt - right.startedAt)[0]!;
    totalBytes -= victim.bytes;
    dropRun(victim);
    droppedIds.add(victim.runId);
    kept = kept.filter((run) => run.runId !== victim.runId);
  }

  if (droppedIds.size > 0) {
    writeDebugIndex(partition, {
      version: 1,
      runs: index.runs.filter((run) => !droppedIds.has(run.runId)).slice(-DEBUG_INDEX_MAX_RUNS),
    });
  }
  return { removed };
}

/**
 * Reconciles Shadow partitions against surviving parent sessions. Pi 0.84.2
 * stores sessions as flat `<timestamp>_<sessionId>.jsonl` files inside one
 * shared per-cwd session directory, so a partition keyed by session ID is
 * orphaned exactly when no matching session file remains: partitions whose
 * `*_<id>.jsonl` file is gone (the session was deleted externally or its
 * directory was pruned) are removed, bounded by the scan cap. The live
 * session's own partition is always kept.
 */
export function reconcileShadowPartitions(sessionDir: string, keepSessionId?: string): { removed: string[] } {
  const root = resolve(sessionDir);
  const partitionRoot = join(root, SHADOW_PARTITION_DIR);
  const removed: string[] = [];
  if (!existsSync(partitionRoot)) return { removed };
  try {
    const rootStats = lstatSync(partitionRoot);
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) return { removed };
  } catch {
    return { removed };
  }
  let subEntries;
  try {
    subEntries = readdirSync(partitionRoot, { withFileTypes: true });
  } catch {
    return { removed };
  }
  let sessionFiles: Set<string>;
  try {
    // Session file names are `<timestamp>_<sessionId>.jsonl`; also accept a
    // bare `<sessionId>.jsonl` for explicitly named session files.
    sessionFiles = new Set(readdirSync(root).filter((name) => name.endsWith(".jsonl")));
  } catch {
    return { removed };
  }
  let orphanCandidates = 0;
  for (const sub of subEntries) {
    if (!sub.isDirectory() || !SAFE_PATH_SEGMENT.test(sub.name)) continue;
    if (keepSessionId !== undefined && sub.name === keepSessionId) continue;
    const survives = [...sessionFiles].some((name) => name === `${sub.name}.jsonl` || name.endsWith(`_${sub.name}.jsonl`));
    if (survives) continue;
    orphanCandidates += 1;
    if (orphanCandidates > RECONCILE_MAX_PARTITIONS) break;
    const subPath = join(partitionRoot, sub.name);
    try {
      rmSync(subPath, { recursive: true, force: true });
      removed.push(subPath);
    } catch {
      // A partition that cannot be removed now reconciles on the next start.
    }
  }
  return { removed };
}
