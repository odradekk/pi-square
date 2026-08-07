import { createHash } from "node:crypto";
import {
  SettingsManager,
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  getAgentDir,
  type AgentToolResult,
  type ExtensionAPI,
  type ExtensionContext,
  type SourceInfo,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { setBannerDisplayDiagnostic } from "../banner";
import type { DisplayController } from "./index";
import { inspectWritePreview } from "./file-preview";
import { decorateToolDefinition, type DisplayRuntimeProvider, type InternalToolDisplayAdapter } from "./tool-renderer";
import { codeSection, field, recordsSection, sections, summarySection, textSection } from "./adapter-utils";
import { sanitizeDisplayLine, truncateCodePoints } from "./sanitize";
import type { DisplayDescriptionV1, DisplayMetadataEntry, DisplayRow, OperationalLifecycle } from "./types";

const BUILTIN_NAMES = ["read", "grep", "find", "ls", "edit", "write", "bash"] as const;
const NON_SHELL_NAMES = BUILTIN_NAMES.filter((name) => name !== "bash");
const OWN_SOURCE_PROBES = ["pdf_search", "codegraph", "subagent_delegate", "scheme", "todo"];
const KNOWN_PI_TOOL_DISPLAY_SYMBOL = Symbol.for("pi-tool-display.api.v1");
const STATUS_KEY = "pi-square.display";
const MAX_DIAGNOSTIC_CHARS = 500;

type BuiltinName = typeof BUILTIN_NAMES[number];
type GenericDefinition = ToolDefinition<any, any, any>;
type GenericAdapter = InternalToolDisplayAdapter<any, any, any>;

function safeDiagnostic(value: unknown): string {
  return truncateCodePoints(sanitizeDisplayLine(value), MAX_DIAGNOSTIC_CHARS);
}

function textContent(result: AgentToolResult<unknown>): string {
  return result.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberMetadata(label: string, value: unknown): DisplayMetadataEntry | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? { label, value: String(value) }
    : undefined;
}

function callDescription(name: BuiltinName, args: Record<string, unknown>, executionStarted: boolean): DisplayDescriptionV1 {
  const path = stringValue(args.path);
  const command = stringValue(args.command);
  const pattern = stringValue(args.pattern);
  const metadata = [
    numberMetadata("offset", args.offset),
    numberMetadata("limit", args.limit),
    numberMetadata("timeout", args.timeout),
  ].filter((entry): entry is DisplayMetadataEntry => Boolean(entry));
  const rows: DisplayRow[] = [];
  if (name === "grep" && pattern) rows.push({ text: `query ${pattern}` });
  if (name === "find" && pattern) rows.push({ text: `pattern ${pattern}` });
  if (name === "edit" && Array.isArray(args.edits)) rows.push({ text: `${args.edits.length} exact replacement${args.edits.length === 1 ? "" : "s"}` });
  if (name === "write" && typeof args.content === "string") rows.push({ text: `${Buffer.byteLength(args.content)} bytes projected` });
  return {
    version: 1,
    tool: name,
    family: name === "bash" ? "execution" : name === "grep" || name === "find" ? "search" : "filesystem",
    status: executionStarted ? "pending" : "partial",
    title: name.toUpperCase(),
    target: command ?? path ?? (name === "find" ? pattern : undefined),
    metadata,
    rows,
  };
}

function resultSections(
  name: BuiltinName,
  args: Record<string, unknown>,
  text: string,
  details: Record<string, unknown> | undefined,
  expanded: boolean,
): ReturnType<typeof sections> {
  if (!expanded) return [];
  const target = stringValue(args.path);
  if (name === "read") {
    return sections(
      summarySection("File", [
        field("path", target),
        field("offset", args.offset),
        field("limit", args.limit),
      ]),
      codeSection("Content", text, undefined, true),
      details?.truncation ? textSection("Truncation", JSON.stringify(details.truncation), "warning") : undefined,
    );
  }
  if (name === "ls") {
    const entries = text.split("\n").filter(Boolean).slice(0, 200);
    return sections(
      summarySection("Directory", [field("path", target ?? ".")]),
      recordsSection("Entries", entries.map((entry) => ({
        title: entry,
        tone: entry.endsWith("/") ? "accent" as const : "default" as const,
      }))),
    );
  }
  if (name === "find") {
    const results = text.split("\n").filter(Boolean).slice(0, 200);
    return sections(
      summarySection("Query", [field("pattern", args.pattern), field("path", target ?? ".")]),
      recordsSection("Results", results.map((entry) => ({ title: entry, tone: entry.endsWith("/") ? "accent" as const : "default" as const }))),
    );
  }
  if (name === "grep") {
    return sections(
      summarySection("Query", [field("pattern", args.pattern), field("path", target ?? ".")]),
      codeSection("Matches", text, "text", false),
    );
  }
  if (name === "write") {
    const base = sections(
      summarySection("Target", [field("path", target), field("bytes", typeof args.content === "string" ? Buffer.byteLength(args.content) : undefined)]),
      codeSection("Content", typeof args.content === "string" ? args.content : text, undefined, false),
    );
    return expanded ? base : base.filter((section) => section.title === "Target");
  }
  return [];
}

function resultDescription(
  name: BuiltinName,
  args: Record<string, unknown>,
  result: AgentToolResult<unknown>,
  partial: boolean,
): DisplayDescriptionV1 {
  const text = textContent(result);
  const details = result.details && typeof result.details === "object"
    ? result.details as Record<string, unknown>
    : undefined;
  const truncation = details?.truncation && typeof details.truncation === "object"
    ? details.truncation as Record<string, unknown>
    : undefined;
  const target = stringValue(args.command) ?? stringValue(args.path);
  const description: DisplayDescriptionV1 = {
    version: 1,
    tool: name,
    family: name === "bash" ? "execution" : name === "grep" || name === "find" ? "search" : "filesystem",
    status: partial ? "partial" : "success",
    title: name.toUpperCase(),
    target,
    truncated: truncation?.truncated === true,
    sections: resultSections(name, args, text, details, !partial),
  };
  if (name === "edit" && (typeof details?.patch === "string" || typeof details?.diff === "string")) {
    return {
      ...description,
      diff: {
        path: stringValue(args.path),
        patch: typeof details.patch === "string" && details.patch.length > 0 ? details.patch : details.diff as string,
      },
    };
  }
  if (name === "write" && typeof args.content === "string") {
    return { ...description, preview: { text: args.content } };
  }
  return text ? { ...description, preview: { text } } : description;
}

function writePreviewKey(args: Record<string, unknown>): string {
  const path = typeof args.path === "string" ? args.path : "";
  const content = typeof args.content === "string" ? args.content : "";
  return createHash("sha256").update(path).update("\0").update(content).digest("hex");
}

/**
 * Derive an explicit lifecycle for content-rich tools (Read) so they
 * render through the new operational path rather than the compatibility bridge.
 */
function contentLifecycle(
  context: { executionStarted: boolean; argsComplete: boolean; isPartial: boolean; isError: boolean },
  phase: "call" | "result",
): OperationalLifecycle {
  if (phase === "result") {
    if (context.isPartial) return "running";
    return context.isError ? "failed" : "completed";
  }
  if (context.executionStarted) return "running";
  if (context.argsComplete) return "pending";
  return "queued";
}

function adapterFor(name: BuiltinName, cwd: string): GenericAdapter {
  return {
    describeCall(args, context) {
      const desc = callDescription(name, args as Record<string, unknown>, context.executionStarted);
      return name === "read"
        ? { ...desc, lifecycle: contentLifecycle(context, "call") }
        : desc;
    },
    ...(name === "write" ? {
      callDescriptionKey(args: Record<string, unknown>) {
        return writePreviewKey(args);
      },
      async describeCallAsync(args: Record<string, unknown>, context: { executionStarted: boolean }) {
        const path = typeof args.path === "string" ? args.path : "";
        const content = typeof args.content === "string" ? args.content : "";
        const base = callDescription(name, args, context.executionStarted);
        const preview = await inspectWritePreview(cwd, path, content);
        if (preview.kind === "create") {
          return { ...base, target: preview.path, diff: { path: preview.path, before: "", after: preview.after, projected: true } };
        }
        if (preview.kind === "overwrite") {
          return { ...base, target: preview.path, diff: { path: preview.path, before: preview.before, after: preview.after, projected: true } };
        }
        return {
          ...base,
          target: preview.path || base.target,
          rows: [...(base.rows ?? []), { text: `projected preview unavailable: ${preview.reason}`, tone: "muted" }],
        };
      },
    } : {}),
    describeResult(result, options, context) {
      const desc = resultDescription(name, context.args as Record<string, unknown>, result, options.isPartial);
      return name === "read"
        ? { ...desc, lifecycle: contentLifecycle(context, "result") }
        : desc;
    },
  } as GenericAdapter;
}

export function decorateBuiltinDefinition(
  definition: GenericDefinition,
  cwd: string,
  runtime: DisplayRuntimeProvider,
): GenericDefinition {
  const name = definition.name as BuiltinName;
  if (!BUILTIN_NAMES.includes(name)) throw new Error(`unsupported Pi built-in display tool: ${definition.name}`);
  return decorateToolDefinition(definition, runtime, adapterFor(name, cwd));
}

function sourceKey(info: SourceInfo): string {
  return `${info.path}\u0000${info.source}\u0000${info.scope}\u0000${info.origin}`;
}

function ownSource(pi: ExtensionAPI): SourceInfo | undefined {
  const counts = new Map<string, { count: number; source: SourceInfo }>();
  for (const tool of pi.getAllTools()) {
    if (!OWN_SOURCE_PROBES.includes(tool.name)) continue;
    const key = sourceKey(tool.sourceInfo);
    const current = counts.get(key);
    counts.set(key, { count: (current?.count ?? 0) + 1, source: tool.sourceInfo });
  }
  return [...counts.values()].sort((left, right) => right.count - left.count)[0]?.source;
}

function sameSource(left: SourceInfo | undefined, right: SourceInfo | undefined): boolean {
  return Boolean(left && right && sourceKey(left) === sourceKey(right));
}

function sameNames(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((name, index) => name === right[index]);
}

function publishDiagnostics(
  controller: DisplayController,
  ctx: ExtensionContext,
  diagnostics: readonly string[],
): void {
  const safe = diagnostics.map(safeDiagnostic).filter(Boolean).slice(0, 8);
  controller.setDiagnostics(safe);
  const summary = safe.length > 0 ? safe.join(" · ") : undefined;
  setBannerDisplayDiagnostic(summary);
  if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, summary);
}

