import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve as resolvePath } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { subagentsStateRoot } from "./agent-paths";
import { createSubagentError, normalizeSubagentError, SubagentError } from "./errors";
import type { SubagentRunDetails } from "./types";

const PUBLIC_ID_PATTERN = /^subagent_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TRANSIENT_FS_CODES = new Set(["EAGAIN", "EBUSY", "EMFILE", "ENFILE", "ETIMEDOUT"]);
const FS_RETRY_DELAYS_MS = [100, 200, 400] as const;
const PARENT_INDEX_VERSION = 1 as const;

interface ParentSessionRunIndex {
  version: typeof PARENT_INDEX_VERSION;
  parentSessionId: string;
  runIds: string[];
  updatedAt: number;
}

function sleepSync(ms: number): void {
  const view = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(view, 0, 0, ms);
}

function withTransientFsRetries<T>(operation: () => T): T {
  let retries = 0;
  for (;;) {
    try {
      return operation();
    } catch (error: any) {
      if (!TRANSIENT_FS_CODES.has(String(error?.code ?? "")) || retries >= FS_RETRY_DELAYS_MS.length) {
        if (error && typeof error === "object") error.retryCount = retries;
        throw error;
      }
      sleepSync(FS_RETRY_DELAYS_MS[retries]);
      retries += 1;
    }
  }
}

function fsRetryCount(error: unknown): number {
  return Math.max(0, Number((error as any)?.retryCount ?? 0) || 0);
}

export function createSubagentId(): string {
  return `subagent_${randomUUID()}`;
}

export function isValidSubagentId(id: string): boolean {
  return PUBLIC_ID_PATTERN.test(id);
}

export function assertValidSubagentId(id: string, operation = "resume"): void {
  if (isValidSubagentId(id)) return;
  throw createSubagentError({
    code: "SUBAGENT_NOT_FOUND",
    message: `Unknown subagent ID '${id}'.`,
    operation,
    retryable: false,
    suggestedAction: "Use an ID returned by delegate or resume in the current version.",
  });
}

export function artifactsDirFor(id: string): string {
  assertValidSubagentId(id, "persistence");
  return resolvePath(subagentsStateRoot(), id);
}

export function ensureArtifactsDir(id: string): string {
  const dir = artifactsDirFor(id);
  try {
    withTransientFsRetries(() => mkdirSync(dir, { recursive: true }));
    return dir;
  } catch (error) {
    throw normalizeSubagentError(error, {
      code: "PERSISTENCE_FAILED",
      message: "Unable to create the subagent artifacts directory.",
      operation: "persistence",
      id,
      retries: fsRetryCount(error),
    });
  }
}

function validateRunStateShape(value: unknown, expectedId?: string): SubagentRunDetails {
  const details = value as SubagentRunDetails;
  if (!details || typeof details !== "object" || details.version !== 3) {
    throw new Error("run.json has an unsupported format version");
  }
  if (!isValidSubagentId(details.id) || (expectedId && details.id !== expectedId)) {
    throw new Error("run.json subagent ID does not match its artifacts directory");
  }
  if (!["running", "cancelling", "done", "error", "aborted"].includes(details.phase)) {
    throw new Error("run.json has an invalid phase");
  }
  if (!["fg", "bg", "resume"].includes(details.mode)) {
    throw new Error("run.json has an invalid mode");
  }
  if (typeof details.sessionFile !== "string" || typeof details.sessionId !== "string") {
    throw new Error("run.json does not identify a native session");
  }
  if (typeof details.originParentSessionId !== "string" || typeof details.lastParentSessionId !== "string") {
    throw new Error("run.json does not identify its parent session");
  }
  if (details.promptSnapshot?.version !== 2 || typeof details.promptSnapshot.system !== "string") {
    throw new Error("run.json has no V2 prompt snapshot");
  }
  if (details.promptSnapshot.manifest?.contractVersion !== 2 || typeof details.promptSnapshot.manifest.effectiveSystemHash !== "string") {
    throw new Error("run.json has an invalid prompt manifest");
  }
  if (typeof details.artifactsDir !== "string" || typeof details.task !== "string" || typeof details.cwd !== "string") {
    throw new Error("run.json is missing required fields");
  }
  if (!Array.isArray(details.timeline) || !Array.isArray(details.toolErrors) || typeof details.retries !== "number") {
    throw new Error("run.json has invalid execution details");
  }
  return details;
}

export function writeRunState(artifactsDir: string, details: SubagentRunDetails): void {
  try {
    validateRunStateShape(details, details.id);
    withTransientFsRetries(() => mkdirSync(artifactsDir, { recursive: true }));
    const tmp = resolvePath(artifactsDir, "run.json.tmp");
    const final = resolvePath(artifactsDir, "run.json");
    withTransientFsRetries(() => writeFileSync(tmp, JSON.stringify(details, null, 2), "utf8"));
    withTransientFsRetries(() => renameSync(tmp, final));
  } catch (error) {
    if (error instanceof SubagentError) throw error;
    throw normalizeSubagentError(error, {
      code: "PERSISTENCE_FAILED",
      message: "Unable to persist subagent run state.",
      operation: "persistence",
      id: details.id,
      retries: fsRetryCount(error),
    });
  }
}

