import { isWindowsPlatform } from "../shell/platform";

const BUILT_IN_TOOL_NAMES = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;
const NON_SHELL_BUILT_INS = BUILT_IN_TOOL_NAMES.filter((name) => name !== "bash");

type BuiltInToolName = typeof BUILT_IN_TOOL_NAMES[number];

export interface SubagentToolSelection {
  tools?: string[];
  extensionTools?: string[];
}

export interface ResolvedSubagentTools {
  builtInTools: string[];
  extensionTools: string[];
  persistedTools: string[];
  persistedExtensionTools: string[];
  errors: string[];
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function isBuiltInTool(value: string): value is BuiltInToolName {
  return (BUILT_IN_TOOL_NAMES as readonly string[]).includes(value);
}

export function resolveSubagentTools(
  input: SubagentToolSelection,
  platform: NodeJS.Platform = process.platform,
): ResolvedSubagentTools {
  const windows = isWindowsPlatform(platform);
  const requestedTools = (input.tools ?? []).map((name) => name.trim()).filter(Boolean);
  const requestedExtensionTools = (input.extensionTools ?? []).map((name) => name.trim()).filter(Boolean);
  const useDefaults = requestedTools.length === 0;
  const legacyPortableShell = requestedTools.includes("bash") && requestedExtensionTools.includes("pwsh");
  const legacyDefaultTools = requestedTools.length === BUILT_IN_TOOL_NAMES.length
    && BUILT_IN_TOOL_NAMES.every((name) => requestedTools.includes(name));
  const shellRequested = useDefaults || requestedTools.includes("shell") || legacyPortableShell || legacyDefaultTools;
  const errors: string[] = [];
  const builtInTools: string[] = [];
  const extensionTools: string[] = [];
  const persistedTools: string[] = [];
  const persistedExtensionTools: string[] = [];

  const toolsToResolve = useDefaults ? [...NON_SHELL_BUILT_INS] : requestedTools;
  for (const rawName of toolsToResolve) {
    if (rawName === "shell") {
      if (!persistedTools.includes("shell")) persistedTools.push("shell");
      continue;
    }
    if (rawName === "bash" && (legacyPortableShell || legacyDefaultTools)) {
      if (!persistedTools.includes("shell")) persistedTools.push("shell");
      continue;
    }
    if (!isBuiltInTool(rawName)) {
      errors.push(`Unsupported tool '${rawName}'. Supported built-in tools: ${BUILT_IN_TOOL_NAMES.join(", ")}, shell.`);
      continue;
    }
    if (rawName === "bash" && windows) {
      errors.push("bash is unavailable on Windows; use tools: [shell] to select pwsh.");
      continue;
    }
    if (!builtInTools.includes(rawName)) builtInTools.push(rawName);
    if (!persistedTools.includes(rawName)) persistedTools.push(rawName);
  }

  if (useDefaults && !persistedTools.includes("shell")) persistedTools.push("shell");

  for (const rawName of requestedExtensionTools) {
    if (rawName === "pwsh" && legacyPortableShell) continue;
    if (rawName === "shell") {
      errors.push("Virtual tool 'shell' must be listed under tools, not extensionTools.");
      continue;
    }
    if (isBuiltInTool(rawName)) {
      errors.push(`Built-in tool '${rawName}' must be listed under tools, not extensionTools.`);
      continue;
    }
    if (rawName === "pwsh" && !windows) {
      errors.push("pwsh is available only on Windows; use tools: [shell] to select bash.");
      continue;
    }
    if (!extensionTools.includes(rawName)) extensionTools.push(rawName);
    if (!persistedExtensionTools.includes(rawName)) persistedExtensionTools.push(rawName);
  }

  if (shellRequested) {
    if (!persistedTools.includes("shell")) persistedTools.push("shell");
    if (windows) {
      if (!extensionTools.includes("pwsh")) extensionTools.push("pwsh");
    } else if (!builtInTools.includes("bash")) {
      builtInTools.push("bash");
    }
  }

  return {
    builtInTools: unique(builtInTools),
    extensionTools: unique(extensionTools),
    persistedTools: unique(persistedTools),
    persistedExtensionTools: unique(persistedExtensionTools),
    errors,
  };
}
