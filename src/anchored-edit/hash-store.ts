import { basename, dirname, join } from "path";
import { stat } from "fs/promises";
import { mkdirSync, renameSync } from "fs";
import { DatabaseSync } from "node:sqlite";
import { errCode, splitLines } from "./utils";
import { initHasher, contentChecksum } from "./hashline/hasher";
import { HASH_RE } from "./hashline/alphabet";
import { HASH_STORE_VERSION, HASH_STORE_BUSY_TIMEOUT } from "./constants";
import { acquireFileLock } from "./file-lock";

export interface OwnerPartition {
  owner: string;
  /** Newest updated_at across the owner's snapshot and served rows. */
  updatedAt: number;
}

interface SnapshotCacheEntry {
  checksum: string;
  lineCount: number;
  hashes: string[];
}

/**
 * Typed, owner-scoped view over one physical anchor store. Every runtime
 * caller binds a required owner; an ownerless store can no longer be
 * constructed, so the former two-schemas-under-one-version state is
 * unrepresentable. Snapshot lookups, served merges, owner deletion, and path
 * pruning are typed repository operations here; SQL parameter order never
 * spreads through callers.
 */
export interface ServedState {
  /**
   * Hashes served to the owner for exactly the current content version. A
   * replace may verify its range against these.
   */
  served: Set<string>;
}

export interface StaleServedState {
  /**
   * Served rows exist for the path, but every one of them was recorded for a
   * different content version — the file changed after the last served read
   * (for example a mutation whose post-commit publication failed, or a crash
   * at that boundary). The old authorization is unusable: the caller must
   * refuse until a fresh read republishes rows for the current version.
   */
  stale: true;
}

export type ServedLookup = ServedState | StaleServedState | undefined;

/**
 * Typed, owner-scoped view over one physical anchor store. Every runtime
 * caller binds a required owner; an ownerless store can no longer be
 * constructed, so the former two-schemas-under-one-version state is
 * unrepresentable. Snapshot lookups, served lookups and merges, read and
 * mutation publications, owner listing and deletion, and path pruning are
 * typed repository operations here; SQL parameter order and transaction
 * ownership never spread through callers.
 *
 * Served rows are bound to the exact content version (checksum) they were
 * served from. Every served publication first drops rows recorded for other
 * content versions in the same transaction, so at most one content version
 * is ever authorized per (owner, path), and a mutation whose publication
 * failed can never leave the previous version authorizing edits against the
 * changed file.
 */
/** Write publication is a discriminated input: either the write clears the
 *  path's served rows for a new content version with no snapshot and no new
 *  rows (auto-read off, unchanged, empty, or unsupported content), or it
 *  publishes exactly one snapshot for the written version and optionally
 *  serves fresh rows bound to that version. Invalid combinations — served
 *  rows without a version, a snapshot without content — are
 *  unrepresentable. */
export type WritePublication =
  | { kind: "clear"; path: string }
  | {
      kind: "publish";
      path: string;
      snapshot: { content: string; hashes: string[] };
      servedHashes?: string[];
    };

export interface HashStoreHandle {
  readonly engine: "node:sqlite";
  /** Required owner identity this view reads and writes under. */
  readonly owner: string;
  /** Releases this acquisition so the underlying database can be evicted when idle. Safe to call repeatedly. */
  release(): void;
  /** Snapshot hashes for exact (path, content) under this owner, reading the
   *  store-owned cache first. Deletes a corrupt row when `deleteCorrupt`. */
  getSnapshot(path: string, content: string, deleteCorrupt?: boolean): string[] | undefined;
  /** Pure snapshot lookup for preparation: bypasses and does not mutate the
   *  cache or database, including when the stored row is malformed. */
  peekSnapshot(path: string, content: string): string[] | undefined;
  upsertSnapshot(path: string, checksum: string, lineCount: number, hashes: string[]): void;
  deleteSnapshot(path: string): void;
  /** Drops this owner's cached snapshot for the path (no database change). */
  invalidateSnapshotCache(path: string): void;
  /** Served state for the path under this owner, resolved against the exact
   *  `content`: the served set for this version, a stale marker when only
   *  other-version rows exist, or undefined when no rows exist at all. */
  getServedState(path: string, content: string): ServedLookup;
  /** Merges hashes as served for exactly `content`'s version, dropping any
   *  rows recorded for other content versions in the same transaction. */
  mergeServed(path: string, hashes: string[], content: string): void;
  clearServed(path: string): void;
  /** Every path with a snapshot or served row under this owner. */
  allPaths(): string[];
  /** Snapshot paths under this owner whose stored hashes contain every given hash. */
  findSnapshotPaths(hashes: string[]): string[];
  /** Runs mutations inside one repository transaction on this store's
   *  database; a failure rolls the whole transaction back. */
  withTransaction(fn: () => void): void;
  /**
   * Publishes one completed anchored read as a single repository
   * transaction: the snapshot for the observed content and the served rows
   * for exactly that content version. Either both land or neither does.
   */
  publishRead(input: { path: string; content: string; hashes: string[]; servedHashes: string[] }): void;
  /**
   * Publishes one completed mutation's store state — the snapshot for the
   * installed content and, when the diff rows were model-visible, the served
   * rows for exactly that content version — as a single repository
   * transaction under the acting owner.
   */
  publishMutation(input: { path: string; content: string; hashes: string[]; servedHashes?: string[] }): void;
  /**
   * Publishes one completed write as a single repository transaction: the
   * snapshot for the written content and the served rows for exactly that
   * content version — replacing every previous served row for the path
   * (including removing them entirely when no rows are supplied). A failure
   * rolls the whole transaction back, so the previous version's rows remain
   * and cannot authorize anything against the new bytes.
   */
  publishWrite(input: WritePublication): void;
  /** Every owner partition in this store with its newest activity. */
  listOwners(): OwnerPartition[];
  /** Deletes every row of one owner partition as a single transaction and
   *  invalidates exactly that owner's cached snapshots. */
  deleteOwnerPartition(owner: string): void;
}