function settingsDefinitions(
  cwd: string,
  ctx: Pick<ExtensionContext, "isProjectTrusted">,
): { definitions: GenericDefinition[]; diagnostics: string[] } {
  const settings = SettingsManager.create(cwd, getAgentDir(), {
    projectTrusted: ctx.isProjectTrusted(),
  });
  const errors = settings.drainErrors();
  if (errors.length > 0) {
    return {
      definitions: [],
      diagnostics: errors.map(({ scope, error }) => `Pi ${scope} settings invalid; read/bash display overrides blocked: ${error.message}`),
    };
  }
  const definitions: GenericDefinition[] = [
    createReadToolDefinition(cwd, { autoResizeImages: settings.getImageAutoResize() }),
  ];
  if (process.platform !== "win32") {
    definitions.push(createBashToolDefinition(cwd, {
      shellPath: settings.getShellPath(),
      commandPrefix: settings.getShellCommandPrefix(),
    }));
  }
  return { definitions, diagnostics: [] };
}

export default function registerDisplayBuiltins(
  pi: ExtensionAPI,
  controller: DisplayController,
): void {
  pi.on("session_start", async (_event, ctx) => {
    const active = [...pi.getActiveTools()];
    const diagnostics: string[] = [];
    if (Object.getOwnPropertyDescriptor(globalThis, KNOWN_PI_TOOL_DISPLAY_SYMBOL) !== undefined) {
      diagnostics.push("Known pi-tool-display renderer detected; all Pi built-in display overrides are blocked until it is removed and Pi is reloaded");
      publishDiagnostics(controller, ctx, diagnostics);
      return;
    }

    const settings = settingsDefinitions(ctx.cwd, ctx);
    diagnostics.push(...settings.diagnostics);
    const definitions: GenericDefinition[] = [
      createGrepToolDefinition(ctx.cwd),
      createFindToolDefinition(ctx.cwd),
      createLsToolDefinition(ctx.cwd),
      createEditToolDefinition(ctx.cwd),
      createWriteToolDefinition(ctx.cwd),
      ...settings.definitions,
    ];
    const names = new Set(definitions.map((definition) => definition.name as BuiltinName));
    for (const definition of definitions) {
      pi.registerTool(decorateBuiltinDefinition(definition, ctx.cwd, () => controller.runtime));
    }
    if (!sameNames(active, pi.getActiveTools())) pi.setActiveTools(active);

    const owner = ownSource(pi);
    const winners = new Map(pi.getAllTools().map((tool) => [tool.name, tool.sourceInfo]));
    const expected = process.platform === "win32" ? NON_SHELL_NAMES : BUILTIN_NAMES;
    const losing = expected.filter((name) => names.has(name) && !sameSource(winners.get(name), owner));
    if (losing.length > 0) {
      diagnostics.push(`Built-in display ownership conflict: ${losing.join(", ")}; reload after removing the earlier renderer`);
    }
    publishDiagnostics(controller, ctx, diagnostics);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    controller.setDiagnostics([]);
    setBannerDisplayDiagnostic(undefined);
    if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
  });
}

export const __testables = {
  settingsDefinitions,
  sourceKey,
  ownSource,
  safeDiagnostic,
};
