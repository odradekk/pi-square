/**
 * Bounded Config Guide for the parameterized `/shadow <request>` command
 * (odradekk/pi-square#149, slice #154; natural-language configuration since
 * #189), modeled on the Subagent Config Guide.
 *
 * The guide is injected as a custom message before the unchanged user
 * request; only the user message triggers the parent turn, and nothing here
 * writes a definition by itself. The guide authorizes ordinary file work:
 * consultations answer without changes, clear create/modify/enable/disable/
 * delete requests run through the ordinary read/write/replace tools and the
 * platform shell for deletion, with no Shadow-specific write tool or
 * confirmation. Content stays bounded: at most fifty definition metadata
 * entries within a 24,000-character JSON budget.
 */

import {
  getMarkdownTheme,
  keyHint,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { sanitizeDisplayText } from "../display/sanitize";
import { getAgentPath, getPackagePath } from "../core/paths";
import { shadowDefinitionScopeDir, type ShadowDefinitionRegistry } from "./definitions";

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
  const agentScopeDir = clip(shadowDefinitionScopeDir("agent", cwd), MAX_PATH_CHARS);
  let projectScopeLine: string;
  try {
    const projectScopeDir = clip(shadowDefinitionScopeDir("project", cwd), MAX_PATH_CHARS);
    projectScopeLine = `- Project overlay (nearest): ${projectScopeDir}. Writes follow discovery: an existing ancestor .pi/shadow-minds is the overlay target.`;
  } catch (error) {
    const reason = clip(error instanceof Error ? error.message : String(error), MAX_PATH_CHARS);
    projectScopeLine = `- Project overlay unavailable: ${reason}. Do not create, modify, or delete project-scope definitions until the path problem is fixed; consultations and agent-scope work remain available.`;
  }
  const agentConfigPath = clip(getAgentPath("config", "pi-square.json"), MAX_PATH_CHARS);
  const examplePath = clip(getPackagePath("shadow-minds", "example.md"), MAX_PATH_CHARS);
  const schemaPath = clip(getPackagePath("shadow-minds", "schema-reference.md"), MAX_PATH_CHARS);
  const content = `[Shadow Config Guide]\n\nHow to treat the next user message:\n- The next user message is the only authorized configuration request. Treat this guide as reference context, not as a task.\n- Consultations about Shadow Minds or its configuration are answered from this guide and the current definitions without changing any file.\n- Create, modify, enable, disable, and delete requests are authorized work on ordinary files: treat them like any coding task.\n- When the target scope (agent versus project) or which layer a deletion should remove is ambiguous, ask one minimal clarification question before touching files.\n\nScopes and paths (resolved for this session):\n- Agent base (all projects): ${agentScopeDir}\n${projectScopeLine}\n- Project definitions, defaults, and rules participate regardless of project approval.\n\nFile operations:\n- Create and modify definition files with the ordinary read, write, and replace tools; delete with the active platform shell (rm on POSIX, Remove-Item on Windows) because no dedicated delete tool exists. No Shadow-specific write tool or confirmation applies.\n- Before deleting a layer, read both agent and project files for that ID and report the consequence: deleting a project overlay reveals the agent base when one exists; deleting an agent base can strand a minimal project overlay as incomplete, so warn before doing it.\n- Packaged references are documentation, not configuration targets: ${examplePath} (one complete annotated definition) and ${schemaPath} (the normative field reference). They never run as definitions and package upgrades may overwrite them. Read them only when the request needs that detail, and copy patterns into a real scope rather than editing them.\n\nDefinition contract (strict, fail closed per ID):\n- Definitions are Markdown with frontmatter promptVersion: 1; the id must equal the file name stem (<id>.md).\n- Definitions merge two user-owned scopes: the agent base layer and the nearest project overlay under .pi/shadow-minds. Omitted fields inherit; trigger instructions merge per trigger key and null removes one key; outputSchema is replaced atomically and null restores the default summary schema; an omitted or empty body inherits while a non-empty body replaces the lower layer.\n- New definitions default to disabled, priority 0, no automatic triggers, steer delivery, no completion gate, inherited runtime defaults, debug false, and the default summary schema (summary string).\n- An invalid, incomplete, duplicated, or mismatched definition is excluded by discovery with an actionable diagnostic while unrelated valid IDs keep running.\n\nAuthoring decisions:\n- triggers are exactly tool_turn, failure, mutation, completion. tool_turn runs after qualifying tool turns (frequent, highest automatic cost); failure runs when classified quality commands fail; mutation runs when session tools change files; completion runs when a real-user run finishes. Automatic triggers fire only while the master switch is on.\n- delivery is steer (the result enters the active parent run at a turn boundary), wake (a follow-up turn starts when the parent settles), or notify (results stay in the /shadow inbox until explicitly sent).\n- completionGate: true requires a completion trigger; it briefly holds the settle so the review can finish before the answer is finalized.\n- tools omitted selects the default local read-only set; tools: [] disables tool use; requiredTools must be a subset of the final tool set.\n- Budgets: timeoutSeconds, maxTurns, and maxToolCalls bound each run; omitting model inherits the activating parent model, provider/model-id pins one, and omitting thinking inherits it.\n\nMaster switch and agent configuration:\n- The runtime stays experimental and runs only while the agent-level master switch shadowMinds.enabled is true in ${agentConfigPath}; it is agent-only — a project cannot enable it — and disabled by default.\n- Creating or editing a draft definition never turns the master switch on. Change the agent config field shadowMinds.enabled to true only when the user explicitly asks to enable or run Shadow Minds; a definition's own enabled field arms only that definition and does not change the master switch.\n- Before changing the agent config, read the complete file, change only the shadowMinds fields you intend, and preserve every unrelated setting.\n\nAfter any change:\n- Re-read every file you changed and check it says what you intended. Self-checks are best effort: strict discovery on the next /shadow remains the final backstop that excludes invalid files per ID with a diagnostic.\n- Report the scope and exact paths you touched, the expected effective behavior (enabled state, triggers, delivery, gate, tools, model, budgets), and the automatic-run cost implication of any newly enabled trigger.\n- Tell the user to reopen /shadow to refresh definitions and inspect production diagnostics.\n\nRuntime boundary (unchanged):\n- Shadows are strictly read-only. The Shadow-safe catalog is read, grep, find, ls, pdf_search, search, fetch, libs, docs; shell, writes, SSH, Firecrawl parse, and delegation are excluded, unavailable optional tools drop with a run-start warning, and requiredTools misses fail before any model prompt.\n\nCurrent effective definitions${omitted > 0 ? ` (${omitted} omitted by the guide budget)` : ""}:\n\n~~~json\n${JSON.stringify(definitions, null, 2)}\n~~~`;
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
