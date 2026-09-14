import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, lstatSync, mkdtempSync, mkdirSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEvidence, digest, EvidenceError, readEvidence } from "./evidence.mjs";

const root = mkdtempSync(join(tmpdir(), "progressive-evidence-test-"));
try {
  const directory = join(root, "ledger");
  const ledger = createEvidence(directory);
  const payload = "x".repeat(700_000);
  ledger.append("request", { index: 1, payload });
  ledger.append("failure", { index: 2, payload });
  ledger.append("native-compaction", { index: 3, payload });
  ledger.append("metrics", { cacheRead: null, input: 123 });
  const closed = ledger.close();
  assert.equal(closed.records, 4);
  assert.ok(closed.bytes > 2 * 1024 * 1024, "the complete evidence stream survives beyond 2 MiB");
  const persisted = readFileSync(closed.file);
  assert.equal(closed.bytes, persisted.length);
  assert.equal(closed.sha256, createHash("sha256").update(persisted).digest("hex"));
  assert.equal(lstatSync(directory).mode & 0o777, 0o700);
  assert.equal(lstatSync(closed.file).mode & 0o777, 0o600);
  assert.deepEqual([...readEvidence(closed.file)].map((record) => [record.kind, record.data.index]), [
    ["request", 1], ["failure", 2], ["native-compaction", 3], ["metrics", undefined],
  ]);
  assert.deepEqual(ledger.close(), closed, "close is idempotent");
  assert.throws(() => ledger.append("late", {}), (error) => error instanceof EvidenceError && error.code === "EVIDENCE_CLOSED");
  assert.equal(digest("abc"), createHash("sha256").update("abc").digest("hex"));
  assert.equal(digest({ a: 1 }), createHash("sha256").update('{"a":1}').digest("hex"));

  assert.throws(() => createEvidence(directory), /EEXIST/, "a ledger directory cannot be reused");
  const target = join(root, "target");
  mkdirSync(target);
  const linkedDirectory = join(root, "linked-ledger");
  symlinkSync(target, linkedDirectory);
  assert.throws(() => createEvidence(linkedDirectory), /EEXIST/, "a symlink cannot become the ledger directory");
  const linkedFile = join(root, "linked.jsonl");
  symlinkSync(closed.file, linkedFile);
  assert.throws(() => [...readEvidence(linkedFile)], (error) => error instanceof EvidenceError && error.code === "EVIDENCE_IDENTITY");

  const malformed = join(root, "malformed.jsonl");
  writeFileSync(malformed, '{"kind":"x","data":1}\nnot-json\n', { mode: 0o600 });
  assert.throws(() => [...readEvidence(malformed)], (error) => error instanceof EvidenceError && error.code === "EVIDENCE_MALFORMED");
  const unterminated = join(root, "unterminated.jsonl");
  writeFileSync(unterminated, '{"kind":"x","data":1}', { mode: 0o600 });
  assert.throws(() => [...readEvidence(unterminated)], (error) => error instanceof EvidenceError && error.code === "EVIDENCE_MALFORMED");
  const oversized = join(root, "oversized.jsonl");
  writeFileSync(oversized, `{"kind":"x","data":"${"z".repeat(16 * 1024 * 1024)}"}\n`, { mode: 0o600 });
  assert.throws(() => [...readEvidence(oversized)], (error) => error instanceof EvidenceError && error.code === "EVIDENCE_RECORD_OVERSIZE");
  const permissive = join(root, "permissive.jsonl");
  writeFileSync(permissive, '{"kind":"x","data":1}\n', { mode: 0o600 });
  chmodSync(permissive, 0o640);
  assert.throws(() => [...readEvidence(permissive)], (error) => error instanceof EvidenceError && error.code === "EVIDENCE_PERMISSIONS");

  {
    let opens = 0;
    let closes = 0;
    assert.throws(() => createEvidence(join(root, "directory-open-failure"), { io: {
      openSync(...args) { if (++opens === 2) throw new Error("injected directory open"); return openSync(...args); },
      closeSync(fd) { closes += 1; closeSync(fd); },
    } }), /injected directory open/);
    assert.equal(closes, 1, "the file descriptor closes when opening the directory descriptor fails");
  }

  {
    let closes = 0;
    assert.throws(() => createEvidence(join(root, "initial-directory-fsync"), { io: {
      fsyncSync() { throw new Error("injected initial directory fsync"); },
      closeSync(fd) { closes += 1; closeSync(fd); },
    } }), /injected initial directory fsync/);
    assert.equal(closes, 2, "both descriptors close when initial directory fsync fails");
  }

  {
    let fileFd;
    const closedFds = [];
    let failed = false;
    const faulty = createEvidence(join(root, "partial-write"), { io: {
      openSync(...args) { const fd = openSync(...args); fileFd ??= fd; return fd; },
      writeSync(fd, buffer, offset, length) {
        if (fd === fileFd && !failed) {
          failed = true;
          writeSync(fd, buffer, offset, Math.max(1, Math.floor(length / 2)));
          throw new Error("injected partial write");
        }
        return writeSync(fd, buffer, offset, length);
      },
      closeSync(fd) { closedFds.push(fd); closeSync(fd); },
    } });
    assert.throws(() => faulty.append("partial", { value: "cannot-hash" }), (error) => error instanceof EvidenceError && error.code === "EVIDENCE_WRITE");
    assert.throws(() => faulty.append("later", {}), (error) => error instanceof EvidenceError && error.code === "EVIDENCE_WRITE", "a poisoned ledger rejects later appends");
    assert.throws(() => faulty.close(), (error) => error instanceof EvidenceError && error.code === "EVIDENCE_WRITE", "uncertain bytes never produce a manifest");
    assert.equal(new Set(closedFds).size, 2, "both file and directory descriptors close after a partial write");
    assert.throws(() => faulty.close(), (error) => error instanceof EvidenceError && error.code === "EVIDENCE_WRITE");
  }

  {
    let fileFd;
    let fileSyncs = 0;
    const closedFds = [];
    const faulty = createEvidence(join(root, "file-fsync"), { io: {
      openSync(...args) { const fd = openSync(...args); fileFd ??= fd; return fd; },
      fsyncSync(fd) {
        if (fd === fileFd && ++fileSyncs === 1) throw new Error("injected file fsync");
        return fsyncSync(fd);
      },
      closeSync(fd) { closedFds.push(fd); closeSync(fd); },
    } });
    assert.throws(() => faulty.append("sync", {}), (error) => error instanceof EvidenceError && error.code === "EVIDENCE_WRITE");
    assert.throws(() => faulty.close(), (error) => error instanceof EvidenceError && error.code === "EVIDENCE_WRITE");
    assert.equal(new Set(closedFds).size, 2, "both descriptors close after append fsync failure");
  }

  {
    let directoryFd;
    let directorySyncs = 0;
    const closedFds = [];
    const faulty = createEvidence(join(root, "directory-fsync"), { io: {
      openSync(...args) { const fd = openSync(...args); directoryFd = fd; return fd; },
      fsyncSync(fd) {
        if (fd === directoryFd && ++directorySyncs === 2) throw new Error("injected directory fsync");
        return fsyncSync(fd);
      },
      closeSync(fd) { closedFds.push(fd); closeSync(fd); },
    } });
    faulty.append("complete", {});
    assert.throws(() => faulty.close(), (error) => error instanceof EvidenceError && error.code === "EVIDENCE_SYNC", "directory durability failure prevents a manifest");
    assert.equal(new Set(closedFds).size, 2, "both descriptors close after directory fsync failure");
  }

  {
    let closes = 0;
    const faulty = createEvidence(join(root, "file-close"), { io: {
      closeSync(fd) {
        closes += 1;
        closeSync(fd);
        if (closes === 1) throw new Error("injected file close");
      },
    } });
    faulty.append("complete", {});
    assert.throws(() => faulty.close(), (error) => error instanceof EvidenceError && error.code === "EVIDENCE_CLOSE");
    assert.equal(closes, 2, "directory close is attempted even when file close reports failure");
  }

  console.log("context-memory progressive evidence: all assertions passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
