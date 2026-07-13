import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function looksLikeAgentDir(dir: string): boolean {
  return (
    existsSync(join(dir, "settings.json")) &&
    (existsSync(join(dir, "packages")) ||
      existsSync(join(dir, "rules")) ||
      existsSync(join(dir, "themes")) ||
      existsSync(join(dir, "auth.json")))
  );
}

function findAgentDirFrom(startDir: string): string | null {
  let current = resolve(startDir);
  while (true) {
    if (looksLikeAgentDir(current)) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Resolve the Pi agent home directory, independent of the current project cwd.
 * Priority: PI_AGENT_DIR env (also the test seam) → module-path walk → ~/.pi/agent.
 */
export function getAgentDir(): string {
  const envDir = process.env.PI_AGENT_DIR;
  if (envDir) return resolve(envDir);

  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const discovered = findAgentDirFrom(moduleDir);
  if (discovered) return discovered;

  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (home) return join(home, ".pi", "agent");

  throw new Error("Unable to resolve Pi agent directory");
}

/**
 * Canonical persistence root for subagent run artifacts, anchored to the agent
 * home rather than any project cwd.
 */
export function subagentsStateRoot(): string {
  return join(getAgentDir(), "state", "subagents");
}
