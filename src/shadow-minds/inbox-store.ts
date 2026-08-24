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

import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
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
import { SHADOW_DELIVERIES, SHADOW_TRIGGERS } from "./parser";

/** Hidden partition directory beneath the parent session directory. */
export const SHADOW_PARTITION_DIR = ".pi-square-shadow";

/** Package hard caps for inbox retention. */
export const SHADOW_INBOX_MAX_RESULTS_HARD = 100;
export const SHADOW_INBOX_MAX_BYTES_HARD = 16 * 1024 * 1024;

const INDEX_SUMMARY_MAX_CHARS = 160;
const INDEX_EVENTS_MAX = 32;
const INDEX_SCAN_MAX_FILES = 512;
const ID_MAX_CHARS = 128;
const RECONCILE_MAX_SESSION_DIRS = 1_000;
const SESSION_FILE_NAME = "session.jsonl";

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

/** Resolves one session's Shadow partition path. */
export function shadowPartitionPath(sessionDir: string, sessionId: string): string {
  return join(resolve(sessionDir), SHADOW_PARTITION_DIR, sessionId);
}

function atomicWriteJson(path: string, value: unknown): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  renameSync(tmp, path);
}

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
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
function validatePersistedEntity(value: unknown): ShadowResultEntity | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.version !== 1) return undefined;
  if (!isBoundedString(record.id, ID_MAX_CHARS) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(record.id)) return undefined;
  if (!isBoundedString(record.shadowId, 64)) return undefined;
  if (!isBoundedString(record.shadowName, 120)) return undefined;
  if (record.trigger !== "manual") return undefined;
  if (record.note !== undefined && !isBoundedString(record.note, 8_000)) return undefined;
  if (record.payload === null || typeof record.payload !== "object" || Array.isArray(record.payload)) return undefined;
  if (!isBoundedString(record.summary, 300)) return undefined;
  if (record.delivery !== "notified" && record.delivery !== "pending" && record.delivery !== "delivered") return undefined;
  if (record.attention !== "unread" && record.attention !== "read" && record.attention !== "dismissed") return undefined;
  if (!isFiniteNonNegative(record.createdAt)) return undefined;
  if (record.model !== undefined && !isBoundedString(record.model, 120)) return undefined;
  if (record.usage !== undefined && !isUsage(record.usage)) return undefined;
  if (record.definitionHash !== undefined && !isBoundedString(record.definitionHash, 128)) return undefined;
  if (record.schemaHash !== undefined && !isBoundedString(record.schemaHash, 128)) return undefined;
  if (record.configuredDelivery !== undefined && !SHADOW_DELIVERIES.includes(record.configuredDelivery as never)) return undefined;
  if (record.triggers !== undefined) {
    if (!Array.isArray(record.triggers) || record.triggers.length > 4) return undefined;
    if (!record.triggers.every((trigger) => SHADOW_TRIGGERS.includes(trigger as never))) return undefined;
  }
  if (record.taskIdentity !== undefined) {
    const identity = record.taskIdentity as Record<string, unknown>;
    if (!identity || typeof identity !== "object" || !Number.isInteger(identity.epoch) || (identity.epoch as number) < 0) return undefined;
    if (identity.parentEntryId !== undefined && !isBoundedString(identity.parentEntryId, 64)) return undefined;
  }
  return {
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
    ...(typeof record.configuredDelivery === "string"
      ? { configuredDelivery: record.configuredDelivery as ShadowResultEntity["configuredDelivery"] }
      : {}),
    ...(Array.isArray(record.triggers) ? { triggers: [...record.triggers] as ShadowResultEntity["triggers"] } : {}),
    ...(record.taskIdentity !== undefined
      ? { taskIdentity: structuredClone(record.taskIdentity) as ShadowResultEntity["taskIdentity"] }
      : {}),
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
    results.push({
      id: item.id,
      createdAt: item.createdAt as number,
      delivery: item.delivery as ShadowResultDelivery,
      attention: item.attention as ShadowResultAttention,
      bytes: item.bytes as number,
      summary: item.summary as string,
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

  const entityPath = (id: string): string => join(resultsDir, `${id}.json`);

  const quarantine = (id: string, path: string, cause: string): void => {
    try {
      mkdirSync(quarantineDir, { recursive: true });
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
    const path = entityPath(id);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) return undefined;
    let raw: string;
    try {
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
    const entity = validatePersistedEntity(parsed);
    if (!entity) {
      quarantine(id, path, "shape validation failed");
      return undefined;
    }
    let bytes = 0;
    try {
      bytes = statSync(path).size;
    } catch {
      bytes = raw.length;
    }
    return { entity, bytes };
  };

  const writeEntity = (entry: LoadedEntity): void => {
    mkdirSync(resultsDir, { recursive: true });
    atomicWriteJson(entityPath(entry.entity.id), { version: 1, ...entry.entity });
  };

  const writeIndex = (): void => {
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
      })),
      events: events.slice(-INDEX_EVENTS_MAX),
    };
    atomicWriteJson(indexPath, index);
  };

  const removeEntity = (id: string, reason: "count" | "bytes"): void => {
    const entry = loaded.get(id);
    loaded.delete(id);
    try {
      rmSync(entityPath(id), { force: true });
    } catch {
      // Best-effort removal; the entity is already out of the index.
    }
    events.push({ kind: "evicted", id, at: now(), reason });
    if (entry) diagnostics.push(`Result ${id} was evicted (${reason}).`);
  };

  const enforceRetention = (): void => {
    while (loaded.size > maxResults) {
      const candidate = pickEviction();
      if (!candidate) break;
      removeEntity(candidate, "count");
    }
    let totalBytes = 0;
    for (const entry of loaded.values()) totalBytes += entry.bytes;
    while (totalBytes > maxBytes && loaded.size > 1) {
      const candidate = pickEviction();
      if (!candidate) break;
      const entry = loaded.get(candidate)!;
      totalBytes -= entry.bytes;
      removeEntity(candidate, "bytes");
    }
  };

  const pickEviction = (): string | undefined => {
    const candidate = evictionCandidate([...loaded.values()].map((entry) => entry.entity));
    return candidate?.id;
  };

  // ── Load ──
  mkdirSync(resultsDir, { recursive: true });
  let indexValid = false;
  if (existsSync(indexPath)) {
    try {
      const parsed = validatePersistedIndex(JSON.parse(readFileSync(indexPath, "utf8")));
      if (parsed) {
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
  if (!indexValid) {
    // Rebuild from a bounded validated scan of the results directory.
    diagnostics.push("The inbox index was missing or corrupt and was rebuilt from a validated scan.");
    let names: string[] = [];
    try {
      names = readdirSync(resultsDir).filter((name) => name.endsWith(".json"));
    } catch {
      names = [];
    }
    for (const name of names.slice(0, INDEX_SCAN_MAX_FILES)) {
      const id = name.slice(0, -".json".length);
      const loadedEntity = loadEntityFile(id);
      if (loadedEntity) loaded.set(loadedEntity.entity.id, loadedEntity);
    }
  }
  enforceRetention();
  writeIndex();

  return {
    persistent: true,
    add(input: ShadowInboxAddInput): ShadowResultEntity {
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
        ...(input.schemaHash ? { schemaHash: input.schemaHash } : {}),
        ...(input.configuredDelivery ? { configuredDelivery: input.configuredDelivery } : {}),
        ...(input.triggers ? { triggers: [...input.triggers] } : {}),
        ...(input.taskIdentity ? { taskIdentity: clone(input.taskIdentity) } : {}),
      };
      let bytes = 0;
      try {
        bytes = statSync(entityPath(entity.id)).size;
      } catch {
        bytes = JSON.stringify(entity).length;
      }
      loaded.set(entity.id, { entity, bytes });
      writeEntity({ entity, bytes });
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
      entry.entity.delivery = "pending";
      writeEntity(entry);
      writeIndex();
      return true;
    },
    markRead(id: string): boolean {
      const entry = loaded.get(id);
      if (!entry) return false;
      entry.entity.attention = "read";
      writeEntity(entry);
      writeIndex();
      return true;
    },
    dismiss(id: string): boolean {
      const entry = loaded.get(id);
      if (!entry) return false;
      entry.entity.attention = "dismissed";
      writeEntity(entry);
      writeIndex();
      return true;
    },
    delete(id: string): boolean {
      const entry = loaded.get(id);
      if (!entry) return false;
      loaded.delete(id);
      try {
        rmSync(entityPath(id), { force: true });
      } catch {
        // Best-effort; the index no longer references it.
      }
      writeIndex();
      return true;
    },
    clear(): void {
      // The partition is the authoritative record and deliberately survives
      // session-scoped resets; per-session clearing removes nothing.
    },
    events(): ShadowInboxEvictionEvent[] {
      return [...events];
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
  return join(shadowPartitionPath(sessionDir, sessionId), "debug", runId);
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
    const parsed = JSON.parse(readFileSync(debugIndexPath(partition), "utf8"));
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.runs)) {
      const runs = parsed.runs.filter((run: unknown) =>
        run && typeof run === "object"
        && typeof (run as DebugIndexRun).runId === "string"
        && typeof (run as DebugIndexRun).shadowId === "string"
        && typeof (run as DebugIndexRun).phase === "string"
        && Number.isFinite((run as DebugIndexRun).startedAt)
        && Number.isFinite((run as DebugIndexRun).endedAt));
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
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>).map((key) => [
        key,
        sanitizeDebugValue((value as Record<string, unknown>)[key]),
      ]),
    );
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
    const raw = readFileSync(sessionFile, "utf8");
    if (raw.length <= DEBUG_SANITIZE_MAX_BYTES) {
      // Sanitize in place through a temporary sibling and atomic rename.
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
      const tmp = `${sessionFile}.tmp`;
      writeFileSync(tmp, sanitized, "utf8");
      renameSync(tmp, sessionFile);
    }
  } catch {
    // No session file: the run produced no debug history.
  }
  try {
    bytes = statSync(sessionFile).size;
  } catch {
    bytes = 0;
  }
  const index = readDebugIndex(partition);
  index.runs = index.runs.filter((run) => run.runId !== meta.runId);
  index.runs.push({
    runId: meta.runId,
    shadowId: meta.shadowId.slice(0, 64),
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
  const maxTotalBytes = Math.min(
    SHADOW_DEBUG_MAX_TOTAL_BYTES,
    Math.max(1, Math.trunc(bounds?.maxTotalBytes ?? SHADOW_DEBUG_MAX_TOTAL_BYTES)),
  );
  const removed: string[] = [];
  const index = readDebugIndex(partition);
  const runs = [...index.runs];

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
 * Reconciles Shadow partitions against surviving parent sessions. For every
 * sibling session directory (bounded scan), a partition whose session file
 * is gone is orphaned: each session-keyed partition inside it is removed
 * and reported, then the emptied partition root is cleaned up. Inside the
 * surviving session's own partition, subdirectories other than the current
 * session ID are foreign orphans and are removed too. Deleting a parent
 * session removes its directory — and with it its partition — so this pass
 * covers sessions whose files were removed externally while the directory
 * remained.
 */
export function reconcileShadowPartitions(sessionDir: string, keepSessionId?: string): { removed: string[] } {
  const root = dirname(resolve(sessionDir));
  const removed: string[] = [];
  if (!existsSync(root)) return { removed };
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return { removed };
  }
  for (const entry of entries.slice(0, RECONCILE_MAX_SESSION_DIRS)) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    const partitionRoot = join(dir, SHADOW_PARTITION_DIR);
    if (!existsSync(partitionRoot)) continue;
    const sessionSurvives = existsSync(join(dir, SESSION_FILE_NAME));
    let subEntries;
    try {
      subEntries = readdirSync(partitionRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const sub of subEntries) {
      if (!sub.isDirectory()) continue;
      const subPath = join(partitionRoot, sub.name);
      if (sessionSurvives && keepSessionId !== undefined && sub.name === keepSessionId) continue;
      if (sessionSurvives && keepSessionId === undefined) continue;
      try {
        rmSync(subPath, { recursive: true, force: true });
        removed.push(subPath);
      } catch {
        // A partition that cannot be removed now reconciles on the next start.
      }
    }
    if (!sessionSurvives) {
      try {
        rmSync(partitionRoot, { recursive: true, force: true });
      } catch {
        // The emptied root reconciles on the next start.
      }
    }
  }
  return { removed };
}