export function isValidHashList(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false;
  for (const hash of value) {
    if (typeof hash !== "string" || !HASH_RE.test(hash)) return false;
  }
  if (new Set(value).size !== value.length) return false;
  return true;
}

export function parseHashList(raw: string, onInvalid: () => void): string[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    onInvalid();
    return undefined;
  }
  if (!isValidHashList(parsed)) {
    onInvalid();
    return undefined;
  }
  return parsed;
}

export function isCorruptionError(error: unknown): boolean {
  if (error && typeof error === "object") {
    const errcode = (error as { errcode?: unknown }).errcode;
    if (typeof errcode === "number") {
      return errcode === 11 || errcode === 24 || errcode === 26;
    }
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && /NOTADB|CORRUPT/.test(code)) return true;
  }
  return (
    error instanceof Error &&
    /corrupt|not a database|malformed|database disk image/i.test(error.message)
  );
}

function isBusyError(error: unknown): boolean {
  if (error && typeof error === "object") {
    const errcode = (error as { errcode?: unknown }).errcode;
    if (typeof errcode === "number") return errcode === 5 || errcode === 6;
  }
  return error instanceof Error && /busy|locked/i.test(error.message);
}

function sleepSync(ms: number): void {
  const sab = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(sab, 0, 0, ms);
}

const BUSY_RETRIES = 3;
const BUSY_RETRY_DELAY_MS = 100;

function withBusyRetry<T>(fn: () => T): T {
  let lastError: unknown;
  for (let attempt = 0; attempt <= BUSY_RETRIES; attempt++) {
    try {
      return fn();
    } catch (error) {
      lastError = error;
      if (!isBusyError(error) || attempt === BUSY_RETRIES) throw error;
      sleepSync(BUSY_RETRY_DELAY_MS);
    }
  }
  throw lastError;
}

type OpenedDb =
  | { db: DatabaseSync; legacy: true }
  | { db: DatabaseSync; legacy: false };

function openDbWithBusyRetry(storePath: string): OpenedDb {
  return withBusyRetry(() => openDb(storePath));
}

let exitHandlerRegistered = false;

/** Cache key for one owner's snapshot of one path inside a store entry. */
function snapshotCacheKey(owner: string, path: string): string {
  return `${owner}\u0000${path}`;
}

interface OpenStore {
  key: string;
  path: string;
  db: DatabaseSync;
  stmts: StoreStatements;
  refs: number;
  lastUsed: number;
  closeWhenIdle: boolean;
  /** Snapshot cache owned by this physical store, scoped by owner and path. */
  snapshots: Map<string, SnapshotCacheEntry>;
}

interface StoreStatements {
  getSnapshot: (owner: string, path: string, checksum: string, lineCount: number) => string | undefined;
  upsertSnapshot: (owner: string, path: string, checksum: string, lineCount: number, hashes: string, updatedAt: number) => void;
  deleteSnapshot: (owner: string, path: string) => void;
  servedRows: (owner: string, path: string) => { hash: string; content_hash: string }[];
  /**
   * Drops rows recorded for any other content version, then merges the given
   * hashes for the exact version. Row-level conflict-free: concurrent
   * additions under one owner and version union instead of one update
   * replacing the other. The timestamp refresh keeps partition activity tied
   * to real anchored use even when the added hashes were already present.
   */
  mergeServedVersioned: (owner: string, path: string, hashes: string[], contentHash: string, updatedAt: number) => void;
  clearServed: (owner: string, path: string) => void;
  allPaths: (owner: string) => string[];
  allHashes: (owner: string) => { path: string; hashes: string }[];
  listOwners: () => { owner: string; updated_at: number }[];
  deleteOwnerRows: (owner: string) => void;
}

/**
 * Bound on how many distinct store files the module holds open at once. The
 * cache holds one entry per physical store path (all owners share it); when
 * the cache exceeds this bound, the least-recently-used database with no
 * in-flight view is closed. A database an in-flight view still holds
 * (refs > 0) is never closed, so the bound is a soft cap under concurrent
 * load.
 */
export const OPEN_STORE_LIMIT = 4;

/** Per-store bound on cached snapshots across all owners of one store. */
export const SNAPSHOT_CACHE_LIMIT = 256;

const openStores = new Map<string, OpenStore>();
const openingStores = new Map<string, Promise<OpenStore>>();
let openTick = 0;
let shutdownGeneration = 0;
const loadBarrier: {
  beforeAcquire?: (storePath: string) => Promise<void>;
} = {};

