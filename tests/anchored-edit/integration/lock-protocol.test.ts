import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "fs/promises";
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "path";
import {
  __lockTestables,
  acquireFileLock,
  fileLockedMessage,
  lockFilePath,
} from "../../../src/anchored-edit/file-lock";
import { getWritableTempRoot } from "../support/fixtures";

const { lockBarrier } = __lockTestables;

afterEach(() => {
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

/** Publishes a complete owner record for `pid` at the lock path, the way a
 *  real process would. */
async function installRecord(
  dir: string,
  owner: { pid: number; hostname: string; startTime?: string; token?: string },
): Promise<void> {
  await writeFile(
    lockPathIn(dir),
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

describe("lock record validation (#264 P1: strict schema, fail closed)", () => {
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
    expect(isCompleteOwnerRecord({ ...complete, startTime: "123" })).toBe(true);
    expect(isCompleteOwnerRecord({ ...complete, v: 2 })).toBe(false);
    expect(isCompleteOwnerRecord({ ...complete, token: "" })).toBe(false);
    expect(isCompleteOwnerRecord({ ...complete, token: "t".repeat(129) })).toBe(false);
    expect(isCompleteOwnerRecord({ ...complete, pid: 0 })).toBe(false);
    expect(isCompleteOwnerRecord({ ...complete, pid: 1.5 })).toBe(false);
    expect(isCompleteOwnerRecord({ ...complete, pid: -1 })).toBe(false);
    expect(isCompleteOwnerRecord({ ...complete, hostname: "" })).toBe(false);
    expect(isCompleteOwnerRecord({ ...complete, acquiredAt: Number.NaN })).toBe(false);
    expect(isCompleteOwnerRecord({ ...complete, acquiredAt: "now" })).toBe(false);
    expect(isCompleteOwnerRecord({ ...complete, startTime: 123 })).toBe(false);
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
});

describe("dead-owner determination (#264 P1: positive proof only)", () => {
  it("never reclaims a foreign-host record regardless of age or pid state", async () => {
    const dir = await freshDir("foreign");
    try {
      await installRecord(dir, { pid: deadPid(), hostname: "another-host.example" });
      const lock = await acquireFileLock(lockPathIn(dir), { waitMs: 60, pollMs: 10 });
      expect(lock).toBeNull();
      expect(existsSync(lockPathIn(dir))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reclaims a confirmed-dead local owner and then acquires", async () => {
    const dir = await freshDir("dead");
    try {
      await installRecord(dir, { pid: deadPid(), hostname: hostname() });
      const lock = await acquireFileLock(lockPathIn(dir), { waitMs: 2000, pollMs: 10 });
      expect(lock).not.toBeNull();
      await lock!.release();
      expect(existsSync(lockPathIn(dir))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("never reclaims a live local owner", async () => {
    const dir = await freshDir("live");
    try {
      await installRecord(dir, { pid: process.pid, hostname: hostname() });
      const lock = await acquireFileLock(lockPathIn(dir), { waitMs: 60, pollMs: 10 });
      expect(lock).toBeNull();
      expect(existsSync(lockPathIn(dir))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a start-time mismatch proves the original died even though the pid is alive again", () => {
    const { isOwnerGone } = __lockTestables;
    // A live pid (this process) whose recorded start time differs: the
    // recorded owner must be proven dead by the mismatch.
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
    // Without a comparable start time the decision falls back to the OS
    // liveness probe, and this process is alive.
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

describe("lock publication (#264 P1: atomic no-clobber or fail closed)", () => {
  it("never clobbers an existing lock and reports it as held", async () => {
    const dir = await freshDir("publish-held");
    try {
      await installRecord(dir, { pid: process.pid, hostname: hostname() });
      const identity = await __lockTestables.publishOwnerRecord(
        lockPathIn(dir),
        JSON.stringify(__lockTestables.currentOwnerRecord()),
      );
      expect(identity).toBeUndefined();
      // The existing holder's record is intact.
      const raw = JSON.parse(await readFile(lockPathIn(dir), "utf8")) as { pid: number };
      expect(raw.pid).toBe(process.pid);
      // And no publish temporaries were left behind.
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
      // No leftover publish temporaries in the (now read-only) directory.
      expect((await readdir(join(dir, "locks"))).filter((name) => name.startsWith(".publish-"))).toEqual([]);
    } finally {
      await chmod(join(dir, "locks"), 0o700).catch(() => {});
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("verified removal and the successor race (#264 P1: rename-take + identity)", () => {
  it("removes exactly the file it verified", async () => {
    const dir = await freshDir("remove-own");
    try {
      await installRecord(dir, { pid: process.pid, hostname: hostname(), token: "verified-token" });
      const verified = await stat(lockPathIn(dir));
      await __lockTestables.removeVerifiedLockFile(lockPathIn(dir), verified, "verified-token", 5);
      expect(existsSync(lockPathIn(dir))).toBe(false);
      expect((await readdir(join(dir, "locks"))).filter((name) => name.includes(".retired-"))).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a removal that takes a successor-installed file restores it intact instead of deleting it (#264 P1)", async () => {
    const dir = await freshDir("successor");
    try {
      const dead = deadPid();
      await installRecord(dir, { pid: dead, hostname: hostname(), token: "verified-token" });
      // The verifier proved this exact file (a dead owner's record)...
      const verified = await stat(lockPathIn(dir));
      // ...but another reclaimer removed it first and a successor installed a
      // different file at the lock path before this removal's take.
      await rm(lockPathIn(dir), { force: true });
      await installRecord(dir, { pid: process.pid, hostname: hostname(), token: "successor-token" });

      await __lockTestables.removeVerifiedLockFile(lockPathIn(dir), verified, "verified-token", 5);

      // The taken file was foreign: it was restored under its name with its
      // content intact, never deleted. The take freed the path, so the
      // restore completes and leaves no residue.
      const successor = JSON.parse(await readFile(lockPathIn(dir), "utf8")) as { token: string };
      expect(successor.token).toBe("successor-token");
      expect((await readdir(join(dir, "locks"))).filter((name) => name.includes(".retired-"))).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a foreign file taken while another successor holds the path is preserved, never destroyed (#264 P1)", async () => {
    const dir = await freshDir("successor-occupied");
    // Keep the restore budget short: the occupying successor stays installed
    // for the whole test, so the removal ends at the budget with the foreign
    // file preserved at its retirement name.
    vi.stubEnv("PI_SQUARE_LOCK_RESTORE_MS", "80");
    try {
      const dead = deadPid();
      await installRecord(dir, { pid: dead, hostname: hostname(), token: "verified-token" });
      const verified = await stat(lockPathIn(dir));
      // A first replacement occupies the path before this removal's take...
      await rm(lockPathIn(dir), { force: true });
      await installRecord(dir, { pid: process.pid, hostname: hostname(), token: "taken-token" });
      // ...and a second successor installs after the take, while the taken
      // file is between the atomic rename and the identity/token check.
      lockBarrier.afterTake = async () => {
        await installRecord(dir, { pid: process.pid, hostname: hostname(), token: "occupier-token" });
      };

      await __lockTestables.removeVerifiedLockFile(lockPathIn(dir), verified, "verified-token", 5);

      // The occupier was not deleted and still holds its own record.
      const occupier = JSON.parse(await readFile(lockPathIn(dir), "utf8")) as { token: string };
      expect(occupier.token).toBe("occupier-token");
      // The taken foreign file was preserved at its retirement name, not
      // destroyed, while the lock path stayed occupied past the budget.
      const retiredName = (await readdir(join(dir, "locks"))).find((name) => name.includes(".retired-"));
      expect(retiredName).toBeDefined();
      const retiredRaw = JSON.parse(await readFile(join(dir, "locks", retiredName!), "utf8")) as { token: string };
      expect(retiredRaw.token).toBe("taken-token");
    } finally {
      lockBarrier.afterTake = undefined;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("release of a live acquisition always matches and removes exactly its own file", async () => {
    const dir = await freshDir("release-own");
    try {
      const lock = await acquireFileLock(lockPathIn(dir), { waitMs: 500 });
      expect(lock).not.toBeNull();
      await lock!.release();
      expect(existsSync(lockPathIn(dir))).toBe(false);
      expect(
        (await readdir(join(dir, "locks"))).filter((name) => name.endsWith(".lock") || name.includes(".retired-")),
      ).toEqual([]);
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
