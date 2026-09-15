import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync } from "node:fs";
import type { Stats } from "node:fs";

import { resolveChildSessionFile } from "./artifacts";
import type { SubagentRunDetails } from "./types";

/**
 * The artifact identity boundary for a child's native session file
 * (odradekk/pi-square#361).
 *
 * Resume and history paging reach the file only through this module. The
 * identity protocol — lstat the recorded path, open it read-only with
 * O_NOFOLLOW, fstat the opened descriptor, lstat the path again, and bind all
 * three observations to one regular-file dev/ino identity — has exactly one
 * implementation, here, and every handle read re-runs it. A record problem
 * surfaces through `resolveChildSessionFile` as the artifact boundary's
 * structured refusal; a protocol violation refuses with a coded
 * {@link SessionFileRefusal} before a single byte is read.
 */

/** Stats observations the identity protocol binds to. */
export type SessionFilePathStat = Pick<Stats, "dev" | "ino" | "isFile" | "size">;

/** The opened descriptor's own identity and size. */
export interface SessionFileStat {
  readonly size: number;
  readonly dev: number;
  readonly ino: number;
}

export type SessionFileRefusalCode = "NOT_A_REGULAR_FILE" | "IDENTITY_CHANGED";

/** Explicit refusal from the session-file identity protocol. */
export class SessionFileRefusal extends Error {
  readonly name = "SessionFileRefusal";

  constructor(
    readonly code: SessionFileRefusalCode,
    readonly sessionFile: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Filesystem primitives behind the identity protocol. Production binds the
 * node:fs synchronous calls; focused tests replace them to exercise refusals
 * that a real filesystem cannot stage deterministically.
 */
export interface SessionFileIo {
  lstat(path: string): SessionFilePathStat;
  open(path: string, flags: number): number;
  fstat(descriptor: number): SessionFilePathStat;
  readText(descriptor: number): string;
  read(descriptor: number, buffer: Buffer, offset: number, length: number, position: number): number;
  close(descriptor: number): void;
}

/** Production binding of {@link SessionFileIo} to the node:fs sync primitives. */
export const NODE_SESSION_FILE_IO: SessionFileIo = {
  lstat: lstatSync,
  open: openSync,
  fstat: fstatSync,
  readText: (descriptor) => readFileSync(descriptor, "utf8"),
  read: readSync,
  close: closeSync,
};

const SESSION_FILE_OPEN_FLAGS =
  constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

const EMPTY_BUFFER = Buffer.alloc(0);

function sameIdentity(left: SessionFilePathStat, right: SessionFilePathStat): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/**
 * The one identity protocol. Returns an open descriptor bound to a verified
 * regular-file identity; the caller owns closing it. Any violation closes the
 * descriptor and refuses before a byte is read.
 */
function openVerifiedSessionFile(
  sessionFile: string,
  io: SessionFileIo,
): { descriptor: number; stat: SessionFileStat } {
  const before = io.lstat(sessionFile);
  if (!before.isFile()) {
    throw new SessionFileRefusal("NOT_A_REGULAR_FILE", sessionFile, "native session file is not a regular file");
  }
  // O_NOFOLLOW refuses a final-component symlink where the platform supports
  // it; O_NONBLOCK keeps a raced FIFO replacement from hanging the reader.
  const descriptor = io.open(sessionFile, SESSION_FILE_OPEN_FLAGS);
  let opened: SessionFilePathStat;
  let after: SessionFilePathStat;
  try {
    opened = io.fstat(descriptor);
    after = io.lstat(sessionFile);
  } catch (error) {
    io.close(descriptor);
    throw error;
  }
  if (!opened.isFile() || !after.isFile()) {
    io.close(descriptor);
    throw new SessionFileRefusal("NOT_A_REGULAR_FILE", sessionFile, "native session file is not a regular file");
  }
  if (!sameIdentity(before, opened) || !sameIdentity(opened, after)) {
    io.close(descriptor);
    throw new SessionFileRefusal("IDENTITY_CHANGED", sessionFile, "native session file changed while opening");
  }
  return { descriptor, stat: { size: opened.size, dev: opened.dev, ino: opened.ino } };
}

/**
 * Read-only handle to one run record's native session file. Every read
 * re-runs the identity protocol against the recorded path, so a handle never
 * serves bytes from a replaced or retyped file.
 */
export interface ChildSessionFileHandle {
  /** The validated session-file path recorded in the run record. */
  readonly path: string;
  /** One verified whole-file UTF-8 read. */
  readText(): string;
  /** One verified positioned read of `[start, end)`; `stat` is the opened descriptor's own. */
  readRange(start: number, end: number): { stat: SessionFileStat; data: Buffer };
}

/** One run record resolved and bound to its verified read-only session-file handle. */
export interface OpenedChildSessionFile {
  readonly artifactsDir: string;
  readonly details: SubagentRunDetails;
  readonly handle: ChildSessionFileHandle;
}

export type OpenChildSessionFile = (
  id: string,
  operation?: string,
  io?: SessionFileIo,
) => OpenedChildSessionFile;

/**
 * The single entry point through which resume and history paging open a
 * child's native session file: resolves the run record through the artifact
 * identity boundary and binds it to a read-only handle whose every read is
 * identity-verified.
 */
export function openChildSessionFile(
  id: string,
  operation = "resume",
  io: SessionFileIo = NODE_SESSION_FILE_IO,
): OpenedChildSessionFile {
  const { artifactsDir, details, sessionFile } = resolveChildSessionFile(id, operation);
  const handle: ChildSessionFileHandle = {
    path: sessionFile,
    readText() {
      const { descriptor } = openVerifiedSessionFile(sessionFile, io);
      try {
        return io.readText(descriptor);
      } finally {
        io.close(descriptor);
      }
    },
    readRange(start, end) {
      const { descriptor, stat } = openVerifiedSessionFile(sessionFile, io);
      try {
        if (end <= start) {
          return { stat, data: EMPTY_BUFFER };
        }
        const length = Math.min(end, stat.size) - start;
        if (length <= 0) {
          return { stat, data: EMPTY_BUFFER };
        }
        const buffer = Buffer.alloc(length);
        let read = 0;
        while (read < buffer.length) {
          const bytes = io.read(descriptor, buffer, read, buffer.length - read, start + read);
          if (bytes <= 0) break;
          read += bytes;
        }
        return { stat, data: read === buffer.length ? buffer : buffer.subarray(0, read) };
      } finally {
        io.close(descriptor);
      }
    },
  };
  return { artifactsDir, details, handle };
}