function acquireView(entry: OpenStore, owner: string): HashStoreHandle {
  entry.refs += 1;
  entry.lastUsed = ++openTick;
  return new HashStoreHandleImpl(entry, owner);
}

function closeMarkedIdle(entry: OpenStore): boolean {
  if (entry.refs !== 0 || !entry.closeWhenIdle || openingStores.has(entry.key)) return false;
  if (openStores.get(entry.key) === entry) openStores.delete(entry.key);
  entry.snapshots.clear();
  shutdownDb(entry.db);
  return true;
}

function dropOwnerCache(entry: OpenStore, owner: string): void {
  const prefix = `${owner}\u0000`;
  for (const key of entry.snapshots.keys()) {
    if (key.startsWith(prefix)) entry.snapshots.delete(key);
  }
}

function maybeEvict(): void {
  while (openStores.size > OPEN_STORE_LIMIT) {
    let idleLru: OpenStore | undefined;
    for (const entry of openStores.values()) {
      if (entry.refs > 0 || !entry.db.isOpen) continue;
      // An entry whose open has not yet been handed to its caller (the key is
      // still in the opening map) must not be evicted before that acquire.
      if (openingStores.has(entry.key)) continue;
      if (!idleLru || entry.lastUsed < idleLru.lastUsed) idleLru = entry;
    }
    if (!idleLru) break;
    openStores.delete(idleLru.key);
    idleLru.snapshots.clear();
    shutdownDb(idleLru.db);
  }
}

class HashStoreHandleImpl implements HashStoreHandle {
  readonly engine = "node:sqlite" as const;
  readonly owner: string;
  /** @internal Physical store entry backing this view. */
  readonly entry: OpenStore;
  private released = false;

  constructor(entry: OpenStore, owner: string) {
    this.entry = entry;
    this.owner = owner;
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    this.entry.refs -= 1;
    if (closeMarkedIdle(this.entry)) return;
    maybeEvict();
  }

  /** @internal The store entry, verified open. */
  requireOpen(): OpenStore {
    if (!this.entry.db.isOpen) {
      throw new Error("Hash store is not open; transactional update aborted");
    }
    return this.entry;
  }

  getSnapshot(path: string, content: string, deleteCorrupt = true): string[] | undefined {
    const entry = this.requireOpen();
    const checksum = contentChecksum(content);
    const lineCount = splitLines(content).length;
    const key = snapshotCacheKey(this.owner, path);
    const cached = entry.snapshots.get(key);
    if (cached && cached.checksum === checksum && cached.lineCount === lineCount) {
      entry.snapshots.delete(key);
      entry.snapshots.set(key, cached);
      return cached.hashes.slice();
    }
    const raw = entry.stmts.getSnapshot(this.owner, path, checksum, lineCount);
    if (raw === undefined) return undefined;
    const parsed = parseHashList(raw, () => {
      if (deleteCorrupt) entry.stmts.deleteSnapshot(this.owner, path);
      entry.snapshots.delete(key);
    });
    if (!parsed) return undefined;
    cacheSnapshot(entry, key, checksum, lineCount, parsed);
    return parsed;
  }

  peekSnapshot(path: string, content: string): string[] | undefined {
    const entry = this.requireOpen();
    const raw = entry.stmts.getSnapshot(
      this.owner,
      path,
      contentChecksum(content),
      splitLines(content).length,
    );
    return raw === undefined ? undefined : parseHashList(raw, () => {});
  }

  upsertSnapshot(path: string, checksum: string, lineCount: number, hashes: string[]): void {
    const entry = this.requireOpen();
    withBusyRetry(() => {
      entry.stmts.upsertSnapshot(this.owner, path, checksum, lineCount, JSON.stringify(hashes), Date.now());
    });
    cacheSnapshot(entry, snapshotCacheKey(this.owner, path), checksum, lineCount, hashes);
  }

  deleteSnapshot(path: string): void {
    const entry = this.requireOpen();
    withBusyRetry(() => {
      entry.stmts.deleteSnapshot(this.owner, path);
    });
    entry.snapshots.delete(snapshotCacheKey(this.owner, path));
  }

  invalidateSnapshotCache(path: string): void {
    this.entry.snapshots.delete(snapshotCacheKey(this.owner, path));
  }

  getServedState(path: string, content: string): ServedLookup {
    const entry = this.requireOpen();
    const rows = entry.stmts.servedRows(this.owner, path);
    if (rows.length === 0) return undefined;
    const version = contentChecksum(content);
    const current: string[] = [];
    for (const row of rows) {
      if (!HASH_RE.test(row.hash) || typeof row.content_hash !== "string") {
        // Same repair semantics the JSON-array layout had: an invalid served
        // payload for a path is discarded and re-recorded by the next read.
        withBusyRetry(() => {
          entry.stmts.clearServed(this.owner, path);
        });
        return undefined;
      }
      if (row.content_hash === version) current.push(row.hash);
    }
    if (current.length === 0) {
      // Rows exist only for other content versions: the authorization is
      // stale against the current file and must not verify any range.
      return { stale: true };
    }
    return { served: new Set(current) };
  }

