import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "fs/promises";
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import {
  __lockTestables,
  acquireFileLock,
  fileLockedMessage,
  lockFilePath,
} from "../../../src/anchored-edit/file-lock";
import { getWritableTempRoot } from "../support/fixtures";

const { lockBarrier } = __lockTestables;

afterEach(() => {
  lockBarrier.markerHeld = undefined;
  lockBarrier.markerClaimed = undefined;
  lockBarrier.markerTaken = undefined;
  lockBarrier.afterTake = undefined;
  vi.unstubAllEnvs();
});

async function freshDir(name: string): Promise<string> {
  const dir = await mkdtemp(join(await getWritableTempRoot(), `lock-protocol-${name}-`));
  await mkdir(join(dir, "locks"), { recursive: true });
  return dir;
}

function lockPathIn(dir: string): string {
  return lockFilePath(dir, "/canonical/target.txt");
}

async function residue(dir: string): Promise<string[]> {
  const entries = await readdir(join(dir, "locks")).catch(() => [] as string[]);
  return entries.filter(
    (name) => name.includes(".retired-") || name.endsWith(".rm") || name.includes(".rm.claim.") || name.startsWith(".publish-"),
  );
}

/** Publishes a complete owner record for `pid` at a path, the way a real
 *  process would. */
async function installRecord(
  path: string,
  owner: { pid: number; hostname: string; startTime?: string; token?: string },
): Promise<void> {
  await writeFile(
    path,
    JSON.stringify({
      v: 1,
      token: owner.token ?? `token-${Math.random()}`,
      pid: owner.pid,
      hostname: owner.hostname,
      ...(owner.startTime !== undefined ? { startTime: owner.startTime } : {}),
      acquiredAt: Date.now(),
    }),
    "utf8",
  );
}

/** A real, dead pid: spawn a process that exits immediately and wait for it. */
function deadPid(): number {
  const result = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  expect(result.status).toBe(0);
  return result.pid!;
}

function budget(ms: number) {
  return { deadlineAt: Date.now() + ms, pollMs: 5 };
}

function rmSyncSafe(path: string): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require("node:fs").rmSync(path, { force: true });
  } catch {
    // best-effort cleanup
  }
}

