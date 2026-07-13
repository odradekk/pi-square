import { randomUUID } from "node:crypto";
import { existsSync, linkSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { artifactsDirFor } from "./artifacts";
import { createSubagentError, normalizeSubagentError } from "./errors";

interface LeaseOwner {
  token: string;
  pid: number;
  processStart?: string;
  createdAt: number;
}

export interface RunLease {
  id: string;
  owner: LeaseOwner;
  release(): void;
}

export type LeaseAcquireResult =
  | { acquired: true; lease: RunLease }
  | { acquired: false; owner?: LeaseOwner };

function leaseFileFor(id: string): string {
  return join(artifactsDirFor(id), ".active");
}

function processStartToken(pid: number): string | undefined {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = raw.lastIndexOf(")");
    if (close < 0) return undefined;
    const fieldsAfterCommand = raw.slice(close + 2).trim().split(/\s+/);
    return fieldsAfterCommand[19];
  } catch {
    return undefined;
  }
}

function processIsAlive(owner: LeaseOwner): boolean {
  try {
    process.kill(owner.pid, 0);
  } catch (error: any) {
    if (error?.code === "ESRCH") return false;
    return true;
  }
  if (!owner.processStart) return true;
  const currentStart = processStartToken(owner.pid);
  return currentStart === undefined || currentStart === owner.processStart;
}

function readOwner(leaseFile: string): LeaseOwner | undefined {
  try {
    const parsed = JSON.parse(readFileSync(leaseFile, "utf8"));
    if (!parsed || typeof parsed.token !== "string" || !Number.isInteger(parsed.pid)) return undefined;
    return parsed as LeaseOwner;
  } catch {
    return undefined;
  }
}

function removeLeaseFile(leaseFile: string): void {
  try {
    unlinkSync(leaseFile);
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function removeLeaseIfOwner(leaseFile: string, owner: LeaseOwner): boolean {
  const current = readOwner(leaseFile);
  if (current?.token !== owner.token) return false;
  removeLeaseFile(leaseFile);
  return true;
}

function installLeaseAtomically(id: string, owner: LeaseOwner): void {
  const artifactsDir = artifactsDirFor(id);
  const leaseFile = leaseFileFor(id);
  const temporary = join(artifactsDir, `.lease-${owner.pid}-${owner.token}.tmp`);
  try {
    writeFileSync(temporary, JSON.stringify(owner, null, 2), { encoding: "utf8", flag: "wx" });
    linkSync(temporary, leaseFile);
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      // A failed temporary-file cleanup does not change lease ownership.
    }
  }
}

export function tryAcquireRunLease(id: string): LeaseAcquireResult {
  const leaseFile = leaseFileFor(id);
  const owner: LeaseOwner = {
    token: randomUUID(),
    pid: process.pid,
    processStart: processStartToken(process.pid),
    createdAt: Date.now(),
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      installLeaseAtomically(id, owner);
      let released = false;
      return {
        acquired: true,
        lease: {
          id,
          owner,
          release() {
            if (released) return;
            released = true;
            const current = readOwner(leaseFile);
            if (current?.token !== owner.token) return;
            removeLeaseFile(leaseFile);
          },
        },
      };
    } catch (error: any) {
      if (error?.code !== "EEXIST") {
        throw normalizeSubagentError(error, {
          code: "PERSISTENCE_FAILED",
          message: "Unable to acquire the subagent activity lease.",
          operation: "persistence",
          id,
        });
      }

      const existing = readOwner(leaseFile);
      if (!existing || processIsAlive(existing)) {
        return { acquired: false, ...(existing ? { owner: existing } : {}) };
      }
      removeLeaseIfOwner(leaseFile, existing);
    }
  }

  throw createSubagentError({
    code: "PERSISTENCE_FAILED",
    message: "Unable to replace a stale subagent activity lease.",
    operation: "persistence",
    id,
    retryable: false,
  });
}

export function isRunLeaseActive(id: string): boolean {
  const leaseFile = leaseFileFor(id);
  if (!existsSync(leaseFile)) return false;
  const owner = readOwner(leaseFile);
  if (!owner) return true;
  if (processIsAlive(owner)) return true;
  return !removeLeaseIfOwner(leaseFile, owner);
}

export const __testables = {
  leaseFileFor,
  processStartToken,
  processIsAlive,
  readOwner,
  removeLeaseIfOwner,
};
