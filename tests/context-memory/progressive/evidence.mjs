import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

const FILE_NAME = "evidence.jsonl";
const READ_CHUNK_BYTES = 64 * 1024;
const MAX_RECORD_BYTES = 16 * 1024 * 1024;

export class EvidenceError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "EvidenceError";
    this.code = code;
  }
}

export function digest(value) {
  const serialized = typeof value === "string" || ArrayBuffer.isView(value)
    ? value
    : JSON.stringify(value);
  if (serialized === undefined) throw new TypeError("value is not JSON serializable");
  return createHash("sha256").update(serialized).digest("hex");
}

function writeAll(fd, bytes, write) {
  let offset = 0;
  while (offset < bytes.length) {
    const count = write(fd, bytes, offset, bytes.length - offset);
    if (!Number.isInteger(count) || count < 1) throw new Error("evidence write made no progress");
    offset += count;
  }
}

export function createEvidence(directory, { io: injectedIo = {} } = {}) {
  if (typeof directory !== "string" || directory.length === 0) throw new TypeError("directory must be a non-empty path");
  const io = { mkdirSync, chmodSync, openSync, writeSync, fsyncSync, closeSync, ...injectedIo };
  io.mkdirSync(directory, { mode: 0o700 });
  io.chmodSync(directory, 0o700);
  const file = join(directory, FILE_NAME);
  const fd = io.openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  let directoryFd;
  try {
    directoryFd = io.openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    io.fsyncSync(directoryFd);
  } catch (error) {
    try { io.closeSync(fd); } catch { /* preserve the setup failure */ }
    if (directoryFd !== undefined) try { io.closeSync(directoryFd); } catch { /* preserve the setup failure */ }
    throw error;
  }
  const hash = createHash("sha256");
  let bytes = 0;
  let records = 0;
  let closed = false;
  let result;
  let terminalError;

  const poison = (code, message, error) => {
    terminalError ??= error instanceof EvidenceError ? error : new EvidenceError(code, message, { cause: error });
    return terminalError;
  };

  return {
    append(kind, data) {
      if (closed) throw new EvidenceError("EVIDENCE_CLOSED", "evidence ledger is closed");
      if (terminalError) throw terminalError;
      if (typeof kind !== "string" || kind.length === 0) throw new TypeError("kind must be a non-empty string");
      if (data === undefined) throw new TypeError("data must be defined");
      let text;
      try {
        text = `${JSON.stringify({ kind, data })}\n`;
      } catch (error) {
        throw new EvidenceError("EVIDENCE_SERIALIZE", "evidence record is not JSON serializable", { cause: error });
      }
      if (text === "undefined\n") throw new EvidenceError("EVIDENCE_SERIALIZE", "evidence record is not JSON serializable");
      const encoded = Buffer.from(text);
      try {
        writeAll(fd, encoded, io.writeSync);
        io.fsyncSync(fd);
      } catch (error) {
        throw poison("EVIDENCE_WRITE", "evidence persistence failed; the ledger is unusable", error);
      }
      hash.update(encoded);
      bytes += encoded.length;
      records += 1;
    },
    close() {
      if (closed) {
        if (terminalError) throw terminalError;
        return result;
      }
      try {
        if (!terminalError) {
          try { io.fsyncSync(fd); }
          catch (error) { poison("EVIDENCE_SYNC", "evidence file synchronization failed", error); }
        }
      } finally {
        try { io.closeSync(fd); }
        catch (error) { poison("EVIDENCE_CLOSE", "evidence file close failed", error); }
        finally {
          try {
            if (!terminalError) io.fsyncSync(directoryFd);
          } catch (error) {
            poison("EVIDENCE_SYNC", "evidence directory synchronization failed", error);
          } finally {
            try { io.closeSync(directoryFd); }
            catch (error) { poison("EVIDENCE_CLOSE", "evidence directory close failed", error); }
            finally { closed = true; }
          }
        }
      }
      if (terminalError) throw terminalError;
      result = { sha256: hash.digest("hex"), bytes, records, file };
      return result;
    },
  };
}

function fail(code, message, cause) {
  throw new EvidenceError(code, message, cause === undefined ? undefined : { cause });
}

export function* readEvidence(file) {
  let before;
  try {
    before = lstatSync(file);
  } catch (error) {
    fail("EVIDENCE_READ", "cannot inspect evidence file", error);
  }
  if (before.isSymbolicLink() || !before.isFile()) fail("EVIDENCE_IDENTITY", "evidence path must be a regular file, not a symlink");
  if ((before.mode & 0o077) !== 0) fail("EVIDENCE_PERMISSIONS", "evidence file must be owner-only");

  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    fail("EVIDENCE_READ", "cannot open evidence file", error);
  }
  const opened = fstatSync(fd);
  if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
    closeSync(fd);
    fail("EVIDENCE_IDENTITY", "evidence file changed while opening");
  }
  if ((opened.mode & 0o077) !== 0 || (typeof process.getuid === "function" && opened.uid !== process.getuid())) {
    closeSync(fd);
    fail("EVIDENCE_PERMISSIONS", "evidence file must be owned by the current user and owner-only");
  }

  const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
  let pending = Buffer.alloc(0);
  let recordNumber = 0;
  try {
    while (true) {
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (count === 0) break;
      pending = pending.length === 0 ? Buffer.from(chunk.subarray(0, count)) : Buffer.concat([pending, chunk.subarray(0, count)]);
      let newline;
      while ((newline = pending.indexOf(0x0a)) !== -1) {
        const line = pending.subarray(0, newline);
        pending = pending.subarray(newline + 1);
        recordNumber += 1;
        if (line.length > MAX_RECORD_BYTES) fail("EVIDENCE_RECORD_OVERSIZE", `evidence record ${recordNumber} exceeds ${MAX_RECORD_BYTES} bytes`);
        if (line.length === 0) fail("EVIDENCE_MALFORMED", `evidence record ${recordNumber} is empty`);
        let value;
        try {
          const text = new TextDecoder("utf-8", { fatal: true }).decode(line);
          value = JSON.parse(text);
        } catch (error) {
          fail("EVIDENCE_MALFORMED", `evidence record ${recordNumber} is malformed`, error);
        }
        if (value === null || typeof value !== "object" || Array.isArray(value) || typeof value.kind !== "string" || !("data" in value)) {
          fail("EVIDENCE_MALFORMED", `evidence record ${recordNumber} has an invalid envelope`);
        }
        yield value;
      }
      if (pending.length > MAX_RECORD_BYTES) fail("EVIDENCE_RECORD_OVERSIZE", `evidence record ${recordNumber + 1} exceeds ${MAX_RECORD_BYTES} bytes`);
    }
    if (pending.length !== 0) fail("EVIDENCE_MALFORMED", `evidence record ${recordNumber + 1} is not newline terminated`);
    const after = fstatSync(fd);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size) fail("EVIDENCE_IDENTITY", "evidence file changed while reading");
  } finally {
    closeSync(fd);
  }
}