describe("lock record validation (#264: strict schema, fail closed)", () => {
  it("accepts a complete record and rejects every incomplete or malformed variant", () => {
    const { isCompleteOwnerRecord } = __lockTestables;
    const complete = {
      v: 1,
      token: "t".repeat(128),
      pid: 42,
      hostname: "h",
      acquiredAt: 1,
    };
    expect(isCompleteOwnerRecord(complete)).toBe(true);
    expect(isCompleteOwnerRecord({ ...complete, startTime: "123456789" })).toBe(true);
    expect(isCompleteOwnerRecord({ ...complete, v: 2 })).toBe(false);
    expect(isCompleteOwnerRecord({ ...complete, token: "" })).toBe(false);
    expect(isCompleteOwnerRecord({ ...complete, token: "t".repeat(129) })).toBe(false);
    expect(isCompleteOwnerRecord({ ...complete, pid: 0 })).toBe(false);
    expect(isCompleteOwnerRecord({ ...complete, pid: 1.5 })).toBe(false);
    expect(isCompleteOwnerRecord({ ...complete, pid: -1 })).toBe(false);
    expect(isCompleteOwnerRecord({ ...complete, hostname: "" })).toBe(false);
    expect(isCompleteOwnerRecord({ ...complete, acquiredAt: Number.NaN })).toBe(false);
    expect(isCompleteOwnerRecord({ ...complete, acquiredAt: "now" })).toBe(false);
    // A start time that is not strictly digits is not a start time: the
    // record is unverifiable and fails closed.
    expect(isCompleteOwnerRecord({ ...complete, startTime: "not-a-proc-start-time" })).toBe(false);
    expect(isCompleteOwnerRecord({ ...complete, startTime: "12x4" })).toBe(false);
    expect(isCompleteOwnerRecord({ ...complete, startTime: 123 })).toBe(false);
    // A pid outside the representable OS range is malformed ownership, not a
    // process to probe (#264 review).
    expect(isCompleteOwnerRecord({ ...complete, pid: 4_194_305 })).toBe(false);
    expect(isCompleteOwnerRecord({ ...complete, pid: Number.MAX_SAFE_INTEGER })).toBe(false);
    expect(isCompleteOwnerRecord({ ...complete, pid: 4_194_304 })).toBe(true);
    expect(isCompleteOwnerRecord({ pid: 42 })).toBe(false);
    expect(isCompleteOwnerRecord("not an object")).toBe(false);
    expect(isCompleteOwnerRecord(null)).toBe(false);
  });

  it("treats a malformed lock file as unverifiable: it is waited on, never reclaimed", async () => {
    const dir = await freshDir("malformed");
    try {
      await writeFile(lockPathIn(dir), "{partial json", "utf8");
      const lock = await acquireFileLock(lockPathIn(dir), { waitMs: 60, pollMs: 10 });
      expect(lock).toBeNull();
      expect(await readFile(lockPathIn(dir), "utf8")).toBe("{partial json");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("treats a pre-token record as unverifiable even when it names a dead pid", async () => {
    const dir = await freshDir("incomplete");
    try {
      await writeFile(lockPathIn(dir), JSON.stringify({ pid: deadPid(), hostname: hostname() }), "utf8");
      const lock = await acquireFileLock(lockPathIn(dir), { waitMs: 60, pollMs: 10 });
      expect(lock).toBeNull();
      expect(existsSync(lockPathIn(dir))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a live pid with a malformed start time is never reclaimed (#264 P1)", async () => {
    const dir = await freshDir("malformed-start");
    try {
      // The reviewer's reproduction: current live PID, our hostname, and a
      // garbage start time. The record is unverifiable, so the lock is only
      // waited on — never reclaimed by misreading the garbage as a start-time
      // mismatch proving pid reuse.
      await installRecord(lockPathIn(dir), {
        pid: process.pid,
        hostname: hostname(),
        startTime: "not-a-proc-start-time",
      });
      const lock = await acquireFileLock(lockPathIn(dir), { waitMs: 120, pollMs: 10 });
      expect(lock).toBeNull();
      const raw = JSON.parse(await readFile(lockPathIn(dir), "utf8")) as { pid: number };
      expect(raw.pid).toBe(process.pid);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("dead-owner determination (#264: positive proof only)", () => {
  it("never reclaims a foreign-host record regardless of age or pid state", async () => {
    const dir = await freshDir("foreign");
    try {
      await installRecord(lockPathIn(dir), { pid: deadPid(), hostname: "another-host.example" });
      const lock = await acquireFileLock(lockPathIn(dir), { waitMs: 60, pollMs: 10 });
      expect(lock).toBeNull();
      expect(existsSync(lockPathIn(dir))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reclaims a confirmed-dead local owner through the marker protocol and then acquires", async () => {
    const dir = await freshDir("dead");
    try {
      await installRecord(lockPathIn(dir), { pid: deadPid(), hostname: hostname() });
      const lock = await acquireFileLock(lockPathIn(dir), { waitMs: 2000, pollMs: 10 });
      expect(lock).not.toBeNull();
      await lock!.release();
      expect(existsSync(lockPathIn(dir))).toBe(false);
      expect(await residue(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("never reclaims a live local owner", async () => {
    const dir = await freshDir("live");
    try {
      await installRecord(lockPathIn(dir), { pid: process.pid, hostname: hostname() });
      const lock = await acquireFileLock(lockPathIn(dir), { waitMs: 60, pollMs: 10 });
      expect(lock).toBeNull();
      expect(existsSync(lockPathIn(dir))).toBe(true);
      expect(await residue(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("only ESRCH proves death through the liveness probe; unexpected probe errors fail closed (#264 review)", () => {
    const { isOwnerGone } = __lockTestables;
    const record = {
      v: 1 as const,
      token: "t",
      pid: process.pid,
      hostname: hostname(),
      acquiredAt: Date.now(),
    };
    const killSpy = vi.spyOn(process, "kill");
    try {
      killSpy.mockImplementation(() => {
        throw Object.assign(new Error("probe failed"), { code: "EIO" });
      });
      expect(isOwnerGone(record), "an unexpected probe error is never death").toBe(false);
      killSpy.mockImplementation(() => {
        throw Object.assign(new Error("no such process"), { code: "ESRCH" });
      });
      expect(isOwnerGone(record), "ESRCH is a definitive death proof").toBe(true);
      killSpy.mockImplementation(() => {
        throw Object.assign(new Error("not ours"), { code: "EPERM" });
      });
      expect(isOwnerGone(record), "EPERM means alive").toBe(false);
    } finally {
      killSpy.mockRestore();
    }
  });

  it("a well-formed start-time mismatch proves the original died even though the pid is alive again", () => {
    const { isOwnerGone } = __lockTestables;
    expect(
      isOwnerGone({
        v: 1,
        token: "t",
        pid: process.pid,
        hostname: hostname(),
        startTime: "999999",
        acquiredAt: Date.now(),
      }),
    ).toBe(true);
    expect(
      isOwnerGone({
        v: 1,
        token: "t",
        pid: process.pid,
        hostname: hostname(),
        acquiredAt: Date.now(),
      }),
    ).toBe(false);
  });
});

describe("lock publication (#264: atomic no-clobber or fail closed)", () => {
  it("never clobbers an existing lock and reports it as held", async () => {
    const dir = await freshDir("publish-held");
    try {
      await installRecord(lockPathIn(dir), { pid: process.pid, hostname: hostname() });
      const identity = await __lockTestables.publishOwnerRecord(
        lockPathIn(dir),
        JSON.stringify(__lockTestables.currentOwnerRecord()),
      );
      expect(identity).toBeUndefined();
      const raw = JSON.parse(await readFile(lockPathIn(dir), "utf8")) as { pid: number };
      expect(raw.pid).toBe(process.pid);
      expect((await readdir(join(dir, "locks"))).filter((name) => name.startsWith(".publish-"))).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fails closed when the lock name cannot be published, leaving no partial lock file", async () => {
    if (process.getuid?.() === 0) {
      // Root ignores the directory permission bit used to force the failure.
      return;
    }
    const dir = await freshDir("publish-fail");
    try {
      await chmod(join(dir, "locks"), 0o500);
      await expect(
        __lockTestables.publishOwnerRecord(
          lockPathIn(dir),
          JSON.stringify(__lockTestables.currentOwnerRecord()),
        ),
      ).rejects.toThrow();
      expect(existsSync(lockPathIn(dir))).toBe(false);
      expect((await readdir(join(dir, "locks"))).filter((name) => name.startsWith(".publish-"))).toEqual([]);
    } finally {
      await chmod(join(dir, "locks"), 0o700).catch(() => {});
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("stale verifier versus live successor (#264 P1: exclusion never breaks)", () => {
  it("a stale verifier never disturbs a live successor, no third writer acquires, no residue", async () => {
    const dir = await freshDir("stale-verifier");
    try {
      // The verifier earlier proved this dead owner's record.
      const dead = deadPid();
      await installRecord(lockPathIn(dir), { pid: dead, hostname: hostname(), token: "prior-token" });
      const verified = await stat(lockPathIn(dir));

      // A real successor reclaims the dead lock and now holds it live.
      const successorLock = await acquireFileLock(lockPathIn(dir), { waitMs: 2000, pollMs: 10 });
      expect(successorLock).not.toBeNull();
      const successor = successorLock!;
      const successorRecord = JSON.parse(await readFile(lockPathIn(dir), "utf8")) as { token: string };
      expect(successorRecord.token).not.toBe("prior-token");

      // The stale verifier's removal runs to completion while the successor
      // is live; hold it deterministically inside its marker-held phase so a
      // third writer is provably racing the exact window the old protocol
      // exposed.
      let releaseVerifier!: () => void;
      const verifierAtMarker = new Promise<void>((resolveAtMarker) => {
        lockBarrier.markerHeld = () => {
          resolveAtMarker();
          return new Promise<void>((resolveRelease) => { releaseVerifier = resolveRelease; });
        };
      });
      const staleRemoval = __lockTestables.removeVerifiedLockFile(lockPathIn(dir), verified, "prior-token", budget(5000));
      await verifierAtMarker;

      // While the stale verifier holds its removal marker, the successor's
      // lock still occupies the canonical path: a third writer cannot
      // acquire, and the lock file is never moved away.
      const third = await acquireFileLock(lockPathIn(dir), { waitMs: 80, pollMs: 10 });
      expect(third, "no third writer acquires while the live successor holds the lock").toBeNull();
      expect(existsSync(lockPathIn(dir)), "the canonical lock path stayed occupied").toBe(true);

      releaseVerifier();
      const outcome = await staleRemoval;
      expect(outcome).toBe("foreign");
      // The barrier must not intercept the successor's own release below.
      lockBarrier.markerHeld = undefined;

      // The successor's lock survived untouched and nothing was left behind.
      const after = JSON.parse(await readFile(lockPathIn(dir), "utf8")) as { token: string };
      expect(after.token).toBe(successorRecord.token);
      expect(await residue(dir)).toEqual([]);

      await successor.release();
      expect(existsSync(lockPathIn(dir))).toBe(false);
      expect(await residue(dir)).toEqual([]);
    } finally {
      lockBarrier.markerHeld = undefined;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a release that finds the removal marker busy retries and never permanently leaks the lock (#264 P1)", async () => {
    const dir = await freshDir("release-busy");
    try {
      // A dead prior lock and a stale verifier paused inside its marker-held
      // phase, exactly the reviewer's interleaving.
      const dead = deadPid();
      await installRecord(lockPathIn(dir), { pid: dead, hostname: hostname(), token: "prior-token" });
      const verified = await stat(lockPathIn(dir));
      const successorLock = await acquireFileLock(lockPathIn(dir), { waitMs: 2000, pollMs: 10 });
      expect(successorLock).not.toBeNull();
      const successor = successorLock!;

      let releaseVerifier!: () => void;
      const verifierAtMarker = new Promise<void>((resolveAtMarker) => {
        lockBarrier.markerHeld = () => {
          resolveAtMarker();
          return new Promise<void>((resolveRelease) => { releaseVerifier = resolveRelease; });
        };
      });
      const staleRemoval = __lockTestables.removeVerifiedLockFile(lockPathIn(dir), verified, "prior-token", budget(10_000));
      await verifierAtMarker;

      // The successor releases while the marker is held: every attempt is
      // busy, and a single-shot release would permanently leak the lock.
      const release = successor.release();
      expect(existsSync(lockPathIn(dir)), "the lock is still held while the marker is occupied").toBe(true);

      releaseVerifier();
      // One-shot barrier: the retried release must not park on it.
      lockBarrier.markerHeld = undefined;
      const staleOutcome = await staleRemoval;
      expect(staleOutcome).toBe("foreign");
      await release;

      // The retried release removed the lock: a subsequent acquisition
      // succeeds, and nothing is left behind.
      expect(existsSync(lockPathIn(dir))).toBe(false);
      const third = await acquireFileLock(lockPathIn(dir), { waitMs: 500, pollMs: 10 });
      expect(third, "a later acquisition succeeds after the retried release").not.toBeNull();
      await third!.release();
      expect(await residue(dir)).toEqual([]);
    } finally {
      lockBarrier.markerHeld = undefined;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a release whose every attempt stays busy exhausts its budget safely with an explicit record (#264 P1)", async () => {
    const dir = await freshDir("release-exhaust");
    vi.stubEnv("PI_SQUARE_RELEASE_BUDGET_MS", "80");
    try {
      const dead = deadPid();
      await installRecord(lockPathIn(dir), { pid: dead, hostname: hostname(), token: "prior-token" });
      const verified = await stat(lockPathIn(dir));
      const successorLock = await acquireFileLock(lockPathIn(dir), { waitMs: 2000, pollMs: 10 });
      const successor = successorLock!;

      // The stale verifier stays parked in its marker-held phase for the
      // whole release budget.
      let releaseVerifier!: () => void;
      const verifierAtMarker = new Promise<void>((resolveAtMarker) => {
        lockBarrier.markerHeld = () => {
          resolveAtMarker();
          return new Promise<void>((resolveRelease) => { releaseVerifier = resolveRelease; });
        };
      });
      const staleRemoval = __lockTestables.removeVerifiedLockFile(lockPathIn(dir), verified, "prior-token", budget(10_000));
      await verifierAtMarker;

      const errors: unknown[] = [];
      const errorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { errors.push(args); });
      try {
        await successor.release();
      } finally {
        errorSpy.mockRestore();
      }
      expect(
        errors.some((args) => String((args as unknown[])[0]).includes("removal marker stayed busy")),
        "the exhausted release records the safe failure explicitly",
      ).toBe(true);
      // Safe failure: the lock file remains (reclaimed once this process is
      // gone) and no protocol residue was left behind.
      expect(existsSync(lockPathIn(dir))).toBe(true);

      releaseVerifier();
      // One-shot barrier: nothing after this may park on it.
      lockBarrier.markerHeld = undefined;
      const staleOutcome = await staleRemoval;
      expect(staleOutcome).toBe("foreign");
      const entries = await residue(dir);
      expect(entries.filter((name) => name !== undefined)).toEqual([]);
      rmSyncSafe(lockPathIn(dir));
    } finally {
      lockBarrier.markerHeld = undefined;
      vi.unstubAllEnvs();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a live holder's own release still removes exactly its own file", async () => {
    const dir = await freshDir("release-own");
    try {
      const lock = await acquireFileLock(lockPathIn(dir), { waitMs: 500 });
      expect(lock).not.toBeNull();
      await lock!.release();
      expect(existsSync(lockPathIn(dir))).toBe(false);
      expect(await residue(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("removal marker claim races (#264 P1)", () => {
  it("a losing stale reclaimer never displaces the winner's live marker, and no concurrent remover enters", async () => {
    const dir = await freshDir("claim-race");
    try {
      const marker = __lockTestables.markerPath(lockPathIn(dir));
      // A dead remover's marker record.
      await installRecord(marker, { pid: deadPid(), hostname: hostname(), token: "dead-marker" });

      // R1 wins the claim and pauses at the claim barrier (before the take).
      let releaseR1!: () => void;
      const r1Claimed = new Promise<void>((resolveClaimed) => {
        lockBarrier.markerClaimed = () => {
          resolveClaimed();
          return new Promise<void>((resolveRelease) => { releaseR1 = resolveRelease; });
        };
      });
      const budgetR1 = budget(10_000);
      const r1 = __lockTestables.acquireRemovalMarker(lockPathIn(dir), budgetR1);
      await r1Claimed;

      // R2 — the delayed stale reclaimer that read the same dead marker —
      // cannot win the claim and must back off without touching the marker.
      const r2 = await __lockTestables.acquireRemovalMarker(lockPathIn(dir), budget(200));
      expect(r2, "the losing reclaimer is busy and never becomes a holder").toBeUndefined();
      const markerDuringRace = JSON.parse(await readFile(marker, "utf8")) as { token: string };
      expect(markerDuringRace.token, "the dead marker was never displaced mid-race").toBe("dead-marker");

      releaseR1();
      const r1Handle = await r1;
      expect(r1Handle, "the claim winner becomes the marker holder").toBeDefined();
      const afterRace = JSON.parse(await readFile(marker, "utf8")) as { token: string };
      expect(afterRace.token).toBe(r1Handle!.token);

      // A later remover sees the live holder and stays busy; releasing the
      // marker leaves the path clean with no residue.
      const r3 = await __lockTestables.acquireRemovalMarker(lockPathIn(dir), budget(100));
      expect(r3).toBeUndefined();
      await __lockTestables.releaseRemovalMarker(lockPathIn(dir), r1Handle!);
      expect(existsSync(marker)).toBe(false);
      expect(await residue(dir)).toEqual([]);
    } finally {
      lockBarrier.markerClaimed = undefined;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a fresh remover that wins the take-to-publish gap becomes the sole holder; the claimant backs off with no residue", async () => {
    const dir = await freshDir("claim-gap");
    try {
      const marker = __lockTestables.markerPath(lockPathIn(dir));
      await installRecord(marker, { pid: deadPid(), hostname: hostname(), token: "dead-marker" });

      // R1 pauses after taking the dead marker, while the marker path is
      // empty; a fresh remover R3 publishes and wins the path in the gap.
      let releaseR1!: () => void;
      const r1Taken = new Promise<void>((resolveTaken) => {
        lockBarrier.markerTaken = () => {
          resolveTaken();
          return new Promise<void>((resolveRelease) => { releaseR1 = resolveRelease; });
        };
      });
      const r1 = __lockTestables.acquireRemovalMarker(lockPathIn(dir), budget(10_000));
      await r1Taken;

      const freshRecord = __lockTestables.currentOwnerRecord();
      const freshIdentity = await __lockTestables.publishOwnerRecord(marker, JSON.stringify(freshRecord));
      expect(freshIdentity, "the fresh remover won the empty path in the gap").toBeDefined();

      releaseR1();
      const r1Handle = await r1;
      expect(r1Handle, "the claimant backs off instead of double-holding").toBeUndefined();
      const sole = JSON.parse(await readFile(marker, "utf8")) as { token: string };
      expect(sole.token, "the fresh remover is the sole holder").toBe(freshRecord.token);

      // Clean up the fresh remover's marker; nothing is left behind.
      await __lockTestables.releaseRemovalMarker(lockPathIn(dir), { token: freshRecord.token, identity: freshIdentity! });
      expect(existsSync(marker)).toBe(false);
      expect(await residue(dir)).toEqual([]);
    } finally {
      lockBarrier.markerTaken = undefined;
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("removal marker lifecycle", () => {
  it("reclaims a marker whose holder died, then reclaims the dead lock — no residue", async () => {
    const dir = await freshDir("dead-marker");
    try {
      await installRecord(lockPathIn(dir), { pid: deadPid(), hostname: hostname() });
      // A previous remover died holding the removal marker.
      await installRecord(__lockTestables.markerPath(lockPathIn(dir)), {
        pid: deadPid(),
        hostname: hostname(),
        token: "dead-marker-token",
      });
      const lock = await acquireFileLock(lockPathIn(dir), { waitMs: 2000, pollMs: 10 });
      expect(lock).not.toBeNull();
      await lock!.release();
      expect(existsSync(lockPathIn(dir))).toBe(false);
      expect(await residue(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a live marker holder makes the reclaim busy: bounded refusal, nothing removed", async () => {
    const dir = await freshDir("live-marker");
    try {
      const deadRecordRaw = JSON.stringify({
        v: 1,
        token: "dead-lock-token",
        pid: deadPid(),
        hostname: hostname(),
        acquiredAt: Date.now(),
      });
      await writeFile(lockPathIn(dir), deadRecordRaw, "utf8");
      // A live remover currently holds the marker: the dead lock must not be
      // touched, and the acquire ends as classified contention within its
      // own budget.
      await installRecord(__lockTestables.markerPath(lockPathIn(dir)), {
        pid: process.pid,
        hostname: hostname(),
        token: "live-marker-token",
      });
      const lock = await acquireFileLock(lockPathIn(dir), { waitMs: 120, pollMs: 10 });
      expect(lock).toBeNull();
      expect(
        await readFile(lockPathIn(dir), "utf8"),
        "the dead lock was not removed behind a live marker",
      ).toBe(deadRecordRaw);
      const markerRecord = JSON.parse(await readFile(__lockTestables.markerPath(lockPathIn(dir)), "utf8")) as { token: string };
      expect(markerRecord.token).toBe("live-marker-token");
      // No residue from OUR attempt: the marker file pre-existed (the live
      // remover's own artifact), so exclude exactly that name.
      const markerName = __lockTestables.markerPath(lockPathIn(dir)).split("/").pop()!;
      expect((await residue(dir)).filter((name) => name !== markerName)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("an unverifiable original is foreign by definition: never removed, only waited on", async () => {
    const dir = await freshDir("unverifiable");
    try {
      await writeFile(lockPathIn(dir), "{not json", "utf8");
      const verified = await stat(lockPathIn(dir));
      const outcome = await __lockTestables.removeVerifiedLockFile(lockPathIn(dir), verified, undefined, budget(500));
      expect(outcome).toBe("foreign");
      expect(await readFile(lockPathIn(dir), "utf8")).toBe("{not json");
      expect(await residue(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("bounded wait refusal", () => {
  it("the refusal names the operation and the error code", () => {
    expect(fileLockedMessage("/p", "replace")).toContain("E_FILE_LOCKED");
    expect(fileLockedMessage("/p", "replace")).toContain("replace");
  });
});
