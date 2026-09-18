import {
  getMarkdownTheme,
  keyHint,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { getPackagePath } from "../core/paths";
import { ALLOWED_EFFORTS } from "./efforts";
import {
  DEFINITION_FIELDS,
  subagentFieldValueType,
  type SubagentDefinitionField,
  type SubagentFieldValueType,
  type SubagentRegistry,
} from "./definitions";
import { sanitizeSubagentDisplay } from "./display";
import { BUILT_IN_TOOL_NAMES } from "./tool-policy";

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

/**
 * Field-table rows generated from the parser (#334): the field list and order
 * come from `DEFINITION_FIELDS` and each row's type from
 * `subagentFieldValueType`, so neither can drift from what the parser accepts.
 * Only requiredness and the inheritance note are authored here — semantics the
 * parser does not classify — and the compile-time `Record` keyed by
 * `SubagentDefinitionField` keeps them present for exactly those fields. The
 * schema reference ships the same rows in its machine-checked contract block.
 */
export interface SubagentFieldTableRow {
  field: SubagentDefinitionField;
  type: SubagentFieldValueType;
  required: "no" | "after merge";
  default: string;
}

type FieldSemantics = Pick<SubagentFieldTableRow, "required" | "default">;

const FIELD_SEMANTICS: Record<SubagentDefinitionField, FieldSemantics> = {
  description: { required: "after merge", default: "none — must survive the overlay merge" },
  model: { required: "no", default: "inherit parent at fresh-run startup" },
  effort: { required: "no", default: "inherit parent at fresh-run startup" },
  policy: { required: "no", default: "none" },
  instructions: { required: "no", default: "none" },
  output: { required: "no", default: "none" },
  inheritParentSystem: { required: "no", default: "true" },
  tools: { required: "no", default: "omitted or [] selects the runtime defaults; [none] disables every built-in tool" },
  extensionTools: { required: "no", default: "omitted or [] requests none" },
  skills: { required: "no", default: "omitted or [] loads all discovered skills; [none] disables them" },
  visible: { required: "no", default: "true" },
};

export function subagentFieldTableRows(): SubagentFieldTableRow[] {
  return DEFINITION_FIELDS.map((field) => ({
    field,
    type: subagentFieldValueType(field),
    ...FIELD_SEMANTICS[field],
  }));
}

function renderFieldTable(): string {
  const rows = subagentFieldTableRows().map(
    (row) => `| ${row.field} | ${row.type} | ${row.required} | ${row.default} |`,
  );
  return ["| Field | Type | Required | Default / inheritance |", "| --- | --- | --- | --- |", ...rows].join("\n");
}

export function buildSubagentConfigGuide(registry: SubagentRegistry, cwd: string): SubagentConfigGuideMessage {
  const definitions = boundedMetadata(registry);
  const presentScopes = new Set(registry.definitions.flatMap(
    (definition) => definition.layers.map((layer) => layer.source),
  ));
  const scopes = (["package", "agent", "project"] as const).filter((scope) => presentScopes.has(scope));
  const omitted = Math.max(0, registry.definitions.length - definitions.length);
  const schemaReferencePath = clip(getPackagePath("subagents", "schema-reference.md"), MAX_PATH_CHARS);
  const content = `[Subagent Config Guide]\n\nHow to treat the next user message:\n- The next user message is the only authorized configuration request. Treat this guide as reference context, not as a task.\n\nConfiguration contract:\n- Use promptVersion: 2. The package layer ships no roles; definitions live in the agent layer or the nearest project layer and overlay per field in that order (package < agent < project).\n- Fields overlay per field: omitted fields inherit, null clears a scalar, and [] clears an inherited list. Omitted and [] are equivalent in final runtime behavior but not in overlay precedence.\n- description is required only in the effective definition; a single layer may omit it.\n- Omitted model/effort inherit at fresh-run startup; resume keeps the original frozen values.\n- V2 prompt fields are policy (SYSTEM), instructions (replayed profile), and output (replayed delivery contract).\n- Omitted or [] tools select runtime defaults; tools: [none] disables every built-in tool and none must be the only entry. Extension tools remain explicit opt-ins.\n- Omitted or [] skills load all discovered skills; skills: [none] disables them.\n- Package files are read-only. Default writes to ${clip(cwd, MAX_PATH_CHARS)}/.pi/subagents; use the agent scope only when the request explicitly requires all projects.\n- visible: false hides an effective definition from the parent catalog and tool lookup.\n- Validate the effective definition after edits. Confirm destructive deletion when the target or scope is ambiguous.\n\nFields (generated from the parser's field constants):\n\n${renderFieldTable()}\n\nValues:\n- tools entries: ${BUILT_IN_TOOL_NAMES.join(", ")} (built-in names), the portable shell capability, and the exclusive none sentinel; bash and pwsh follow the platform.\n- effort entries: ${ALLOWED_EFFORTS.join(", ")}.\n- extensionTools and skills have no static list to copy: extension tool names are validated at child-session startup against the child tool catalog available in the session (platform-dependent), and skills resolve against the skills discovered in the session.\n\nYAML subset (a small subset, not standard YAML; unsupported forms are rejected with a named error, never silently misread):\n- Indent list items under their field.\n- No inline comments: quote the value to keep a literal '#' or move the comment to its own line.\n- Block scalars take | or > alone; chomping or indentation indicators like |- are rejected.\n- No blank lines inside a block list, before the first item or between items.\n- null and ~ are case-sensitive clear markers.\n- One field error invalidates the whole file: no warning level, no value fallback, no partial effect. /subagent lists rejected files as invalid entries with every error.\n\nValidation happens in three stages — a file that parses and saves is not yet a working configuration:\n- Parse time (every discovery): the subset rules and field shapes above plus the overlay merge; a rejected file becomes an invalid entry.\n- Startup time (child-session creation, before any model call): tool selection resolves — unsupported names, none beside another entry, anchored replace/insert by name.\n- Session time (child-session assembly): model must resolve, effort must be an allowed value, requested skills must exist.\n- Full normative reference with executable examples: ${schemaReferencePath}\n\nCurrent effective definitions${omitted > 0 ? ` (${omitted} omitted by the guide budget)` : ""}:\n\n~~~json\n${JSON.stringify(definitions, null, 2)}\n~~~`;
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
  const container = new Container();
  const label = `${theme.fg("success", "✓")} ${theme.fg("accent", "●")} ${theme.fg("toolTitle", theme.bold("Config guide"))}`;
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
  const content = sanitizeSubagentDisplay(message.content || "Subagent configuration guide unavailable.")
    .replace(/^\[Subagent Config Guide\]\n+/, "");
  container.addChild(new Markdown(content, 0, 0, getMarkdownTheme()));
  container.addChild(new Text(theme.fg("dim", keyHint("app.tools.expand", " collapse")), 0, 0));
  return container;
}
