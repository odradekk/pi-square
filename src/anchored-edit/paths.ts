import { homedir } from "os";
import { fileURLToPath } from "url";
import { dirname, join, posix, win32 } from "path";


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

/** Convert Git Bash, MSYS, Cygwin, and WSL drive paths exactly as Pi
 * 0.84.2 does before native Windows resolution. Exported for injected-platform
 * contract tests; production callers use `toCwd()` with `process.platform`. */
export function normalizeWindowsShellPath(filePath: string): string {
  if (!filePath.startsWith("/") || filePath.startsWith("//") || filePath.includes("\\")) return filePath;
  const match = filePath.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
  if (!match) return filePath;
  const suffix = match[2]?.replaceAll("/", "\\");
  return `${match[1]!.toUpperCase()}:\\${suffix ?? ""}`;
}

export interface NativePathOptions {
  platform?: NodeJS.Platform;
  homeDir?: string;
}

/**
 * Normalizes and resolves a tool path the way Pi 0.84.2's native file tools
 * do: fold unicode spaces, strip a leading `@` mention prefix, normalize
 * Windows shell drive forms, expand `~`, decode `file://` URLs, and resolve
 * relative paths against cwd. Native path authority (#185): anchored tools
 * must resolve the same target as Pi's built-in tools on every supported
 * platform rather than only matching the current host.
 */
export function toCwd(filePath: string, cwd: string, options: NativePathOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const pathApi = platform === "win32" ? win32 : posix;
  let normalized = filePath.replace(UNICODE_SPACES, " ");
  if (normalized.startsWith("@")) normalized = normalized.slice(1);
  if (platform === "win32") normalized = normalizeWindowsShellPath(normalized);

  const home = options.homeDir ?? homeBase();
  if (normalized === "~") {
    normalized = home;
  } else if (normalized.startsWith("~/") || (platform === "win32" && normalized.startsWith("~\\"))) {
    normalized = pathApi.join(home, normalized.slice(2));
  }

  if (/^file:\/\//.test(normalized)) {
    try {
      normalized = fileURLToPath(normalized);
    } catch {
      // Preserve the unresolved value so the native filesystem operation owns
      // the final failure, matching the prior anchored behavior.
    }
  }

  return pathApi.isAbsolute(normalized) ? pathApi.resolve(normalized) : pathApi.resolve(cwd, normalized);
}
