import { spawnSync } from "node:child_process";
import type { GitSnapshot } from "./types.ts";

const EMPTY: GitSnapshot = { branch: null, dirty: false, staged: 0, unstaged: 0, untracked: 0 };

export function refreshGitSnapshot(cwd: string): GitSnapshot {
  const branch = gitBranch(cwd);
  if (!branch) return EMPTY;

  const status = gitStatus(cwd);
  return {
    branch,
    dirty: status.staged + status.unstaged + status.untracked > 0,
    staged: status.staged,
    unstaged: status.unstaged,
    untracked: status.untracked,
  };
}

function gitBranch(cwd: string): string | null {
  const result = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd,
    encoding: "utf8",
    timeout: 2000,
  });
  if (result.status !== 0) return null;
  return result.stdout.trim() || null;
}

function gitStatus(cwd: string): { staged: number; unstaged: number; untracked: number } {
  const result = spawnSync("git", ["status", "--porcelain=v1"], {
    cwd,
    encoding: "utf8",
    timeout: 3000,
  });
  if (result.status !== 0) return { staged: 0, unstaged: 0, untracked: 0 };

  let staged = 0;
  let unstaged = 0;
  let untracked = 0;

  for (const line of result.stdout.split("\n")) {
    if (!line || line.length < 2) continue;
    const x = line[0];
    const y = line[1];
    if (x === "?" && y === "?") {
      untracked += 1;
      continue;
    }
    if (x !== " " && x !== "?") staged += 1;
    if (y !== " " && y !== "?") unstaged += 1;
  }

  return { staged, unstaged, untracked };
}
