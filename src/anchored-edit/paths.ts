import { homedir } from "os";
import { fileURLToPath } from "url";
import { isAbsolute, resolve as resolvePath, join, dirname } from "path";


function homeBase(): string {
  const envHome = process.env.HOME;
  return envHome && envHome.length > 0 ? envHome : homedir();
}

function configBase(): string {
  if (process.platform !== "win32") {
    const xdg = process.env.XDG_CONFIG_HOME;
    if (xdg && xdg.length > 0) return xdg;
  }
  return join(homeBase(), ".config");
}

export function configDir(): string {
  return join(configBase(), "pi-hashline-edit-pro");
}

export function configPath(): string {
  return join(configDir(), "config.json");
}

export function hashStorePath(): string {
  return join(configDir(), "hash-store.sqlite");
}

export function projectHashStorePath(workspaceRoot: string): string {
  return join(workspaceRoot, ".pi", "anchored-edit", "hash-store.sqlite");
}

export function projectHashStoreDir(workspaceRoot: string): string {
  return dirname(projectHashStorePath(workspaceRoot));
}

export function legacyHashStorePath(): string {
  return join(configDir(), "hash-store.json");
}

export function hashStoreDir(): string {
  return dirname(hashStorePath());
}

/**
 * Unicode space characters Pi 0.84.2 folds to a plain space before resolving
 * a tool path (`utils/paths.ts` in the pinned package). Mirrored here so the
 * anchored tools resolve exactly the path the Pi factory resolved.
 */
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/**
 * Normalizes a tool path the way Pi 0.84.2's native file tools do: fold
 * unicode spaces, strip a leading `@` mention prefix, expand `~`/`~/` against
 * the home directory, and decode `file://` URLs. Native path authority
 * (#185): this is the shared resolution basis for anchored read, replace,
 * revert, and write-state handling, so the anchored surface accepts the same
 * paths as Pi's built-in tools instead of imposing a workspace-containment
 * rule.
 */
function expand(filePath: string): string {
  let normalized = filePath.replace(UNICODE_SPACES, " ");
  if (normalized.startsWith("@")) normalized = normalized.slice(1);
  const home = homeBase();
  if (normalized === "~") return home;
  if (normalized.startsWith("~/")) return home + normalized.slice(1);
  if (/^file:\/\//.test(normalized)) {
    try {
      return fileURLToPath(normalized);
    } catch {
      return normalized;
    }
  }
  return normalized;
}

export function toCwd(filePath: string, cwd: string): string {
  const expanded = expand(filePath);
  return isAbsolute(expanded) ? expanded : resolvePath(cwd, expanded);
}
