import { randomUUID } from "crypto";
import {
	lstat,
	mkdir,
	open,
	readlink,
	rename,
	stat,
	writeFile,
} from "fs/promises";
import { lstatSync, readlinkSync } from "fs";
import { dirname, join, parse, resolve, sep } from "path";
import { errCode } from "./utils";
import { createAtomicTempFile, unlinkIfSameNode, type FileIdentity } from "../core/safe-write.ts";

export async function resolveTarget(path: string): Promise<string> {
  const absolutePath = resolve(path);
  const { root } = parse(absolutePath);
  const parts = absolutePath
    .slice(root.length)
    .split(sep)
    .filter((part) => part.length > 0);
  const visitedSymlinks = new Set<string>();

  async function resParts(
    currentPath: string,
    remainingParts: string[],
  ): Promise<string> {
    if (remainingParts.length === 0) {
      return currentPath;
    }

    const [nextPart, ...tail] = remainingParts;
    const candidatePath = join(currentPath, nextPart);

    try {
      const candidateStats = await lstat(candidatePath);
      if (!candidateStats.isSymbolicLink()) {
        return resParts(candidatePath, tail);
      }

      if (visitedSymlinks.has(candidatePath)) {
        const error = new Error(
          `Too many symbolic links while resolving ${path}`,
        ) as NodeJS.ErrnoException;
        error.code = "ELOOP";
        throw error;
      }
      visitedSymlinks.add(candidatePath);

      const linkTargetPath = resolve(
        dirname(candidatePath),
        await readlink(candidatePath),
      );
      const targetParts = linkTargetPath
        .slice(parse(linkTargetPath).root.length)
        .split(sep)
        .filter((part) => part.length > 0);
      return resParts(parse(linkTargetPath).root, [
        ...targetParts,
        ...tail,
      ]);
    } catch (error: unknown) {
      if (errCode(error) === "ENOENT") {
        return join(candidatePath, ...tail);
      }
      throw error;
    }
  }

  return resParts(root, parts);
}

/**
 * Synchronous mirror of {@link resolveTarget}: the same symlink-walking
 * resolution with ENOENT passthrough on missing final components. Used by
 * the parent write's non-yielding operation, which must not interleave real
 * asynchronous I/O between target resolution and the filesystem commit.
 */
export function resolveTargetSync(path: string): string {
  const absolutePath = resolve(path);
  const { root } = parse(absolutePath);
  const parts = absolutePath
    .slice(root.length)
    .split(sep)
    .filter((part) => part.length > 0);
  const visitedSymlinks = new Set<string>();

  function resPartsSync(currentPath: string, remainingParts: string[]): string {
    if (remainingParts.length === 0) return currentPath;
    const [nextPart, ...tail] = remainingParts;
    const candidatePath = join(currentPath, nextPart);
    try {
      const candidateStats = lstatSync(candidatePath);
      if (!candidateStats.isSymbolicLink()) return resPartsSync(candidatePath, tail);
      if (visitedSymlinks.has(candidatePath)) {
        const error = new Error(`Too many symbolic links while resolving ${path}`) as NodeJS.ErrnoException;
        error.code = "ELOOP";
        throw error;
      }
      visitedSymlinks.add(candidatePath);
      const linkTargetPath = resolve(dirname(candidatePath), readlinkSync(candidatePath));
      const targetParts = linkTargetPath
        .slice(parse(linkTargetPath).root.length)
        .split(sep)
        .filter((part) => part.length > 0);
      return resPartsSync(parse(linkTargetPath).root, [...targetParts, ...tail]);
    } catch (error: unknown) {
      if (errCode(error) === "ENOENT") return join(candidatePath, ...tail);
      throw error;
    }
  }

  return resPartsSync(root, parts);
}

/**
 * Removes a temporary file this operation created, and only that file: the
 * removal is identity-checked against the inode this operation wrote, so a
 * path collision with any other directory entry can never delete data this
 * operation cannot prove it created. Directory-wide filename sweeping is
 * intentionally absent — anchored replace never inspects or deletes other
 * directory entries.
 */
async function removeOwnTemp(tempPath: string, identity: FileIdentity): Promise<void> {
  await unlinkIfSameNode(tempFail, tempPath, identity, {
    escaped: "E_TEMP_INVALID",
    invalid: "E_TEMP_INVALID",
  }).catch(() => {});
}

async function syncDir(dir: string): Promise<void> {
  if (process.platform === "win32") return;
  try {
    const handle = await open(dir, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
  }
}

function tempFail(code: string, message: string): Error {
  return new Error(`[${code}] ${message}`);
}

const TEMP_CODES = { escaped: "E_TEMP_INVALID", invalid: "E_TEMP_INVALID" } as const;

export async function writeAtomic(
  path: string,
  content: string,
): Promise<void> {
  const targetPath = await resolveTarget(path);

  let existingStats: Awaited<ReturnType<typeof stat>> | null = null;
  try {
    existingStats = await stat(targetPath);
  } catch (error: unknown) {
    if (errCode(error) !== "ENOENT") {
      throw error;
    }
  }

  if (existingStats && existingStats.nlink > 1) {
    // A multi-link target is written in place: a rename would sever the
    // sibling links from the new content.
    await writeFile(targetPath, content, "utf-8");
    return;
  }

  const dir = dirname(targetPath);
  const tempPath = join(dir, `.tmp-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  const mode = existingStats ? existingStats.mode & 0o7777 : 0o600;
  const tempIdentity = await createAtomicTempFile(tempFail, TEMP_CODES, tempPath, content, mode);
  try {
    await rename(tempPath, targetPath);
    await syncDir(dir);
  } catch (error: unknown) {
    if (process.platform === "win32" && errCode(error) === "EPERM") {
      try {
        await writeFile(targetPath, content, "utf-8");
        return;
      } finally {
        await removeOwnTemp(tempPath, tempIdentity);
      }
    }
    await removeOwnTemp(tempPath, tempIdentity);
    throw error;
  }
}
