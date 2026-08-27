/**
 * Bounded Config Guide for the parameterized `/shadow <request>` command
 * (odradekk/pi-square#149, slice #154), modeled on the Subagent Config Guide.
 *
 * The guide is injected as a custom message before the unchanged user
 * request; only the user message triggers the parent turn, and nothing here
 * writes a definition by itself. Content stays bounded: at most fifty
 * definition metadata entries within a 24,000-character JSON budget.
 */

import {
  getMarkdownTheme,
  keyHint,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { sanitizeDisplayText } from "../display/sanitize";
import { getPackagePath } from "../core/paths";
import type { ShadowDefinitionRegistry } from "./definitions";

export const SHADOW_CONFIG_GUIDE_TYPE = "pi-square.shadow-config-guide";
const MAX_DEFINITIONS = 50;
const MAX_METADATA_JSON = 24_000;
const MAX_PATH_CHARS = 512;
const MAX_VALUE_CHARS = 160;

export interface ShadowConfigGuideDetails {
  version: 1;
  definitionCount: number;
  includedDefinitionCount: number;
  scopes: Array<"agent" | "project">;
}

export interface ShadowConfigGuideMessage {
  content: string;
  details: ShadowConfigGuideDetails;
}

/** Applies the shared VT/control and credential redaction boundary. */
function sanitize(value: unknown): string {
  return sanitizeDisplayText(value);
}

function clip(value: unknown, max: number): string {
  const characters = Array.from(sanitize(value).replace(/\s+/g, " ").trim());
  return characters.length <= max
    ? characters.join("")
    : `${characters.slice(0, Math.max(0, max - 3)).join("")}...`;
}

function clipList(value: string[] | undefined): string[] | "default" {
  if (value === undefined) return "default";
  return value.slice(0, 16).map((item) => clip(item, MAX_VALUE_CHARS));
}

export function guideDefinitionMetadata(registry: ShadowDefinitionRegistry): Array<Record<string, unknown>> {
  return registry.definitions.slice(0, MAX_DEFINITIONS).map((definition) => ({
    id: clip(definition.id, MAX_VALUE_CHARS),
    name: clip(definition.name, MAX_VALUE_CHARS),
    enabled: definition.enabled,
    hidden: definition.hidden,
    layers: definition.layers.slice(0, 3).map((layer) => ({
      scope: layer.scope,
      filePath: clip(layer.filePath, MAX_PATH_CHARS),
    })),
    priority: definition.priority,
    triggers: definition.triggers.slice(0, 4),
    delivery: definition.delivery,
    completionGate: definition.completionGate,
    model: definition.model ? clip(definition.model, MAX_VALUE_CHARS) : "inherit",
    thinking: definition.thinking ?? "inherit",
    tools: clipList(definition.tools),
    requiredTools: definition.requiredTools === undefined ? [] : clipList(definition.requiredTools),
  }));
}

function boundedMetadata(registry: ShadowDefinitionRegistry): Array<Record<string, unknown>> {
  const definitions = guideDefinitionMetadata(registry);
  while (definitions.length > 0 && JSON.stringify(definitions).length > MAX_METADATA_JSON) definitions.pop();
  return definitions;
}

export function buildShadowConfigGuide(
  registry: ShadowDefinitionRegistry,
  cwd: string,
): ShadowConfigGuideMessage {
  const definitions = boundedMetadata(registry);
  const presentScopes = new Set(registry.definitions.flatMap(
    (definition) => definition.layers.map((layer) => layer.scope),
  ));
  const scopes = (["agent", "project"] as const).filter((scope) => presentScopes.has(scope));
  const omitted = Math.max(0, registry.definitions.length - definitions.length);
  const content = `[Shadow Config Guide]\n\nConfiguration contract:\n- Definitions are Markdown with frontmatter promptVersion: 1; the id must equal the file name stem (<id>.md).\n- Definitions merge two user-owned scopes: the agent base layer and the nearest project overlay under .pi/shadow-minds. Omitted fields inherit; trigger instructions merge per trigger key and null removes one key; outputSchema is replaced atomically and null restores the default summary schema; a provided body replaces the lower layer.\n- New definitions default to disabled, priority 0, no automatic triggers, steer delivery, no completion gate, inherited runtime defaults, debug false, and the default summary schema (summary string).\n- Automatic triggers are exactly tool_turn, failure, mutation, completion. delivery is steer, wake, or notify. completionGate requires a completion subscription.\n- tools omitted selects the default local read-only set; tools: [] selects none. requiredTools must be a subset of the final tool set. The Shadow-safe catalog is read, grep, find, ls, codegraph, pdf_search, search, fetch, libs, docs; shell, writes, SSH, Firecrawl parse, authenticated GitHub, and delegation are excluded, and unavailable optional tools drop with a run-start warning.\n- Reference assets shipped with the package are documentation only and never discovered as definitions: ${clip(getPackagePath("shadow-minds", "example.md"), MAX_PATH_CHARS)} (one complete annotated definition) and ${clip(getPackagePath("shadow-minds", "schema-reference.md"), MAX_PATH_CHARS)} (the normative field reference). Copy or author definitions in the agent or project scope. Default project writes go to ${clip(cwd, MAX_PATH_CHARS)}/.pi/shadow-minds; use the agent scope only when the request explicitly requires all projects. Project definitions, defaults, and rules participate regardless of project approval.\n- The runtime stays experimental and disabled by default until the agent-level enabled master switch is turned on; a project cannot re-enable it.\n- Definitions are written only through the /shadow manager with review and confirmation. Draft overlay Markdown for the user to review; never write definition files directly and never run a Shadow automatically.\n- The next user message is the only authorized configuration request. Treat this guide as reference context, not as a task.\n\nCurrent effective definitions${omitted > 0 ? ` (${omitted} omitted by the guide budget)` : ""}:\n\n~~~json\n${JSON.stringify(definitions, null, 2)}\n~~~`;
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

export function renderShadowConfigGuide(
  message: { content?: unknown; details?: ShadowConfigGuideDetails },
  options: { expanded: boolean },
  theme: Theme,
): Component {
  const details = message.details;
  const count = Number.isFinite(details?.definitionCount) ? Math.max(0, Math.trunc(details!.definitionCount)) : 0;
  const scopes = Array.isArray(details?.scopes)
    ? details.scopes.filter((scope) => scope === "agent" || scope === "project").join("/")
    : "";
  const container = new Container();
  const label = `${theme.fg("success", "✓")} ${theme.fg("accent", "●")} ${theme.fg("toolTitle", theme.bold("Shadow config guide"))}`;
  if (!options.expanded) {
    const summary = [
      `${count} definition${count === 1 ? "" : "s"}`,
      scopes,
    ].filter(Boolean).join(" · ");
    container.addChild(new Text(
      `${label}${summary ? theme.fg("muted", `  ${summary}`) : ""}${theme.fg("dim", `  ${keyHint("app.tools.expand", " expand")}`)}`,
      0,
      0,
    ));
    return container;
  }

  container.addChild(new Text(label, 0, 0));
  container.addChild(new Text(theme.fg("dim", "─".repeat(Math.max(1, visibleWidth(label) + 1))), 0, 0));
  const content = sanitize(message.content || "Shadow configuration guide unavailable.")
    .replace(/^\[Shadow Config Guide\]\n+/, "");
  container.addChild(new Markdown(content, 0, 0, getMarkdownTheme()));
  container.addChild(new Text(theme.fg("dim", keyHint("app.tools.expand", " collapse")), 0, 0));
  return container;
}