export function readRunState(artifactsDir: string): SubagentRunDetails {
  const file = resolvePath(artifactsDir, "run.json");
  const expectedId = basename(artifactsDir);
  const raw = withTransientFsRetries(() => readFileSync(file, "utf8"));
  return validateRunStateShape(JSON.parse(raw), expectedId);
}

export function tryReadRunState(artifactsDir: string): SubagentRunDetails | undefined {
  try {
    return readRunState(artifactsDir);
  } catch {
    return undefined;
  }
}

function parentIndexPath(parentSessionId: string): string {
  const normalized = parentSessionId.trim();
  if (!normalized) throw new Error("parent session ID is empty");
  const digest = createHash("sha256").update(normalized, "utf8").digest("hex");
  return resolvePath(subagentsStateRoot(), "sessions", `${digest}.json`);
}

function readParentIndex(parentSessionId: string): ParentSessionRunIndex {
  const path = parentIndexPath(parentSessionId);
  const raw = withTransientFsRetries(() => readFileSync(path, "utf8"));
  const value = JSON.parse(raw) as ParentSessionRunIndex;
  if (value?.version !== PARENT_INDEX_VERSION || value.parentSessionId !== parentSessionId || !Array.isArray(value.runIds)) {
    throw new Error("parent session index has an unsupported format");
  }
  return {
    ...value,
    runIds: value.runIds.filter((id, index, all) => isValidSubagentId(id) && all.indexOf(id) === index),
  };
}

export function recordParentSessionRun(parentSessionId: string, id: string): void {
  assertValidSubagentId(id, "persistence");
  try {
    const path = parentIndexPath(parentSessionId);
    let current: ParentSessionRunIndex = {
      version: PARENT_INDEX_VERSION,
      parentSessionId,
      runIds: [],
      updatedAt: Date.now(),
    };
    if (existsSync(path)) current = readParentIndex(parentSessionId);
    current.runIds = [id, ...current.runIds.filter((candidate) => candidate !== id)];
    current.updatedAt = Date.now();
    withTransientFsRetries(() => mkdirSync(dirname(path), { recursive: true }));
    const tmp = `${path}.tmp`;
    withTransientFsRetries(() => writeFileSync(tmp, `${JSON.stringify(current, null, 2)}\n`, "utf8"));
    withTransientFsRetries(() => renameSync(tmp, path));
  } catch (error) {
    throw normalizeSubagentError(error, {
      code: "PERSISTENCE_FAILED",
      message: "Unable to update the parent-session subagent index.",
      operation: "persistence",
      id,
      retries: fsRetryCount(error),
    });
  }
}

export function listParentSessionRuns(parentSessionId: string): SubagentRunDetails[] {
  let index: ParentSessionRunIndex;
  try {
    index = readParentIndex(parentSessionId);
  } catch {
    return [];
  }
  return index.runIds
    .map((id) => tryReadRunState(artifactsDirFor(id)))
    .filter((details): details is SubagentRunDetails => Boolean(details))
    .filter((details) => details.originParentSessionId === parentSessionId || details.lastParentSessionId === parentSessionId)
    .sort((a, b) => b.startedAt - a.startedAt);
}

export function deleteParentSessionRun(parentSessionId: string, id: string): void {
  assertValidSubagentId(id, "persistence");
  const details = tryReadRunState(artifactsDirFor(id));
  if (!details || (details.originParentSessionId !== parentSessionId && details.lastParentSessionId !== parentSessionId)) {
    throw createSubagentError({
      code: "SUBAGENT_NOT_FOUND",
      message: `Subagent '${id}' does not belong to the current parent session.`,
      operation: "delete",
      id,
      retryable: false,
    });
  }
  try {
    withTransientFsRetries(() => rmSync(artifactsDirFor(id), { recursive: true, force: true }));
    const path = parentIndexPath(parentSessionId);
    if (!existsSync(path)) return;
    const index = readParentIndex(parentSessionId);
    index.runIds = index.runIds.filter((candidate) => candidate !== id);
    index.updatedAt = Date.now();
    const tmp = `${path}.tmp`;
    withTransientFsRetries(() => writeFileSync(tmp, `${JSON.stringify(index, null, 2)}\n`, "utf8"));
    withTransientFsRetries(() => renameSync(tmp, path));
  } catch (error) {
    throw normalizeSubagentError(error, {
      code: "PERSISTENCE_FAILED",
      message: "Unable to delete subagent history.",
      operation: "delete",
      id,
      retries: fsRetryCount(error),
    });
  }
}

