import type { BigIntStats } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

export const DISPLAY_FILE_PREVIEW_MAX_BYTES = 1_000_000;

export type DisplayFilePreview =
  | {
      readonly kind: "create";
      readonly path: string;
      readonly after: string;
    }
  | {
      readonly kind: "overwrite";
      readonly path: string;
      readonly before: string;
      readonly after: string;
      readonly projected: true;
    }
  | {
      readonly kind: "metadata";
      readonly path: string;
      readonly reason: "outside" | "unresolved" | "non-regular" | "oversized" | "binary" | "changed" | "unreadable";
      readonly size?: number;
    };

function within(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

interface Identity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

function identity(stats: BigIntStats): Identity {
  return {
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs,
  };
}

function sameIdentity(left: Identity, right: Identity): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function decodeTextPreview(bytes: Uint8Array): string | undefined {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
  if (text.includes("\0")) return undefined;
  let controls = 0;
  let units = 0;
  for (const character of text) {
    units += 1;
    const point = character.codePointAt(0)!;
    if (
      (point <= 0x08)
      || point === 0x0b
      || (point >= 0x0e && point <= 0x1f)
      || (point >= 0x7f && point <= 0x9f)
    ) controls += 1;
  }
  return controls > Math.max(1, Math.floor(units / 10)) ? undefined : text;
}

export async function inspectWritePreview(
  cwd: string,
  requestedPath: string,
  after: string,
): Promise<DisplayFilePreview> {
  const requested = requestedPath.trim();
  if (!requested) return { kind: "metadata", path: "", reason: "unresolved" };

  let workspace: string;
  try {
    workspace = await realpath(cwd);
  } catch {
    return { kind: "metadata", path: requested, reason: "unresolved" };
  }
  const lexicalTarget = resolve(workspace, requested);
  if (!within(workspace, lexicalTarget)) return { kind: "metadata", path: requested, reason: "outside" };

  let target: string;
  try {
    target = await realpath(lexicalTarget);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return { kind: "metadata", path: requested, reason: "unreadable" };
    }
    const parent = resolve(lexicalTarget, "..");
    try {
      const canonicalParent = await realpath(parent);
      if (!within(workspace, canonicalParent)) return { kind: "metadata", path: requested, reason: "outside" };
      target = join(canonicalParent, basename(lexicalTarget));
      return { kind: "create", path: relative(workspace, target).split(sep).join("/"), after };
    } catch {
      return { kind: "metadata", path: requested, reason: "unresolved" };
    }
  }

  if (!within(workspace, target)) return { kind: "metadata", path: requested, reason: "outside" };
  const displayPath = relative(workspace, target).split(sep).join("/") || ".";

  let beforeStats: BigIntStats;
  try {
    beforeStats = await stat(target, { bigint: true });
  } catch {
    return { kind: "metadata", path: displayPath, reason: "unreadable" };
  }
  if (!beforeStats.isFile()) return { kind: "metadata", path: displayPath, reason: "non-regular" };
  if (beforeStats.size > BigInt(DISPLAY_FILE_PREVIEW_MAX_BYTES)) {
    return { kind: "metadata", path: displayPath, reason: "oversized", size: Number(beforeStats.size) };
  }

  const beforeIdentity = identity(beforeStats);
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(target, "r");
    const bytes = await file.readFile();
    if (bytes.byteLength > DISPLAY_FILE_PREVIEW_MAX_BYTES) {
      return { kind: "metadata", path: displayPath, reason: "oversized", size: bytes.byteLength };
    }
    const afterStats = await stat(target, { bigint: true });
    if (!sameIdentity(beforeIdentity, identity(afterStats))) {
      return { kind: "metadata", path: displayPath, reason: "changed", size: Number(afterStats.size) };
    }
    const before = decodeTextPreview(bytes);
    if (before === undefined) {
      return { kind: "metadata", path: displayPath, reason: "binary", size: bytes.byteLength };
    }
    return {
      kind: "overwrite",
      path: displayPath,
      before,
      after,
      projected: true,
    };
  } catch {
    return { kind: "metadata", path: displayPath, reason: "unreadable" };
  } finally {
    try {
      await file?.close();
    } catch {
      // Preview inspection has already completed; a close failure must not expose file content or crash rendering.
    }
  }
}
