import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createSearchToolDefinitions } from "./search";
import { createSchemeEvalToolDefinition } from "./scheme/tools/scheme-eval";
import { createPwshToolDefinition } from "./shell/tools/pwsh";
import { createDocsToolDefinition } from "./web/tools/docs";
import { createFetchToolDefinition } from "./web/tools/fetch";
import { createLibsToolDefinition } from "./web/tools/libs";
import { createSearchToolDefinition } from "./web/tools/search";

const SUPPORTED_EXTENSION_TOOLS = [
  "rg",
  "fd",
  "search",
  "fetch",
  "libs",
  "docs",
  "scheme_eval",
  "pwsh",
] as const;

type SupportedExtensionTool = typeof SUPPORTED_EXTENSION_TOOLS[number];

function createDefinitions(): Map<SupportedExtensionTool, ToolDefinition> {
  const [rg, fd] = createSearchToolDefinitions();
  return new Map<SupportedExtensionTool, ToolDefinition>([
    ["rg", rg as ToolDefinition],
    ["fd", fd as ToolDefinition],
    ["search", createSearchToolDefinition() as ToolDefinition],
    ["fetch", createFetchToolDefinition() as ToolDefinition],
    ["libs", createLibsToolDefinition() as ToolDefinition],
    ["docs", createDocsToolDefinition() as ToolDefinition],
    ["scheme_eval", createSchemeEvalToolDefinition() as ToolDefinition],
    ["pwsh", createPwshToolDefinition() as ToolDefinition],
  ]);
}

export function createChildTools(names: readonly string[]): {
  definitions: ToolDefinition[];
  errors: string[];
} {
  const available = createDefinitions();
  const definitions: ToolDefinition[] = [];
  const errors: string[] = [];
  for (const name of [...new Set(names)]) {
    const definition = available.get(name as SupportedExtensionTool);
    if (!definition) {
      errors.push(`Unsupported extension tool '${name}'. Supported extension tools: ${SUPPORTED_EXTENSION_TOOLS.join(", ")}.`);
      continue;
    }
    definitions.push(definition);
  }
  return { definitions, errors };
}

export const childToolNames = [...SUPPORTED_EXTENSION_TOOLS];