export function initializeSessionFile(input: {
  id: string;
  artifactsDir: string;
  sessionFile: string;
  header: unknown;
}): void {
  const header = input.header as { type?: string; id?: string };
  if (header?.type !== "session" || typeof header.id !== "string") {
    throw createSubagentError({
      code: "PERSISTENCE_FAILED",
      message: "Pi did not provide a valid native session header.",
      operation: "persistence",
      id: input.id,
      retryable: false,
    });
  }

  const expectedParent = resolvePath(input.artifactsDir);
  const candidate = resolvePath(input.sessionFile);
  if (dirname(candidate) !== expectedParent) {
    throw createSubagentError({
      code: "PERSISTENCE_FAILED",
      message: "The native session file is outside the subagent artifacts directory.",
      operation: "persistence",
      id: input.id,
      retryable: false,
    });
  }

  if (existsSync(candidate)) {
    try {
      const existing = withTransientFsRetries(() => readFileSync(candidate, "utf8"));
      if (!existing.trim()) {
        withTransientFsRetries(() => writeFileSync(candidate, `${JSON.stringify(header)}\n`, "utf8"));
        return;
      }
      const existingHeader = JSON.parse(existing.split(/\r?\n/, 1)[0]);
      if (existingHeader?.type === "session" && existingHeader.id === header.id) return;
      throw new Error("existing native session header does not match the new session");
    } catch (error) {
      throw normalizeSubagentError(error, {
        code: "PERSISTENCE_FAILED",
        message: "Unable to validate the initialized native session file.",
        operation: "persistence",
        id: input.id,
        retries: fsRetryCount(error),
      });
    }
  }
  try {
    withTransientFsRetries(() => writeFileSync(candidate, `${JSON.stringify(header)}\n`, { encoding: "utf8", flag: "wx" }));
  } catch (error: any) {
    if (error?.code === "EEXIST") return;
    throw normalizeSubagentError(error, {
      code: "PERSISTENCE_FAILED",
      message: "Unable to initialize the native subagent session file.",
      operation: "persistence",
      id: input.id,
      retries: fsRetryCount(error),
    });
  }
}

function parseSessionFileStrict(raw: string): any[] {
  const lines = raw.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length === 0) throw new Error("native session file is empty");
  const entries = lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch {
      throw new Error(`native session file contains malformed JSON on line ${index + 1}`);
    }
  });

  const header = entries[0];
  if (header?.type !== "session" || typeof header.id !== "string") {
    throw new Error("native session file has no valid session header");
  }

  const seen = new Set<string>();
  for (const entry of entries.slice(1)) {
    if (!entry || typeof entry !== "object" || typeof entry.type !== "string" || typeof entry.id !== "string") {
      throw new Error("native session file contains an invalid entry");
    }
    if (seen.has(entry.id)) throw new Error(`native session file contains duplicate entry id '${entry.id}'`);
    if (entry.parentId !== null && entry.parentId !== undefined) {
      if (typeof entry.parentId !== "string" || !seen.has(entry.parentId)) {
        throw new Error(`native session entry '${entry.id}' has an invalid parent`);
      }
    }
    seen.add(entry.id);
  }
  return entries;
}

export interface ValidatedRunArtifacts {
  artifactsDir: string;
  details: SubagentRunDetails;
  sessionEntries: any[];
}

export function validateRunArtifacts(id: string): ValidatedRunArtifacts {
  assertValidSubagentId(id, "resume");
  const artifactsDir = artifactsDirFor(id);
  try {
    const root = subagentsStateRoot();
    const realRoot = realpathSync(root);
    const realArtifactsDir = realpathSync(artifactsDir);
    if (dirname(realArtifactsDir) !== realRoot) throw new Error("artifacts directory escapes the subagent state root");

    const details = readRunState(realArtifactsDir);
    if (resolvePath(details.artifactsDir) !== resolvePath(realArtifactsDir)) {
      throw new Error("run.json artifactsDir does not match its directory");
    }

    const realSessionFile = realpathSync(details.sessionFile);
    if (dirname(realSessionFile) !== realArtifactsDir) {
      throw new Error("native session file escapes the subagent artifacts directory");
    }
    const rawSession = withTransientFsRetries(() => readFileSync(realSessionFile, "utf8"));
    const sessionEntries = parseSessionFileStrict(rawSession);
    if (sessionEntries[0].id !== details.sessionId) {
      throw new Error("native session ID does not match run.json");
    }

    return { artifactsDir: realArtifactsDir, details, sessionEntries };
  } catch (error) {
    throw createSubagentError({
      code: "SESSION_HISTORY_UNAVAILABLE",
      message: `Subagent history for '${id}' is missing or invalid.`,
      operation: "resume",
      id,
      retryable: false,
      cause: error,
      suggestedAction: "Verify that run.json and the native JSONL session file still exist and are unmodified.",
    });
  }
}

export function listRunDirs(): string[] {
  const root = subagentsStateRoot();
  if (!existsSync(root)) return [];
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && isValidSubagentId(entry.name))
      .map((entry) => resolvePath(root, entry.name))
      .sort((a, b) => {
        try {
          return statSync(b).mtimeMs - statSync(a).mtimeMs;
        } catch {
          return 0;
        }
      });
  } catch {
    return [];
  }
}

export const __testables = {
  PUBLIC_ID_PATTERN,
  TRANSIENT_FS_CODES,
  FS_RETRY_DELAYS_MS,
  parseSessionFileStrict,
  validateRunStateShape,
  withTransientFsRetries,
  fsRetryCount,
};
