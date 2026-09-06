import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { isWindowsPlatform } from "./shell/platform";
import { createPwshToolDefinition } from "./shell/tools/pwsh";
import { createLibraryDocsToolDefinition } from "./web/tools/library-docs";
import { createLibrarySearchToolDefinition } from "./web/tools/library-search";
import { createWebFetchToolDefinition } from "./web/tools/web-fetch";
import { createWebSearchToolDefinition } from "./web/tools/web-search";

const BASE_EXTENSION_TOOLS = [
  "web_search",
  "web_fetch",
  "library_search",
  "library_docs",
] as const;

type SupportedExtensionTool = typeof BASE_EXTENSION_TOOLS[number] | "pwsh";

export function extensionToolNamesForPlatform(platform: NodeJS.Platform = process.platform): SupportedExtensionTool[] {
  return isWindowsPlatform(platform) ? [...BASE_EXTENSION_TOOLS, "pwsh"] : [...BASE_EXTENSION_TOOLS];
}

function createDefinitions(platform: NodeJS.Platform, _cwd?: string): Map<SupportedExtensionTool, ToolDefinition> {
  // _cwd is reserved for composing a child read factory for the child's working
  // directory (the anchored-read follow-up); no shipped child tool consumes it yet.
  const definitions = new Map<SupportedExtensionTool, ToolDefinition>([
    ["web_search", createWebSearchToolDefinition() as ToolDefinition],
    ["web_fetch", createWebFetchToolDefinition() as ToolDefinition],
    ["library_search", createLibrarySearchToolDefinition() as ToolDefinition],
    ["library_docs", createLibraryDocsToolDefinition() as ToolDefinition],
  ]);
  if (isWindowsPlatform(platform)) definitions.set("pwsh", createPwshToolDefinition() as ToolDefinition);
  return definitions;
}

export function createChildTools(
  names: readonly string[],
  platform: NodeJS.Platform = process.platform,
  cwd?: string,
): {
  definitions: ToolDefinition[];
  errors: string[];
} {
  const available = createDefinitions(platform, cwd);
  const supported = extensionToolNamesForPlatform(platform);
  const definitions: ToolDefinition[] = [];
  const errors: string[] = [];
  for (const name of [...new Set(names)]) {
    const definition = available.get(name as SupportedExtensionTool);
    if (!definition) {
      errors.push(`Unsupported extension tool '${name}'. Supported extension tools: ${supported.join(", ")}.`);
      continue;
    }
    definitions.push(definition);
  }
  return { definitions, errors };
}

/**
 * Shadow-safe extension tool subset (odradekk/pi-square#156): the strictly
 * read-only evidence tools a Shadow child session may receive. Platform
 * shells and every side-effect capability stay delegated-and-Shadow-excluded;
 * Shadow policy additionally enforces this list before names ever reach
 * `createChildTools`.
 */
export const SHADOW_SAFE_EXTENSION_TOOLS = [
  "web_search",
  "web_fetch",
  "library_search",
  "library_docs",
] as const;

/** Resolves Shadow-safe extension tools from the child-safe factories only. */
export function createShadowSafeExtensionTools(names: readonly string[]): ToolDefinition[] {
  const allowed = new Set<string>(SHADOW_SAFE_EXTENSION_TOOLS);
  const requested = [...new Set(names)];
  return createChildTools(requested.filter((name) => allowed.has(name))).definitions;
}

export const childToolNames = extensionToolNamesForPlatform();
