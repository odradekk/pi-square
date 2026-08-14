import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createCodeGraphDefinition } from "./codegraph";
import {
  createGitHubCommitToolDefinition,
  createGitHubReadToolDefinition,
  createGitHubSearchToolDefinition,
  createGitHubTreeToolDefinition,
} from "./github/tools";
import { createPdfSearchToolDefinition } from "./pdf-search";
import { createSearchToolDefinitions } from "./search";
import { isWindowsPlatform } from "./shell/platform";
import { createPwshToolDefinition } from "./shell/tools/pwsh";
import { createDocsToolDefinition } from "./web/tools/docs";
import { createFetchToolDefinition } from "./web/tools/fetch";
import { createLibsToolDefinition } from "./web/tools/libs";
import { createSearchToolDefinition } from "./web/tools/search";

const BASE_EXTENSION_TOOLS = [
  "rg",
  "fd",
  "codegraph",
  "pdf_search",
  "search",
  "fetch",
  "libs",
  "docs",
  "github_search",
  "github_read",
  "github_tree",
  "github_commit",
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
    ["codegraph", createCodeGraphDefinition(false) as ToolDefinition],
    ["pdf_search", createPdfSearchToolDefinition() as ToolDefinition],
    ["search", createSearchToolDefinition() as ToolDefinition],
    ["fetch", createFetchToolDefinition() as ToolDefinition],
    ["libs", createLibsToolDefinition() as ToolDefinition],
    ["docs", createDocsToolDefinition() as ToolDefinition],
    ["github_search", createGitHubSearchToolDefinition() as ToolDefinition],
    ["github_read", createGitHubReadToolDefinition() as ToolDefinition],
    ["github_tree", createGitHubTreeToolDefinition() as ToolDefinition],
    ["github_commit", createGitHubCommitToolDefinition() as ToolDefinition],
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