  mergeServed(path: string, hashes: string[], content: string): void {
    if (hashes.length === 0) return;
    const entry = this.requireOpen();
    const version = contentChecksum(content);
    const updatedAt = Date.now();
    this.withTransaction(() => {
      entry.stmts.mergeServedVersioned(this.owner, path, hashes, version, updatedAt);
    });
  }

  clearServed(path: string): void {
    const entry = this.requireOpen();
    withBusyRetry(() => {
      entry.stmts.clearServed(this.owner, path);
    });
  }

  allPaths(): string[] {
    return this.requireOpen().stmts.allPaths(this.owner);
  }

  findSnapshotPaths(hashes: string[]): string[] {
    const rows = this.requireOpen().stmts.allHashes(this.owner);
    const matches: string[] = [];
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.hashes) as unknown;
        if (!isValidHashList(parsed)) continue;
        if (hashes.every((h) => parsed.includes(h))) matches.push(row.path);
      } catch {
        continue;
      }
    }
    return matches;
  }

  withTransaction(fn: () => void): void {
    const entry = this.requireOpen();
    withBusyRetry(() => {
      entry.db.exec("BEGIN IMMEDIATE");
      try {
        fn();
        entry.db.exec("COMMIT");
      } catch (e) {
        try { entry.db.exec("ROLLBACK"); } catch {}
        throw e;
      }
    });
  }

  publishRead(input: { path: string; content: string; hashes: string[]; servedHashes: string[] }): void {
    this.publishSnapshotAndServed(input.path, { content: input.content, hashes: input.hashes }, input.servedHashes);
  }

  publishMutation(input: { path: string; content: string; hashes: string[]; servedHashes?: string[] }): void {
    this.publishSnapshotAndServed(input.path, { content: input.content, hashes: input.hashes }, input.servedHashes);
  }

  /** Read and mutation publications share one transaction primitive: one
   *  snapshot upsert plus optional rows served against exactly that
   *  content version. */
  private publishSnapshotAndServed(
    path: string,
    snapshot: { content: string; hashes: string[] },
    servedHashes?: string[],
  ): void {
    const entry = this.requireOpen();
    const checksum = contentChecksum(snapshot.content);
    const lineCount = splitLines(snapshot.content).length;
    const updatedAt = Date.now();
    this.withTransaction(() => {
      entry.stmts.upsertSnapshot(this.owner, path, checksum, lineCount, JSON.stringify(snapshot.hashes), updatedAt);
      if (servedHashes && servedHashes.length > 0) {
        entry.stmts.mergeServedVersioned(this.owner, path, servedHashes, checksum, updatedAt);
      }
    });
    cacheSnapshot(entry, snapshotCacheKey(this.owner, path), checksum, lineCount, snapshot.hashes);
  }

  publishWrite(input: WritePublication): void {
    const entry = this.requireOpen();
    if (input.kind === "clear") {
      // The clearing is the contract: every successful write replaces the
      // path's served rows; with no published version there is nothing left
      // to serve.
      this.withTransaction(() => {
        entry.stmts.clearServed(this.owner, input.path);
      });
      return;
    }
    const checksum = contentChecksum(input.snapshot.content);
    const lineCount = splitLines(input.snapshot.content).length;
    const updatedAt = Date.now();
    this.withTransaction(() => {
      entry.stmts.upsertSnapshot(this.owner, input.path, checksum, lineCount, JSON.stringify(input.snapshot.hashes), updatedAt);
      entry.stmts.clearServed(this.owner, input.path);
      if (input.servedHashes && input.servedHashes.length > 0) {
        entry.stmts.mergeServedVersioned(this.owner, input.path, input.servedHashes, checksum, updatedAt);
      }
    });
    cacheSnapshot(entry, snapshotCacheKey(this.owner, input.path), checksum, lineCount, input.snapshot.hashes);
  }

  listOwners(): OwnerPartition[] {
    const rows = this.requireOpen().stmts.listOwners();
    return rows.map((row) => ({
      owner: String(row.owner),
      updatedAt: Number(row.updated_at ?? 0),
    }));
  }

  deleteOwnerPartition(owner: string): void {
    const entry = this.requireOpen();
    this.withTransaction(() => {
      entry.stmts.deleteOwnerRows(owner);
    });
    dropOwnerCache(entry, owner);
  }
}

function cacheSnapshot(
  entry: OpenStore,
  key: string,
  checksum: string,
  lineCount: number,
  hashes: string[],
): void {
  entry.snapshots.delete(key);
  entry.snapshots.set(key, { checksum, lineCount, hashes: hashes.slice() });
  if (entry.snapshots.size > SNAPSHOT_CACHE_LIMIT) {
    const oldest = entry.snapshots.keys().next().value;
    if (oldest !== undefined) entry.snapshots.delete(oldest);
  }
}

/**
 * One owner-aware schema for every store. Any non-empty database whose
 * recorded version is not the current one — including the former ownerless
 * current-version layout and every undo-bearing store — is legacy and is
 * quarantined whole by the loader. A database that *claims* the current
 * version must actually carry the current layout: a version row alone does
 * not make a database current, so a current-version file with missing or
 * reshaped tables is legacy too and is quarantined the same way.
 */
