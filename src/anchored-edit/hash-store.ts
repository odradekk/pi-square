import { existsSync } from "fs";
import { dirname } from "path";
import { readFile, rename, mkdir, stat } from "fs/promises";
import { DatabaseSync } from "node:sqlite";
import { hashStorePath, legacyHashStorePath } from "./paths";
import { errCode, isRec, splitLines } from "./utils";
import { initHasher, contentChecksum } from "./hashline/hasher";
import { HASH_RE } from "./hashline/alphabet";
import { HASH_STORE_VERSION, HASH_STORE_BUSY_TIMEOUT } from "./constants";
type SqlParams = (string | number)[];

interface Prepared {
  get: (...params: SqlParams) => Record<string, unknown> | undefined;
  allPaths: (...params: SqlParams) => Record<string, unknown>[];
  allHashes: (...params: SqlParams) => Record<string, unknown>[];
  deleteOne: (...params: SqlParams) => void;
  upsert: (...params: SqlParams) => void;
  undoUpsert: (...params: SqlParams) => void;
  undoGet: (...params: SqlParams) => Record<string, unknown> | undefined;
  undoDelete: (...params: SqlParams) => void;
  servedGet: (...params: SqlParams) => Record<string, unknown> | undefined;
  servedUpsert: (...params: SqlParams) => void;
  servedDelete: (...params: SqlParams) => void;
}

export interface HashStore {
  readonly stmts: Prepared;
  readonly engine: "node:sqlite";
  readonly owner: string | undefined;
}

export interface HashStoreHandle extends HashStore {
  /** Releases this store acquisition so the underlying database can be evicted when idle. Safe to call once; later calls are no-ops. */
  release(): void;
}

export interface HashStoreLoadOptions {
  owner?: string;
  migrateLegacy?: boolean;
}

export interface UndoRecord {
  content: string;
  bom: string;
  ending: string;
  hashes: string[];
  resultContent: string;
}

interface LegacySnapshot {
  content: string;
  hashes: string[];
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

function isValidSnapshot(value: unknown): value is LegacySnapshot {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.content !== "string") return false;
  return isValidHashList(v.hashes);
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

function openDbWithBusyRetry(storePath: string, owner: string | undefined): { db: DatabaseSync; stmts: Prepared } {
  return withBusyRetry(() => openDb(storePath, owner));
}

let exitHandlerRegistered = false;
interface SnapshotCacheEntry {
  checksum: string;
  lineCount: number;
  hashes: string[];
}
const snapshotCache = new Map<string, SnapshotCacheEntry>();
export const SNAPSHOT_CACHE_LIMIT = 256;

interface OpenStore {
  key: string;
  path: string;
  owner: string | undefined;
  db: DatabaseSync;
  stmts: Prepared;
  refs: number;
  lastUsed: number;
}

/**
 * Bound on how many databases the module holds open at once across distinct
 * (store file, owner) pairs. When the cache exceeds this bound, the
 * least-recently-used database with no in-flight caller is closed. A database
 * that an in-flight caller still holds (refs > 0) is never closed, so the
 * bound is a soft cap under concurrent load.
 */
export const OPEN_STORE_LIMIT = 4;

const openStores = new Map<string, OpenStore>();
const openingStores = new Map<string, Promise<OpenStore>>();
let openTick = 0;

function storeKey(path: string, owner: string | undefined): string {
  return `${path}\u0000${owner ?? ""}`;
}

function acquireStore(entry: OpenStore): HashStoreHandle {
  entry.refs += 1;
  entry.lastUsed = ++openTick;
  return new HashStoreHandleImpl(entry);
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
    shutdownDb(idleLru.db);
  }
}

class HashStoreHandleImpl implements HashStoreHandle {
  readonly engine = "node:sqlite" as const;
  readonly owner: string | undefined;
  readonly stmts: Prepared;
  private readonly entry: OpenStore;
  private released = false;

  constructor(entry: OpenStore) {
    this.entry = entry;
    this.owner = entry.owner;
    this.stmts = entry.stmts;
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    this.entry.refs -= 1;
    maybeEvict();
  }

