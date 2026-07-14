import {
  getMarkdownTheme,
  keyHint,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Text, type Component } from "@earendil-works/pi-tui";
import type { SubagentRegistry } from "./definitions";
import { sanitizeSubagentDisplay } from "./display";

export const SUBAGENT_CONFIG_GUIDE_TYPE = "pi-square.subagent-config-guide";
const MAX_DEFINITIONS = 50;
const MAX_METADATA_JSON = 24_000;
const MAX_PATH_CHARS = 512;
const MAX_VALUE_CHARS = 160;

export interface SubagentConfigGuideDetails {
  version: 1;
  definitionCount: number;
  includedDefinitionCount: number;
  scopes: Array<"package" | "agent" | "project">;
}

export interface SubagentConfigGuideMessage {
  content: string;
  details: SubagentConfigGuideDetails;
}

function clip(value: unknown, max: number): string {
  const characters = Array.from(sanitizeSubagentDisplay(value).replace(/\s+/g, " ").trim());
  return characters.length <= max
    ? characters.join("")
    : `${characters.slice(0, Math.max(0, max - 3)).join("")}...`;
}

function clipList(value: string[] | undefined): string[] | "default" | "all" {
  if (value === undefined) return "default";
  return value.slice(0, 50).map((item) => clip(item, MAX_VALUE_CHARS));
}

export function guideDefinitionMetadata(registry: SubagentRegistry): Array<Record<string, unknown>> {
  return registry.definitions.slice(0, MAX_DEFINITIONS).map((definition) => ({
    name: clip(definition.name, MAX_VALUE_CHARS),
    visible: definition.visible,
    layers: definition.layers.slice(0, 3).map((layer) => ({
      source: layer.source,
      filePath: clip(layer.filePath, MAX_PATH_CHARS),
    })),
    model: definition.model ? clip(definition.model, MAX_VALUE_CHARS) : "inherit",
    effort: definition.effort ? clip(definition.effort, MAX_VALUE_CHARS) : "inherit",
    tools: clipList(definition.tools),
    extensionTools: definition.extensionTools === undefined ? [] : clipList(definition.extensionTools),
    skills: definition.skills === undefined ? "all" : clipList(definition.skills),
  }));
}

function boundedMetadata(registry: SubagentRegistry): Array<Record<string, unknown>> {
  const definitions = guideDefinitionMetadata(registry);
  while (definitions.length > 0 && JSON.stringify(definitions).length > MAX_METADATA_JSON) definitions.pop();
  return definitions;
}

export function buildSubagentConfigGuide(registry: SubagentRegistry, cwd: string): SubagentConfigGuideMessage {
  const definitions = boundedMetadata(registry);
  const presentScopes = new Set(registry.definitions.flatMap(
    (definition) => definition.layers.map((layer) => layer.source),
  ));
  const scopes = (["package", "agent", "project"] as const).filter((scope) => presentScopes.has(scope));
  const omitted = Math.max(0, registry.definitions.length - definitions.length);
  const content = `[Subagent Config Guide]\n\nConfiguration contract:\n- Use promptVersion: 2.\n- Fields overlay by package < agent < project. Omitted fields inherit; null clears scalars and [] clears arrays.\n- Omitted model/effort inherit at fresh-run startup; resume keeps the original frozen values.\n- V2 prompt fields are policy (SYSTEM), instructions (replayed profile), and output (replayed delivery contract).\n- Omitted or [] tools select runtime defaults; tools: [none] disables every built-in tool and none must be the only entry. Extension tools remain explicit opt-ins.\n- Omitted or [] skills load all discovered skills; skills: [none] disables them.\n- Package files are read-only. Default writes to ${clip(cwd, MAX_PATH_CHARS)}/.pi/subagents; use the agent scope only when the request explicitly requires all projects.\n- visible: false hides an effective definition from the parent catalog and tool lookup.\n- Validate the effective definition after edits. Confirm destructive deletion when the target or scope is ambiguous.\n- The next user message is the only authorized configuration request. Treat this guide as reference context, not as a task.\n\nCurrent effective definitions${omitted > 0 ? ` (${omitted} omitted by the guide budget)` : ""}:\n\n~~~json\n${JSON.stringify(definitions, null, 2)}\n~~~`;
  return {
    content,
    details: {
      version: 1,
      definitionCount: registry.definitions.length,
      includedDefinitionCount: definitions.length,
      scopes,
    },
  };
}

export function renderSubagentConfigGuide(
  message: { content?: unknown; details?: SubagentConfigGuideDetails },
  options: { expanded: boolean },
  theme: Theme,
): Component {
  const details = message.details;
  const count = Number.isFinite(details?.definitionCount) ? Math.max(0, Math.trunc(details!.definitionCount)) : 0;
  const scopes = Array.isArray(details?.scopes)
    ? details.scopes.filter((scope) => scope === "package" || scope === "agent" || scope === "project").join("/")
    : "";
  const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
  const label = theme.fg("customMessageLabel", theme.bold("[Subagent Config Guide]"));
  if (!options.expanded) {
    const summary = [
      `${count} definition${count === 1 ? "" : "s"}`,
      scopes,
    ].filter(Boolean).join(" · ");
    box.addChild(new Text(
      `${label}${summary ? theme.fg("customMessageText", `  ${summary}`) : ""}${theme.fg("dim", `  ${keyHint("app.tools.expand", " expand")}`)}`,
      0,
      0,
    ));
    return box;
  }

  box.addChild(new Text(label, 0, 0));
  const content = sanitizeSubagentDisplay(message.content || "Subagent configuration guide unavailable.")
    .replace(/^\[Subagent Config Guide\]\n+/, "");
  box.addChild(new Markdown(content, 0, 0, getMarkdownTheme(), {
    color: (text) => theme.fg("customMessageText", text),
  }));
  box.addChild(new Text(theme.fg("dim", keyHint("app.tools.expand", " collapse")), 0, 0));
  return box;
}