function inspectLegacyStore(db: DatabaseSync): boolean {
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
  ).all() as Array<{ name?: unknown }>;
  if (tables.length === 0) return false;
  if (!tables.some((row) => row.name === "meta")) return true;
  try {
    const versionRow = db.prepare("SELECT value FROM meta WHERE key = 'version'").get() as { value?: string } | undefined;
    if (versionRow?.value !== String(HASH_STORE_VERSION)) return true;
    return !hasCurrentSchemaShape(db, tables.map((row) => String(row.name)));
  } catch {
    return true;
  }
}

interface ExpectedColumn {
  name: string;
  type: string;
  notNull: boolean;
  /** 1-based primary-key position, 0 when the column is not part of the key. */
  pk: number;
}

/** The exact current layout: every expected table with its exact columns,
 *  declared types, NOT NULL flags, and primary keys. A database claiming the
 *  current version must match this shape completely and contain no other
 *  owned tables (any extra table — including every undo-bearing layout — is
 *  an incompatible legacy layout). */
const CURRENT_SCHEMA_TABLES: Record<string, ExpectedColumn[]> = {
  meta: [
    { name: "key", type: "TEXT", notNull: false, pk: 1 },
    { name: "value", type: "TEXT", notNull: true, pk: 0 },
  ],
  snapshots: [
    { name: "owner", type: "TEXT", notNull: true, pk: 1 },
    { name: "path", type: "TEXT", notNull: true, pk: 2 },
    { name: "checksum", type: "TEXT", notNull: true, pk: 0 },
    { name: "line_count", type: "INTEGER", notNull: true, pk: 0 },
    { name: "hashes", type: "TEXT", notNull: true, pk: 0 },
    { name: "updated_at", type: "INTEGER", notNull: true, pk: 0 },
  ],
  served: [
    { name: "owner", type: "TEXT", notNull: true, pk: 1 },
    { name: "path", type: "TEXT", notNull: true, pk: 2 },
    { name: "hash", type: "TEXT", notNull: true, pk: 3 },
    { name: "content_hash", type: "TEXT", notNull: true, pk: 0 },
    { name: "updated_at", type: "INTEGER", notNull: true, pk: 0 },
  ],
};

/** Strict shape check for a database claiming the current version. Any
 *  deviation is an incompatible layout that is quarantined whole rather
 *  than probed statement-by-statement later:
 *  - the visible table set is exactly {meta, snapshots, served};
 *  - each table's columns — through `PRAGMA table_xinfo`, which unlike
 *    `table_info` also exposes hidden and generated (VIRTUAL/STORED)
 *    columns — match exactly in name, order, type, nullability, and
 *    primary-key position, with no column of any kind beyond the expected
 *    set (a generated `STORED UNIQUE` column fails here);
 *  - no column carries a default;
 *  - the database defines no extra schema objects that change transaction
 *    semantics: no views, no triggers, and no indexes besides the one
 *    automatic index each expected PRIMARY KEY implies (extra UNIQUE
 *    constraints materialize as extra autoindexes and are caught by the
 *    per-table count).
 */
function hasCurrentSchemaShape(db: DatabaseSync, ownedTables: string[]): boolean {
  const allowed = new Set(Object.keys(CURRENT_SCHEMA_TABLES));
  if (ownedTables.some((table) => !allowed.has(table))) return false;

  for (const [table, expected] of Object.entries(CURRENT_SCHEMA_TABLES)) {
    let columns: Array<{ name?: unknown; type?: unknown; notnull?: unknown; dflt_value?: unknown; pk?: unknown; hidden?: unknown }>;
    try {
      columns = db.prepare(`PRAGMA table_xinfo(${table})`).all() as Array<{ name?: unknown; type?: unknown; notnull?: unknown; dflt_value?: unknown; pk?: unknown; hidden?: unknown }>;
    } catch {
      return false;
    }
    if (columns.length !== expected.length) return false;
    for (let i = 0; i < expected.length; i += 1) {
      const column = columns[i]!;
      const want = expected[i]!;
      if (
        String(column.name) !== want.name
        || String(column.type).toUpperCase() !== want.type
        || (Number(column.notnull) !== 0) !== want.notNull
        || Number(column.pk) !== want.pk
        || column.dflt_value !== null && column.dflt_value !== undefined
        || Number(column.hidden) !== 0
      ) {
        return false;
      }
    }
  }

  // No unexpected schema objects: exactly the three tables, no views or
  // triggers, and exactly one automatic index per expected PRIMARY KEY.
  // (sqlite_autoindex_* rows live behind the sqlite_% name prefix, so index
  // counting queries them explicitly; extra UNIQUE constraints materialize
  // as additional autoindexes and are caught by the per-table count.)
  let objects: Array<{ type?: unknown; name?: unknown }>;
  let indexes: Array<{ name?: unknown; tbl_name?: unknown }>;
  try {
    objects = db.prepare(
      "SELECT type, name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'",
    ).all() as Array<{ type?: unknown; name?: unknown }>;
    indexes = db.prepare(
      "SELECT name, tbl_name FROM sqlite_schema WHERE type = 'index'",
    ).all() as Array<{ name?: unknown; tbl_name?: unknown }>;
  } catch {
    return false;
  }
  if (objects.length !== allowed.size) return false;
  for (const object of objects) {
    if (String(object.type) !== "table" || !allowed.has(String(object.name))) return false;
  }
  const autoIndexCounts = new Map<string, number>();
  for (const index of indexes) {
    const name = String(index.name);
    if (!name.startsWith("sqlite_autoindex_")) {
      // Any non-automatic index (extra UNIQUE or user index), view, or
      // trigger changes insert/update semantics and is incompatible.
      return false;
    }
    const owner = String(index.tbl_name);
    autoIndexCounts.set(owner, (autoIndexCounts.get(owner) ?? 0) + 1);
  }
  for (const table of allowed) {
    if ((autoIndexCounts.get(table) ?? 0) !== 1) return false;
  }
  return true;
}

