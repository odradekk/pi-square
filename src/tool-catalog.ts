import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createSearchToolDefinitions } from "./search";
import { createSchemeToolDefinition } from "./scheme/tools/scheme";
import { isWindowsPlatform } from "./shell/platform";
import { createPwshToolDefinition } from "./shell/tools/pwsh";
import { createDocsToolDefinition } from "./web/tools/docs";
import { createFetchToolDefinition } from "./web/tools/fetch";
import { createLibsToolDefinition } from "./web/tools/libs";
import { createSearchToolDefinition } from "./web/tools/search";

const BASE_EXTENSION_TOOLS = [
  "rg",
  "fd",
  "search",
  "fetch",
  "libs",
  "docs",
  "scheme",
] as const;

type SupportedExtensionTool = typeof BASE_EXTENSION_TOOLS[number] | "pwsh";

export function extensionToolNamesForPlatform(platform: NodeJS.Platform = process.platform): SupportedExtensionTool[] {
  return isWindowsPlatform(platform) ? [...BASE_EXTENSION_TOOLS, "pwsh"] : [...BASE_EXTENSION_TOOLS];
}

function createDefinitions(platform: NodeJS.Platform): Map<SupportedExtensionTool, ToolDefinition> {
  const [rg, fd] = createSearchToolDefinitions();
  const definitions = new Map<SupportedExtensionTool, ToolDefinition>([
    ["rg", rg as ToolDefinition],
    ["fd", fd as ToolDefinition],
    ["search", createSearchToolDefinition() as ToolDefinition],
    ["fetch", createFetchToolDefinition() as ToolDefinition],
    ["libs", createLibsToolDefinition() as ToolDefinition],
    ["docs", createDocsToolDefinition() as ToolDefinition],
    ["scheme", createSchemeToolDefinition() as ToolDefinition],
  ]);
  if (isWindowsPlatform(platform)) definitions.set("pwsh", createPwshToolDefinition() as ToolDefinition);
  return definitions;
}

export function createChildTools(
  names: readonly string[],
  platform: NodeJS.Platform = process.platform,
): {
  definitions: ToolDefinition[];
  errors: string[];
} {
  const available = createDefinitions(platform);
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

export const childToolNames = extensionToolNamesForPlatform();