  /** @internal Runs a mutation inside a transaction on this store's database. */
  withTransaction(fn: () => void): void {
    if (!this.entry.db.isOpen) {
      throw new Error("Hash store is not open; transactional update aborted");
    }
    withBusyRetry(() => {
      this.entry.db.exec("BEGIN IMMEDIATE");
      try {
        fn();
        this.entry.db.exec("COMMIT");
      } catch (e) {
        try { this.entry.db.exec("ROLLBACK"); } catch {}
        throw e;
      }
    });
  }
}
function openDb(storePath: string, owner: string | undefined): { db: DatabaseSync; stmts: Prepared } {
  const db = new DatabaseSync(storePath, {
    timeout: HASH_STORE_BUSY_TIMEOUT,
  });
  try {
    return buildStore(db, owner);
  } catch (error) {
    try {
      db.close();
    } catch {}
    throw error;
  }
}

function buildStore(
  db: DatabaseSync,
  owner: string | undefined,
): { db: DatabaseSync; stmts: Prepared } {
  const scoped = owner !== undefined;
  const ownerColumn = scoped ? "owner TEXT NOT NULL, " : "";
  const pathColumn = scoped ? "path TEXT NOT NULL, " : "path TEXT PRIMARY KEY, ";
  const primaryKey = scoped ? ", PRIMARY KEY(owner, path)" : "";
  const ownerWhere = scoped ? "owner = ? AND " : "";
  const ownerValues = scoped ? "?, " : "";
  const ownerColumns = scoped ? "owner, " : "";
  const withOwner = (params: SqlParams): SqlParams => scoped ? [owner!, ...params] : params;
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec(
    "CREATE TABLE IF NOT EXISTS snapshots (" +
      ownerColumn +
      pathColumn +
      "checksum TEXT NOT NULL, " +
      "line_count INTEGER NOT NULL, " +
      "hashes TEXT NOT NULL, " +
      "updated_at INTEGER NOT NULL" +
      primaryKey +
    ")"
  );
  db.exec(
    "CREATE TABLE IF NOT EXISTS meta (" +
      "key TEXT PRIMARY KEY, " +
      "value TEXT NOT NULL" +
    ")"
  );
  db.exec(
    "CREATE TABLE IF NOT EXISTS undo (" +
      ownerColumn +
      pathColumn +
      "content TEXT NOT NULL, " +
      "bom TEXT NOT NULL, " +
      "ending TEXT NOT NULL, " +
      "hashes TEXT NOT NULL, " +
      "result_content TEXT NOT NULL, " +
      "updated_at INTEGER NOT NULL" +
      primaryKey +
    ")"
  );
  db.exec(
    "CREATE TABLE IF NOT EXISTS served (" +
      ownerColumn +
      pathColumn +
      "hashes TEXT NOT NULL, " +
      "updated_at INTEGER NOT NULL" +
      primaryKey +
    ")"
  );
  const versionRow = db.prepare("SELECT value FROM meta WHERE key = 'version'").get() as { value?: string } | undefined;
  if (versionRow && versionRow.value !== String(HASH_STORE_VERSION)) {
    if (scoped) {
      db.prepare("DELETE FROM snapshots WHERE owner = ?").run(owner!);
      db.prepare("DELETE FROM undo WHERE owner = ?").run(owner!);
    } else {
      db.exec("DELETE FROM snapshots");
      db.exec("DELETE FROM undo");
    }
  }
  db.prepare(
    "INSERT INTO meta (key, value) VALUES ('version', ?) " +
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(String(HASH_STORE_VERSION));
  const conflictTarget = scoped ? "owner, path" : "path";
  const getStmt = db.prepare(
    `SELECT hashes FROM snapshots WHERE ${ownerWhere}path = ? AND checksum = ? AND line_count = ?`
  );
  const allStmt = db.prepare(scoped
    ? "SELECT path FROM snapshots WHERE owner = ? UNION SELECT path FROM undo WHERE owner = ? UNION SELECT path FROM served WHERE owner = ?"
    : "SELECT path FROM snapshots UNION SELECT path FROM undo UNION SELECT path FROM served");
  const allHashesStmt = db.prepare(`SELECT path, hashes FROM snapshots${scoped ? " WHERE owner = ?" : ""}`);
  const delStmt = db.prepare(`DELETE FROM snapshots WHERE ${ownerWhere}path = ?`);
  const upsertStmt = db.prepare(
    `INSERT INTO snapshots (${ownerColumns}path, checksum, line_count, hashes, updated_at) VALUES (${ownerValues}?, ?, ?, ?, ?) ` +
    `ON CONFLICT(${conflictTarget}) DO UPDATE SET checksum = excluded.checksum, line_count = excluded.line_count, hashes = excluded.hashes, updated_at = excluded.updated_at`
  );
  const undoUpsertStmt = db.prepare(
    `INSERT INTO undo (${ownerColumns}path, content, bom, ending, hashes, result_content, updated_at) VALUES (${ownerValues}?, ?, ?, ?, ?, ?, ?) ` +
    `ON CONFLICT(${conflictTarget}) DO UPDATE SET content = excluded.content, bom = excluded.bom, ending = excluded.ending, hashes = excluded.hashes, result_content = excluded.result_content, updated_at = excluded.updated_at`
  );
  const undoGetStmt = db.prepare(
    `SELECT content, bom, ending, hashes, result_content FROM undo WHERE ${ownerWhere}path = ?`
  );
  const undoDelStmt = db.prepare(`DELETE FROM undo WHERE ${ownerWhere}path = ?`);
  const servedGetStmt = db.prepare(`SELECT hashes FROM served WHERE ${ownerWhere}path = ?`);
  const servedUpsertStmt = db.prepare(
    `INSERT INTO served (${ownerColumns}path, hashes, updated_at) VALUES (${ownerValues}?, ?, ?) ` +
    `ON CONFLICT(${conflictTarget}) DO UPDATE SET hashes = excluded.hashes, updated_at = excluded.updated_at`
  );
  const servedDelStmt = db.prepare(`DELETE FROM served WHERE ${ownerWhere}path = ?`);
  const stmts: Prepared = {
    get: (...params) => getStmt.get(...withOwner(params)) as Record<string, unknown> | undefined,
    allPaths: (...params) => allStmt.all(...(scoped ? [owner!, owner!, owner!, ...params] : params)) as Record<string, unknown>[],
    allHashes: (...params) => allHashesStmt.all(...withOwner(params)) as Record<string, unknown>[],
    deleteOne: (...params) => { withBusyRetry(() => { delStmt.run(...withOwner(params)); }); },
    upsert: (...params) => { withBusyRetry(() => { upsertStmt.run(...withOwner(params)); }); },
    undoUpsert: (...params) => { withBusyRetry(() => { undoUpsertStmt.run(...withOwner(params)); }); },
    undoGet: (...params) => undoGetStmt.get(...withOwner(params)) as Record<string, unknown> | undefined,
    undoDelete: (...params) => { withBusyRetry(() => { undoDelStmt.run(...withOwner(params)); }); },
    servedGet: (...params) => servedGetStmt.get(...withOwner(params)) as Record<string, unknown> | undefined,
    servedUpsert: (...params) => { withBusyRetry(() => { servedUpsertStmt.run(...withOwner(params)); }); },
    servedDelete: (...params) => { withBusyRetry(() => { servedDelStmt.run(...withOwner(params)); }); },
  };
  return { db, stmts };
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

async function quarantineStore(storePath: string): Promise<void> {
  const suffix = `.corrupt-${Date.now()}`;
  for (const candidate of [storePath, `${storePath}-wal`, `${storePath}-shm`]) {
    try {
      await rename(candidate, `${candidate}${suffix}`);
    } catch (error) {
      if (errCode(error) !== "ENOENT") {
        console.error("Failed to quarantine corrupt hash store file:", error);
      }
    }
  }
}

function shutdownDb(db: DatabaseSync): void {
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch {
  }
  db.close();
}

async function openStore(storePath: string, options: HashStoreLoadOptions): Promise<OpenStore> {
  const owner = options.owner;
  await initHasher();
  await mkdir(dirname(storePath), { recursive: true });

  let existed = existsSync(storePath);
  let opened: { db: DatabaseSync; stmts: Prepared };
  try {
    opened = openDbWithBusyRetry(storePath, owner);
  } catch (error) {
    if (!isCorruptionError(error)) throw error;
    console.error("Hash store failed to open, rebuilding:", error);
    await quarantineStore(storePath);
    existed = false;
    opened = openDbWithBusyRetry(storePath, owner);
  }
  if (!isHealthy(opened.db)) {
    shutdownDb(opened.db);
    await quarantineStore(storePath);
    existed = false;
    opened = openDbWithBusyRetry(storePath, owner);
  }
  const { db, stmts } = opened;

  if (!existed && options.migrateLegacy !== false) {
    try {
      await migrateLegacy(db);
    } catch (error) {
      console.error("Hash store migration failed; continuing without legacy import:", error);
    }
  }

  const entry: OpenStore = {
    key: storeKey(storePath, owner),
    path: storePath,
    owner,
    db,
    stmts,
    refs: 0,
    lastUsed: ++openTick,
  };
  openStores.set(entry.key, entry);
  maybeEvict();

  registerExitHandler();
  return entry;
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

export function loadHashStoreAt(
  storePath: string,
  options: HashStoreLoadOptions = {},
): Promise<HashStoreHandle> {
  const owner = options.owner;
  const key = storeKey(storePath, owner);
  const cached = openStores.get(key);
  if (cached && cached.db.isOpen) {
    return Promise.resolve(acquireStore(cached));
  }
  let pending = openingStores.get(key);
  if (!pending) {
    pending = openStore(storePath, options).finally(() => {
      openingStores.delete(key);
    });
    openingStores.set(key, pending);
  }
  return pending.then(acquireStore);
}

export function loadHashStore(): Promise<HashStoreHandle> {
  return loadHashStoreAt(hashStorePath());
}

export function shutdownHashStore(): void {
  for (const entry of openStores.values()) {
    shutdownDb(entry.db);
  }
  openStores.clear();
  openingStores.clear();
  snapshotCache.clear();
}

/** Number of databases currently held open across distinct (store file, owner) pairs. */
export function openStoreCount(): number {
  return openStores.size;
}

async function migrateLegacy(db: DatabaseSync): Promise<void> {
  const legacyPath = legacyHashStorePath();
  let content: string;
  try {
    content = await readFile(legacyPath, "utf-8");
  } catch (error: unknown) {
    if (errCode(error) === "ENOENT") return;
    console.error("Failed to read legacy hash store for migration:", error);
    return;
  }

  let parsed: { snapshots?: Record<string, unknown> };
  try {
    parsed = JSON.parse(content) as typeof parsed;
  } catch (error) {
    console.error("Failed to parse legacy hash store, skipping migration:", error);
    return;
  }

  const raw = parsed.snapshots;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;

  const rows: [string, string, number, string, number][] = [];
  for (const [key, value] of Object.entries(raw)) {
    if (
      isRec(value) &&
      Array.isArray(value.hashes) &&
      new Set(value.hashes).size !== value.hashes.length
    ) {
      console.warn(
        `Skipped legacy snapshot with duplicate hashes for ${key}; it will be re-hashed on next read.`,
      );
      continue;
    }
    if (!isValidSnapshot(value)) continue;
    rows.push([
      key,
      contentChecksum(value.content),
      splitLines(value.content).length,
      JSON.stringify(value.hashes),
      Date.now(),
    ]);
  }
  if (rows.length > 0) {
    withBusyRetry(() => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const stmt = db.prepare(
          "INSERT OR REPLACE INTO snapshots (path, checksum, line_count, hashes, updated_at) VALUES (?, ?, ?, ?, ?)"
        );
        for (const row of rows) stmt.run(...row);
        db.exec("COMMIT");
      } catch (e) {
        try { db.exec("ROLLBACK"); } catch {}
        throw e;
      }
    });
  }

  try {
    await rename(legacyPath, `${legacyPath}.bak`);
  } catch (error) {
    console.error("Failed to rename legacy hash store after migration:", error);
  }
}

function cacheSnapshot(path: string, checksum: string, lineCount: number, hashes: string[]): void {
  snapshotCache.delete(path);
  snapshotCache.set(path, { checksum, lineCount, hashes: hashes.slice() });
  if (snapshotCache.size > SNAPSHOT_CACHE_LIMIT) {
    const oldest = snapshotCache.keys().next().value;
    if (oldest !== undefined) snapshotCache.delete(oldest);
  }
}

export function getSnapshot(
  store: HashStore,
  path: string,
  content: string,
  deleteCorrupt = true,
): string[] | undefined {
  const checksum = contentChecksum(content);
  const lineCount = splitLines(content).length;
  const cached = snapshotCache.get(path);
  if (cached && cached.checksum === checksum && cached.lineCount === lineCount) {
    snapshotCache.delete(path);
    snapshotCache.set(path, cached);
    return cached.hashes.slice();
  }
  const row = store.stmts.get(path, checksum, lineCount);
  if (!row) return undefined;
  const parsed = parseHashList(row.hashes as string, () => {
    if (deleteCorrupt) store.stmts.deleteOne(path);
    snapshotCache.delete(path);
  });
  if (!parsed) return undefined;
  cacheSnapshot(path, checksum, lineCount, parsed);
  return parsed;
}

export function upsertSnapshot(
  store: HashStore,
  path: string,
  checksum: string,
  lineCount: number,
  hashes: string[],
): void {
  store.stmts.upsert(path, checksum, lineCount, JSON.stringify(hashes), Date.now());
  cacheSnapshot(path, checksum, lineCount, hashes);
}

export function upsertUndo(store: HashStore, path: string, entry: UndoRecord): void {
  store.stmts.undoUpsert(
    path,
    entry.content,
    entry.bom,
    entry.ending,
    JSON.stringify(entry.hashes),
    entry.resultContent,
    Date.now(),
  );
}

export function getUndoEntry(store: HashStore, path: string): UndoRecord | undefined {
  const row = store.stmts.undoGet(path);
  if (!row) return undefined;
  const parsed = parseHashList(row.hashes as string, () => store.stmts.undoDelete(path));
  if (!parsed) return undefined;
  return {
    content: row.content as string,
    bom: row.bom as string,
    ending: row.ending as string,
    hashes: parsed,
    resultContent: row.result_content as string,
  };
}

export function deleteUndo(store: HashStore, path: string): void {
  store.stmts.undoDelete(path);
}

const STAT_BATCH = 64;

async function statMissing(rows: { path: string }[]): Promise<string[]> {
  const missing: string[] = [];
  for (let i = 0; i < rows.length; i += STAT_BATCH) {
    const batch = rows.slice(i, i + STAT_BATCH);
    const results = await Promise.all(
      batch.map(async (row) => {
        try {
          await stat(row.path);
          return undefined;
        } catch {
          return row.path;
        }
      }),
    );
    for (const path of results) {
      if (path !== undefined) missing.push(path);
    }
  }
  return missing;
}

export async function pruneMissing(store: HashStoreHandle): Promise<void> {
  const rows = store.stmts.allPaths() as { path: string }[];
  const missing = await statMissing(rows);
  if (missing.length === 0) return;
  (store as HashStoreHandleImpl).withTransaction(() => {
    for (const path of missing) {
      store.stmts.deleteOne(path);
      snapshotCache.delete(path);
      store.stmts.undoDelete(path);
      store.stmts.servedDelete(path);
    }
  });
}

export function findSnapshotPaths(store: HashStore, hashes: string[]): string[] {
  const rows = store.stmts.allHashes() as { path: string; hashes: string }[];
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