function openDb(storePath: string): OpenedDb {
  const db = new DatabaseSync(storePath, {
    timeout: HASH_STORE_BUSY_TIMEOUT,
  });
  try {
    // Inspect before any PRAGMA that can create sidecars, DDL, or version
    // write: an older non-empty database is quarantined in its original
    // schema rather than being partially migrated before it is renamed aside.
    if (inspectLegacyStore(db)) return { db, legacy: true };
    return buildStore(db);
  } catch (error) {
    try {
      db.close();
    } catch {}
    throw error;
  }
}

function buildStore(db: DatabaseSync): { db: DatabaseSync; legacy: false } {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec(
    "CREATE TABLE IF NOT EXISTS meta (" +
      "key TEXT PRIMARY KEY, " +
      "value TEXT NOT NULL" +
    ")"
  );
  db.exec(
    "CREATE TABLE IF NOT EXISTS snapshots (" +
      "owner TEXT NOT NULL, " +
      "path TEXT NOT NULL, " +
      "checksum TEXT NOT NULL, " +
      "line_count INTEGER NOT NULL, " +
      "hashes TEXT NOT NULL, " +
      "updated_at INTEGER NOT NULL, " +
      "PRIMARY KEY(owner, path)" +
    ")"
  );
  db.exec(
    "CREATE TABLE IF NOT EXISTS served (" +
      "owner TEXT NOT NULL, " +
      "path TEXT NOT NULL, " +
      "hash TEXT NOT NULL, " +
      "content_hash TEXT NOT NULL, " +
      "updated_at INTEGER NOT NULL, " +
      "PRIMARY KEY(owner, path, hash)" +
    ")"
  );
  // A current database reaches this point; an empty database receives the
  // owner-aware schema and its first version row. Older non-empty databases
  // were detected before DDL and are quarantined untouched.
  db.prepare(
    "INSERT INTO meta (key, value) VALUES ('version', ?) " +
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(String(HASH_STORE_VERSION));
  return { db, legacy: false };
}

function buildStatements(db: DatabaseSync): StoreStatements {
  const getSnapshotStmt = db.prepare(
    "SELECT hashes FROM snapshots WHERE owner = ? AND path = ? AND checksum = ? AND line_count = ?"
  );
  const upsertSnapshotStmt = db.prepare(
    "INSERT INTO snapshots (owner, path, checksum, line_count, hashes, updated_at) VALUES (?, ?, ?, ?, ?, ?) " +
    "ON CONFLICT(owner, path) DO UPDATE SET checksum = excluded.checksum, line_count = excluded.line_count, hashes = excluded.hashes, updated_at = excluded.updated_at"
  );
  const deleteSnapshotStmt = db.prepare("DELETE FROM snapshots WHERE owner = ? AND path = ?");
  const servedRowsStmt = db.prepare("SELECT hash, content_hash FROM served WHERE owner = ? AND path = ?");
  const dropOtherVersionsStmt = db.prepare(
    "DELETE FROM served WHERE owner = ? AND path = ? AND content_hash != ?"
  );
  const mergeServedBase = db.prepare(
    "INSERT INTO served (owner, path, hash, content_hash, updated_at) VALUES (?, ?, ?, ?, ?) " +
    "ON CONFLICT(owner, path, hash) DO UPDATE SET content_hash = excluded.content_hash, updated_at = excluded.updated_at"
  );
  const clearServedStmt = db.prepare("DELETE FROM served WHERE owner = ? AND path = ?");
  const allPathsStmt = db.prepare(
    "SELECT path FROM snapshots WHERE owner = ? UNION SELECT path FROM served WHERE owner = ?"
  );
  const allHashesStmt = db.prepare("SELECT path, hashes FROM snapshots WHERE owner = ?");
  const ownerListStmt = db.prepare(
    "SELECT owner, MAX(updated_at) AS updated_at FROM (" +
    "SELECT owner, updated_at FROM snapshots " +
    "UNION ALL SELECT owner, updated_at FROM served" +
    ") GROUP BY owner"
  );
  const deleteOwnerStmt = db.prepare("DELETE FROM snapshots WHERE owner = ?");
  const deleteOwnerServedStmt = db.prepare("DELETE FROM served WHERE owner = ?");
  return {
    getSnapshot: (owner, path, checksum, lineCount) =>
      (getSnapshotStmt.get(owner, path, checksum, lineCount) as { hashes?: string } | undefined)?.hashes,
    upsertSnapshot: (owner, path, checksum, lineCount, hashes, updatedAt) => {
      upsertSnapshotStmt.run(owner, path, checksum, lineCount, hashes, updatedAt);
    },
    deleteSnapshot: (owner, path) => { deleteSnapshotStmt.run(owner, path); },
    servedRows: (owner, path) =>
      servedRowsStmt.all(owner, path) as { hash: string; content_hash: string }[],
    mergeServedVersioned: (owner, path, hashes, contentHash, updatedAt) => {
      dropOtherVersionsStmt.run(owner, path, contentHash);
      for (const hash of hashes) {
        mergeServedBase.run(owner, path, hash, contentHash, updatedAt);
      }
    },
    clearServed: (owner, path) => { clearServedStmt.run(owner, path); },
    allPaths: (owner) =>
      (allPathsStmt.all(owner, owner) as { path?: string }[]).map((row) => String(row.path)),
    allHashes: (owner) => allHashesStmt.all(owner) as { path: string; hashes: string }[],
    listOwners: () => ownerListStmt.all() as { owner: string; updated_at: number }[],
    deleteOwnerRows: (owner) => {
      deleteOwnerStmt.run(owner);
      deleteOwnerServedStmt.run(owner);
    },
  };
}

function isHealthy(db: DatabaseSync): boolean {
  try {
    const row = db.prepare("PRAGMA quick_check").get() as { quick_check?: string } | undefined;
    return row?.quick_check === "ok";
  } catch (error) {
    if (isCorruptionError(error)) return false;
    return true;
  }
}

function quarantineStoreSync(storePath: string, label: "corrupt" | "old-schema"): void {
  const suffix = `.${label}-${Date.now()}`;
  try {
    renameSync(storePath, `${storePath}${suffix}`);
  } catch (error) {
    if (errCode(error) === "ENOENT") return;
    throw new Error(`Failed to quarantine ${label} hash store ${storePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  for (const candidate of [`${storePath}-wal`, `${storePath}-shm`]) {
    try {
      renameSync(candidate, `${candidate}${suffix}`);
    } catch (error) {
      if (errCode(error) !== "ENOENT") {
        console.error(`Failed to quarantine ${label} hash store sidecar:`, error);
      }
    }
  }
}

function schemaLockPath(storePath: string): string {
  return join(dirname(storePath), "locks", `store-${basename(storePath)}.schema.lock`);
}

function shutdownDb(db: DatabaseSync): void {
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch {
  }
  db.close();
}

async function openStoreUnlocked(storePath: string): Promise<OpenStore> {
  await initHasher();
  return openStoreUnlockedCore(storePath);
}

/** Synchronous SQLite open core entered after the async hasher/lock setup. */
function openStoreUnlockedCore(storePath: string): OpenStore {
  mkdirSync(dirname(storePath), { recursive: true });

  let opened: OpenedDb;
  try {
    opened = openDbWithBusyRetry(storePath);
  } catch (error) {
    if (!isCorruptionError(error)) throw error;
    console.error("Hash store failed to open, rebuilding:", error);
    quarantineStoreSync(storePath, "corrupt");
    opened = openDbWithBusyRetry(storePath);
  }
  if (opened.legacy) {
    // Old-schema policy (continuing #187's quarantine-and-rebuild): any
    // incompatible non-empty layout — undo-bearing stores, the former
    // ownerless current-version shape, and every earlier version — is
    // quarantined whole, database and sidecars, and rebuilt fresh. Cached
    // snapshot and served state do not survive the upgrade; the loss is
    // explicit and recoverable through a new read, which re-records both.
    shutdownDb(opened.db);
    quarantineStoreSync(storePath, "old-schema");
    opened = openDbWithBusyRetry(storePath);
  }
  if (opened.legacy) throw new Error(`Fresh anchor store ${storePath} reopened as an old schema`);
  if (!isHealthy(opened.db)) {
    shutdownDb(opened.db);
    quarantineStoreSync(storePath, "corrupt");
    opened = openDbWithBusyRetry(storePath);
  }
  if (opened.legacy) throw new Error(`Rebuilt anchor store ${storePath} reopened as an old schema`);

  const entry: OpenStore = {
    key: storePath,
    path: storePath,
    db: opened.db,
    stmts: buildStatements(opened.db),
    refs: 0,
    lastUsed: ++openTick,
    closeWhenIdle: false,
    snapshots: new Map(),
  };
  openStores.set(entry.key, entry);
  // Quarantine replaced the physical database as one unit: any prior cache
  // entry for this path is gone with its connection and its snapshots.
  maybeEvict();

  registerExitHandler();
  return entry;
}

async function openStore(storePath: string): Promise<OpenStore> {
  // Schema detection, whole-database quarantine, and fresh rebuild mutate one
  // path across every owner partition. Serialize that lifecycle across owners
  // and Pi processes so two concurrent first opens cannot quarantine each
  // other's newly rebuilt database and leave handles attached to different
  // inodes. Cached opens bypass this path and pay no lock cost.
  const lock = await acquireFileLock(schemaLockPath(storePath), {
    waitMs: Math.max(HASH_STORE_BUSY_TIMEOUT * 5, 5000),
  });
  if (!lock) throw new Error(`[E_FILE_LOCKED] Timed out waiting to open anchor store ${storePath}. Retry the operation.`);
  try {
    return await openStoreUnlocked(storePath);
  } finally {
    await lock.release();
  }
}

function registerExitHandler(): void {
  if (exitHandlerRegistered) return;
  exitHandlerRegistered = true;
  process.once("exit", () => shutdownHashStore());
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.once(sig, () => {
      shutdownHashStore();
      process.kill(process.pid, sig);
    });
  }
}

/**
 * Opens (or reuses) the physical anchor store at `storePath` and returns a
 * typed view bound to the required `owner`. One ref-counted connection is
 * cached per store path; owners share it and never see each other's
 * snapshots or served rows.
 */
export function loadHashStoreAt(storePath: string, owner: string): Promise<HashStoreHandle> {
  if (typeof owner !== "string" || owner.length === 0) {
    throw new Error("An anchor store requires a non-empty owner identity.");
  }
  const cached = openStores.get(storePath);
  if (cached && cached.db.isOpen) {
    return Promise.resolve(acquireView(cached, owner));
  }
  let pending = openingStores.get(storePath);
  if (!pending) {
    const openedInGeneration = shutdownGeneration;
    pending = openStore(storePath)
      .then((entry) => {
        if (openedInGeneration !== shutdownGeneration) entry.closeWhenIdle = true;
        return entry;
      });
    openingStores.set(storePath, pending);
  }
  const opening = pending;
  return opening.then(
    async (entry) => {
      try {
        await loadBarrier.beforeAcquire?.(storePath);
        return acquireView(entry, owner);
      } finally {
        // Keep the opener visible to shutdown/eviction until at least one
        // caller owns a reference. The callback is synchronous after the
        // optional test barrier, so no production handoff gap remains.
        if (openingStores.get(storePath) === opening) openingStores.delete(storePath);
        closeMarkedIdle(entry);
      }
    },
    (error: unknown) => {
      if (openingStores.get(storePath) === opening) openingStores.delete(storePath);
      throw error;
    },
  );
}

export function shutdownHashStore(): void {
  shutdownGeneration += 1;
  for (const entry of openStores.values()) {
    if (entry.refs > 0 || openingStores.has(entry.key)) {
      entry.closeWhenIdle = true;
      continue;
    }
    openStores.delete(entry.key);
    entry.snapshots.clear();
    shutdownDb(entry.db);
  }
}

/** Number of distinct physical store files currently held open. */
export function openStoreCount(): number {
  return openStores.size;
}

const STAT_BATCH = 64;
const PRUNE_DIAGNOSTIC_LIMIT = 8;

function isMissingPathError(error: unknown): boolean {
  const code = errCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

type PathClassification =
  | { kind: "present" }
  | { kind: "missing"; path: string }
  | { kind: "failure"; path: string; error: unknown };

async function classifyPaths(rows: { path: string }[]): Promise<{
  missing: string[];
  failures: { path: string; error: unknown }[];
}> {
  const missing: string[] = [];
  const failures: { path: string; error: unknown }[] = [];
  for (let i = 0; i < rows.length; i += STAT_BATCH) {
    const batch = rows.slice(i, i + STAT_BATCH);
    const results = await Promise.all(
      batch.map(async (row): Promise<PathClassification> => {
        try {
          await stat(row.path);
          return { kind: "present" };
        } catch (error) {
          // Only a genuine missing-path error proves the file disappeared.
          // Permission, descriptor-exhaustion, and other stat failures are
          // operational problems, not deletions: the rows survive and the
          // failure is surfaced as a bounded diagnostic.
          if (isMissingPathError(error)) return { kind: "missing", path: row.path };
          return { kind: "failure", path: row.path, error };
        }
      }),
    );
    for (const result of results) {
      if (result.kind === "missing") missing.push(result.path);
      else if (result.kind === "failure") failures.push({ path: result.path, error: result.error });
    }
  }
  return { missing, failures };
}

/**
 * Prunes this view's owner's records for files that no longer exist. The
 * compound delete is one repository transaction, so a failure rolls the whole
 * pruning back and leaves cache and database consistent. Stat failures that
 * are not genuine missing-path errors preserve their rows and surface a
 * bounded diagnostic.
 */
export async function pruneMissing(store: HashStoreHandle): Promise<void> {
  const rows = store.allPaths().map((path) => ({ path }));
  const { missing, failures } = await classifyPaths(rows);
  for (const failure of failures.slice(0, PRUNE_DIAGNOSTIC_LIMIT)) {
    const message = failure.error instanceof Error ? failure.error.message : String(failure.error);
    console.error(`Anchored store path check failed for ${failure.path}: ${message}`);
  }
  if (missing.length === 0) return;
  store.withTransaction(() => {
    for (const path of missing) {
      store.deleteSnapshot(path);
      store.clearServed(path);
    }
  });
}

/** @internal Test seams: the view class for prototype spies and the store
 * entry behind a view for statement-level observation. */
export const __testables = {
  HashStoreHandleImpl,
  storeEntryOf: (view: HashStoreHandle): OpenStore => (view as HashStoreHandleImpl).entry,
  loadBarrier,
};
