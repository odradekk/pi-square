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
import { codeSection, formatBytes, formatDisplayPath, matchesSection, pathsSection, sections } from "./adapter-utils";
import { sanitizeDisplayLine, truncateCodePoints } from "./sanitize";
import type { DisplayDescriptionV1, DisplayMatchItem, DisplayMetadataEntry, DisplayPathItem, DisplayRow, OperationalLifecycle } from "./types";
import { DEFAULT_DISPLAY_POLICY } from "./types";

const BUILTIN_NAMES = ["read", "grep", "find", "ls", "edit", "write", "bash"] as const;
const NON_SHELL_NAMES = BUILTIN_NAMES.filter((name) => name !== "bash");
const OWN_SOURCE_PROBES = ["pdf_search", "codegraph", "delegate", "todo"];
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


/** C1 sentence-case titles; unique within each family (`ls` is `List`, `find` is `Find`). */
const BUILTIN_TITLES: Readonly<Record<BuiltinName, string>> = Object.freeze({
  read: "Read",
  ls: "List",
  edit: "Edit",
  write: "Write",
  find: "Find",
  grep: "Grep",
  bash: "Bash",
});

function builtinTitle(name: BuiltinName): string {
  return BUILTIN_TITLES[name];
}

/**
 * Header target for a built-in: the command for bash, the pattern for find
 * and grep, then the path. Path targets follow C2 (workspace-relative, `~`
 * for home) and are elided in the middle by the header.
 */
function builtinTarget(
  name: BuiltinName,
  args: Record<string, unknown>,
  cwd: string,
  returnedLines?: number,
): Pick<DisplayDescriptionV1, "target" | "targetKind"> {
  const command = stringValue(args.command);
  if (command) return { target: command };
  if (name === "find" || name === "grep") {
    const pattern = stringValue(args.pattern);
    if (pattern) return { target: pattern };
  }
  const path = stringValue(args.path);
  if (!path) return {};
  const displayPath = formatDisplayPath(path, cwd);
  // A windowed read appends the line range: path:start-end.
  // For the result header, the end line is derived from the actual
  // returned lines, not the requested limit, so it never shows a
  // range that was not returned.
  if (name === "read") {
    const offset = typeof args.offset === "number" && Number.isFinite(args.offset) ? args.offset : undefined;
    const limit = typeof args.limit === "number" && Number.isFinite(args.limit) ? args.limit : undefined;
    if (offset !== undefined || limit !== undefined) {
      const start = offset ?? 1;
      let end: number | undefined;
      if (returnedLines !== undefined && returnedLines > 0) {
        end = start + returnedLines - 1;
      } else if (limit !== undefined) {
        end = start + limit - 1;
      }
      const range = end !== undefined ? `:${start}-${end}` : `:${start}`;
      return { target: `${displayPath}${range}`, targetKind: "path" as const };
    }
  }
  return { target: displayPath, targetKind: "path" as const };
}

function callDescription(name: BuiltinName, args: Record<string, unknown>, cwd: string, executionStarted: boolean): DisplayDescriptionV1 {
  // grep and bash carry no key=value metadata; the header target already
  // shows the pattern or command. Other builtins keep offset/limit.
  const metadata = (name === "grep" || name === "bash") ? [] : [
    numberMetadata("offset", args.offset),
    numberMetadata("limit", args.limit),
    numberMetadata("timeout", args.timeout),
  ].filter((entry): entry is DisplayMetadataEntry => Boolean(entry));
  const rows: DisplayRow[] = [];
  if (name === "edit" && Array.isArray(args.edits)) rows.push({ text: `${args.edits.length} replacement${args.edits.length === 1 ? "" : "s"}` });
  return {
    version: 1,
    tool: name,
    family: name === "bash" ? "execution" : name === "grep" ? "search" : "filesystem",
    lifecycle: executionStarted ? "running" : "queued",
    title: builtinTitle(name),
    ...builtinTarget(name, args, cwd),
    metadata,
    rows,
  };
}

/**
 * Detect path kind from a raw ls/find entry: a trailing `/` marks a directory.
 */
function pathKindFromEntry(entry: string): DisplayPathItem["kind"] {
  return entry.endsWith("/") ? "directory" : "file";
}

function pathItemsFromText(text: string): DisplayPathItem[] {
  return text.split("\n").filter(Boolean).map((entry) => ({
    path: entry,
    kind: pathKindFromEntry(entry),
  }));
}

/**
 * Parse standard grep output lines (`path:line:text`) into structured match items.
 * Highlights the first occurrence of the search pattern within each excerpt.
 */
function grepMatchItems(text: string, pattern: string | undefined): DisplayMatchItem[] {
  return text.split("\n").filter(Boolean).flatMap((line) => {
    const firstColon = line.indexOf(":");
    if (firstColon === -1) return [{ path: line }];
    const path = line.slice(0, firstColon);
    const rest = line.slice(firstColon + 1);
    const secondColon = rest.indexOf(":");
    if (secondColon === -1) return [{ path, excerpt: rest }];
    const lineNum = Number(rest.slice(0, secondColon));
    const excerpt = rest.slice(secondColon + 1);
    // Emphasis: find the first occurrence of the pattern in the excerpt.
    const highlights = pattern && excerpt
      ? (() => {
        const idx = excerpt.indexOf(pattern);
        return idx >= 0 ? [{ start: idx, end: idx + pattern.length }] : undefined;
      })()
      : undefined;
    return [{
      path,
      ...(Number.isFinite(lineNum) ? { line: lineNum } : {}),
      excerpt,
      ...(highlights && highlights.length > 0 ? { highlights } : {}),
    }];
  });
}

/** Maximum entries rendered in a paths section before overflow is reported. */
const MAX_DISPLAY_PATHS = 64;

/**
 * Sort path items so directories precede files; each group keeps an
 * alphabetical order. Presentation only — the model-facing text is unchanged.
 */
function sortPathItems(items: DisplayPathItem[]): DisplayPathItem[] {
  return [...items].sort((a, b) => {
    const aDir = a.kind === "directory" ? 0 : 1;
    const bDir = b.kind === "directory" ? 0 : 1;
    if (aDir !== bDir) return aDir - bDir;
    return a.path.localeCompare(b.path, undefined, { sensitivity: "base" });
  });
}

/**
 * Parse the continuation hint that the Pi read tool embeds in its result text.
 * Returns the total file lines, the next offset, and the exact hint substring
 * so the caller can strip it from displayed content.
 */
function parseReadContinuation(text: string): { totalLines: number; nextOffset: number; hintText: string } | undefined {
  // The truncated form may include an optional `(N.NKB limit)` clause
  // when truncation is byte-driven rather than line-driven.
  const truncated = /\n*\[Showing lines \d+-\d+ of (\d+)(?: \([^)]+\))?\.? Use offset=(\d+) to continue\.\]$/;
  const limited = /\n*\[(\d+) more lines in file\. Use offset=(\d+) to continue\.\]$/;
  const tMatch = text.match(truncated);
  if (tMatch) {
    return { totalLines: Number(tMatch[1]), nextOffset: Number(tMatch[2]), hintText: tMatch[0] };
  }
  const lMatch = text.match(limited);
  if (lMatch) {
    const moreLines = Number(lMatch[1]);
    const nextOffset = Number(lMatch[2]);
    return { totalLines: nextOffset - 1 + moreLines, nextOffset, hintText: lMatch[0] };
  }
  return undefined;
}

/** C6 human error sentences for each filesystem tool. */
function readErrorSentence(text: string): string {
  if (/ENOENT|no such file/i.test(text)) return "File does not exist";
  if (/EISDIR|is a directory/i.test(text)) return "Path is a directory";
  if (/EACCES|permission denied/i.test(text)) return "Permission denied";
  if (/exceeds.*limit|not readable|binary|undecodable/i.test(text)) return "File is not readable as text";
  return text.split("\n", 1)[0]?.trim() || "Could not read file";
}

function lsErrorSentence(text: string): string {
  if (/ENOENT|no such file|not found/i.test(text)) return "Directory does not exist";
  if (/ENOTDIR|not a directory/i.test(text)) return "Path is a file";
  if (/EACCES|permission denied/i.test(text)) return "Permission denied";
  return text.split("\n", 1)[0]?.trim() || "Could not list directory";
}

function editErrorSentence(text: string, args: Record<string, unknown>): string {
  const total = Array.isArray(args.edits) ? args.edits.length : 1;
  const indexMatch = text.match(/edits\[(\d+)\]/);
  const editIndex = indexMatch ? Number(indexMatch[1]) + 1 : 1;
  if (/could not find|found no exact|not.*found/i.test(text)) return `Edit ${editIndex} of ${total} found no exact match`;
  if (/occurrences|must be unique/i.test(text)) {
    const occMatch = text.match(/(\d+) occurrences/);
    return `Edit ${editIndex} of ${total} matched ${occMatch ? Number(occMatch[1]) : "multiple"} times; it must be unique`;
  }
  if (/overlap/i.test(text)) {
    const overlapMatch = text.match(/edits\[(\d+)\] and edits\[(\d+)\]/);
    if (overlapMatch) return `Edit ${Number(overlapMatch[2]) + 1} of ${total} overlaps edit ${Number(overlapMatch[1]) + 1}`;
    return `Edit ${editIndex} of ${total} overlaps another edit`;
  }
  if (/empty/i.test(text)) return `Edit ${editIndex} of ${total} has empty old text`;
  if (/no changes/i.test(text)) return "No changes needed";
  // Check EACCES before the generic "could not edit" wrapper, because the
  // Pi edit tool wraps every access failure as "Could not edit file: ...".
  if (/EACCES|permission denied/i.test(text)) return "Permission denied";
  if (/ENOENT|no such file|could not edit/i.test(text)) return "File does not exist";
  return text.split("\n", 1)[0]?.trim() || "Edit failed";
}

function writeErrorSentence(text: string): string {
  if (/EACCES|permission denied/i.test(text)) return "Permission denied";
  if (/EISDIR|is a directory/i.test(text)) return "Path is a directory";
  if (/EROFS|read-only/i.test(text)) return "Filesystem is read-only";
  return text.split("\n", 1)[0]?.trim() || "Could not write file";
}

function findErrorSentence(text: string): string {
  if (/ENOENT|no such file|not found|path not found/i.test(text)) return "Search root does not exist";
  if (/EACCES|permission denied/i.test(text)) return "Permission denied";
  if (/invalid.*pattern|pattern.*invalid/i.test(text)) return "Invalid pattern";
  return text.split("\n", 1)[0]?.trim() || "Search failed";
}

function builtinErrorSentence(name: BuiltinName, text: string, args: Record<string, unknown>): string {
  switch (name) {
    case "read": return readErrorSentence(text);
    case "ls": return lsErrorSentence(text);
    case "edit": return editErrorSentence(text, args);
    case "write": return writeErrorSentence(text);
    case "find": return findErrorSentence(text);
    default: return text.split("\n", 1)[0]?.trim() || "Tool failed";
  }
}

function resultSections(
  name: BuiltinName,
  args: Record<string, unknown>,
  text: string,
  expanded: boolean,
  isError = false,
): ReturnType<typeof sections> {
  // C6: the payload sections do not render for a failed result.
  if (isError) return [];
  if (name === "ls") {
    if (!expanded) return [];
    const items = sortPathItems(pathItemsFromText(text));
    if (items.length === 0) return [];
    return sections(pathsSection("Entries", items, false));
  }
  if (name === "find") {
    if (!expanded) return [];
    const items = pathItemsFromText(text);
    if (items.length === 0) return [];
    return sections(pathsSection("Results", items, false));
  }
  if (name === "grep") {
    const items = grepMatchItems(text, stringValue(args.pattern));
    return sections(
      items.length > 0
        ? matchesSection("Matches", items, true)
        : undefined,
    );
  }
  if (!expanded) return [];
  if (name === "read") {
    const offset = typeof args.offset === "number" && Number.isFinite(args.offset) ? args.offset : 1;
    const continuation = parseReadContinuation(text);
    const contentText = continuation ? text.slice(0, text.length - continuation.hintText.length).trimEnd() : text;
    return sections(codeSection("Content", contentText, undefined, true, offset));
  }
  if (name === "write") {
    const content = typeof args.content === "string" ? args.content : text;
    return sections(codeSection("Content", content, undefined, true));
  }
  return [];
}

function countTextLines(text: string): number {
  return text ? text.split("\n").length : 0;
}

function plural(count: number, singular: string, pluralForm?: string): string {
  return `${count} ${count === 1 ? singular : (pluralForm ?? `${singular}s`)}`;
}

/**
 * Parse and strip the exit status that Pi's bash tool appends to its text.
 * Returns the cleaned display text and the parsed exit code, if any.
 */
function parseBashStatus(text: string): { cleanText: string; exitCode?: number; timedOut?: boolean } {
  const exitMatch = text.match(/\n*Command exited with code (\d+)\s*$/);
  if (exitMatch?.index !== undefined) {
    return { cleanText: text.slice(0, exitMatch.index).trimEnd(), exitCode: Number(exitMatch[1]) };
  }
  const timeoutMatch = text.match(/\n*Command timed out.*$/);
  if (timeoutMatch?.index !== undefined) {
    return { cleanText: text.slice(0, timeoutMatch.index).trimEnd(), timedOut: true };
  }
  const abortedMatch = text.match(/\n*Command aborted\s*$/);
  if (abortedMatch?.index !== undefined) {
    return { cleanText: text.slice(0, abortedMatch.index).trimEnd() };
  }
  return { cleanText: text.trimEnd() };
}

/**
 * Bash-specific result description: strips exit statements, keeps the
 * tail-bounded output, and states the exit code only when non-zero.
 */
function bashResultDescription(
  args: Record<string, unknown>,
  result: AgentToolResult<unknown>,
  partial: boolean,
  expanded: boolean,
  cwd: string,
): DisplayDescriptionV1 {
  const rawText = textContent(result);
  const isErrorResult = (result as AgentToolResult<unknown> & { isError?: boolean }).isError === true;
  const { cleanText, exitCode, timedOut } = parseBashStatus(rawText);
  const outputLines = countTextLines(cleanText);

  // Summary row: exit code on failure, line count on success.
  let summary: string;
  if (timedOut) {
    const timeoutMs = typeof args.timeout === "number" && Number.isFinite(args.timeout) ? args.timeout : 30_000;
    summary = `Timed out after ${(timeoutMs / 1000).toFixed(1)}s`;
  } else if (isErrorResult && exitCode !== undefined) {
    summary = `Exited with code ${exitCode}`;
  } else if (isErrorResult) {
    summary = cleanText || "Command failed";
  } else {
    summary = outputLines === 0 ? "No output" : plural(outputLines, "line");
  }

  const isTruncated = outputLines > DEFAULT_DISPLAY_POLICY.previewLines;
  const command = stringValue(args.command);
  const showCommand = expanded && command && (command.length > 60 || command.includes("\n"));

  return {
    version: 1,
    tool: "bash",
    family: "execution",
    lifecycle: isErrorResult ? "failed" : partial ? "running" : "completed",
    title: "Bash",
    ...builtinTarget("bash", args, cwd),
    truncated: (!isErrorResult && isTruncated) || undefined,
    sections: expanded
      ? sections(
        showCommand ? codeSection("Command", command, "bash", false) : undefined,
        cleanText ? codeSection("Output", cleanText, "text", false) : undefined,
      )
      : [],
    ...(cleanText ? { preview: { text: cleanText, tailOnly: true } } : {}),
    summary,
  };
}

/**
 * C4 collapsed summary sentence for the Pi built-ins, composed from the
 * result details, the arguments, and the result text.
 */
function builtinSummary(
  name: BuiltinName,
  args: Record<string, unknown>,
  details: Record<string, unknown> | undefined,
  text: string,
  cwd: string,
  writeKind?: "create" | "overwrite",
): string | undefined {
  if (name === "read") {
    const continuation = parseReadContinuation(text);
    const contentText = continuation ? text.slice(0, text.length - continuation.hintText.length).trimEnd() : text;
    const returned = countTextLines(contentText);
    if (returned === 0) return "Empty file";
    const bytes = Buffer.byteLength(contentText);
    if (continuation) {
      return `${returned} of ${continuation.totalLines} lines · continue at offset ${continuation.nextOffset}`;
    }
    return `${plural(returned, "line")} · ${formatBytes(bytes)}`;
  }
  if (name === "ls") {
    const items = pathItemsFromText(text);
    const directories = items.filter((item) => item.kind === "directory").length;
    const files = items.filter((item) => item.kind !== "directory").length;
    if (directories === 0 && files === 0) return "Empty directory";
    const parts: string[] = [];
    if (directories > 0) parts.push(`${directories} ${directories === 1 ? "directory" : "directories"}`);
    if (files > 0) parts.push(plural(files, "file"));
    const shown = Math.min(items.length, MAX_DISPLAY_PATHS);
    if (items.length > shown) parts.push(`${items.length - shown} not shown`);
    return parts.join(" · ");
  }
  if (name === "find") {
    const items = pathItemsFromText(text);
    const root = stringValue(args.path) ?? ".";
    const count = items.length;
    if (count === 0) return "No files found";
    const rootLabel = root === "." ? "" : ` in ${formatDisplayPath(root, cwd)}`;
    const shown = Math.min(count, MAX_DISPLAY_PATHS);
    const overflow = count > shown ? ` · ${count - shown} not shown` : "";
    return `${plural(count, "file")}${rootLabel}${overflow}`;
  }
  if (name === "grep") {
    const items = grepMatchItems(text, stringValue(args.pattern));
    if (items.length === 0) return "No matches";
    const files = new Set(items.map((item) => item.path)).size;
    return `${plural(items.length, "match", "matches")} in ${plural(files, "file")}`;
  }
  if (name === "bash") {
    const lines = countTextLines(text.trimEnd());
    return lines === 0 ? "No output" : plural(lines, "line");
  }
  if (name === "write") {
    const content = typeof args.content === "string" ? args.content : text;
    const lines = countTextLines(content);
    const verb = writeKind === "create" ? "Created" : writeKind === "overwrite" ? "Overwrote" : "Wrote";
    return `${verb} · ${plural(lines, "line")} · ${formatBytes(Buffer.byteLength(content))}`;
  }
  if (name === "edit") {
    const edits = Array.isArray(args.edits) ? args.edits.length : undefined;
    const patch = typeof details?.patch === "string" ? details.patch : typeof details?.diff === "string" ? details.diff : "";
    let added = 0;
    let removed = 0;
    let contentLines = 0;
    for (const line of patch.split("\n")) {
      if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")) continue;
      if (line.startsWith("+")) { added += 1; contentLines += 1; }
      else if (line.startsWith("-")) { removed += 1; contentLines += 1; }
      else if (line.length > 0) contentLines += 1;
    }
    const head = edits !== undefined ? plural(edits, "replacement") : undefined;
    const counts = added + removed > 0 ? `+${added} −${removed}` : undefined;
    const overflow = contentLines > DEFAULT_DISPLAY_POLICY.previewLines ? `${contentLines - DEFAULT_DISPLAY_POLICY.previewLines} more diff lines` : undefined;
    return [head, counts, overflow].filter((part) => part !== undefined).join(" · ") || undefined;
  }
  return undefined;
}

function resultDescription(
  name: BuiltinName,
  args: Record<string, unknown>,
  result: AgentToolResult<unknown>,
  partial: boolean,
  cwd: string,
  writeKind?: "create" | "overwrite",
): DisplayDescriptionV1 {
  const text = textContent(result);
  const details = result.details && typeof result.details === "object"
    ? result.details as Record<string, unknown>
    : undefined;
  const truncation = details?.truncation && typeof details.truncation === "object"
    ? details.truncation as Record<string, unknown>
    : undefined;
  const isErrorResult = (result as AgentToolResult<unknown> & { isError?: boolean }).isError === true;
  // C6: the error row states one human sentence; the raw platform text
  // moves to errorRaw and renders exactly once as an expanded ERROR section.
  const sentence = isErrorResult
    ? builtinErrorSentence(name, text, args)
    : undefined;
  const summarySentence = isErrorResult ? undefined : builtinSummary(name, args, details, text, cwd, writeKind);
  // Detect bounded results for the truncated badge.
  const readContinuation = name === "read" ? parseReadContinuation(text) : undefined;
  const readContentText = readContinuation ? text.slice(0, text.length - readContinuation.hintText.length).trimEnd() : text;
  const readReturnedLines = name === "read" ? countTextLines(readContentText) : undefined;
  const isTruncated = truncation?.truncated === true
    || readContinuation !== undefined
    || (name === "ls" && (details?.entryLimitReached !== undefined || truncation?.truncated === true))
    || (name === "find" && (details?.resultLimitReached !== undefined || truncation?.truncated === true))
    || (name === "grep" && grepMatchItems(text, stringValue(args.pattern)).length + new Set(grepMatchItems(text, stringValue(args.pattern)).map((i) => i.path)).size > DEFAULT_DISPLAY_POLICY.previewLines)
    || (name === "write" && typeof args.content === "string" && args.content.replace(/\r\n?/g, "\n").split("\n").length > DEFAULT_DISPLAY_POLICY.previewLines);
  const description: DisplayDescriptionV1 = {
    version: 1,
    tool: name,
    family: name === "bash" ? "execution" : name === "grep" ? "search" : "filesystem",
    lifecycle: isErrorResult ? "failed" : partial ? "running" : "completed",
    title: builtinTitle(name),
    ...builtinTarget(name, args, cwd, readReturnedLines),
    truncated: isTruncated || undefined,
    sections: resultSections(name, args, text, !partial, isErrorResult),
    ...(sentence ? { error: sentence, ...(text && text !== sentence ? { errorRaw: text } : {}) } : {}),
    ...(summarySentence ? { summary: summarySentence } : {}),
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
  // write keeps a bounded content preview in the collapsed body. The
  // projected call diff is handled separately in describeCallAsync.
  if (name === "write" && typeof args.content === "string" && !isErrorResult) {
    return { ...description, preview: { text: args.content } };
  }
  // ls, find, read, and grep produce structured sections or just a summary;
  // suppress the flat text preview so the structured render or the summary
  // row is the sole body content.
  if (isErrorResult) {
    return description;
  }
  if ((name === "ls" || name === "find" || name === "grep" || name === "read") && description.sections && description.sections.length > 0) {
    return description;
  }
  // read with no sections (collapsed or empty) must not show a text preview.
  if (name === "read") {
    return description;
  }
  return text ? { ...description, preview: { text } } : description;
}

function writePreviewKey(args: Record<string, unknown>): string {
  const path = typeof args.path === "string" ? args.path : "";
  const content = typeof args.content === "string" ? args.content : "";
  return createHash("sha256").update(path).update("\0").update(content).digest("hex");
}

/**
 * Derive an explicit lifecycle for Pi built-ins (Read, Edit, Write,
 * List, Find, Grep, Bash).
 */
function builtinLifecycle(
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
      const desc = callDescription(name, args as Record<string, unknown>, cwd, context.executionStarted);
      return (name === "read" || name === "edit" || name === "write" || name === "ls" || name === "find" || name === "grep" || name === "bash")
        ? { ...desc, lifecycle: builtinLifecycle(context, "call") }
        : desc;
    },
    ...(name === "write" ? {
      callDescriptionKey(args: Record<string, unknown>) {
        return writePreviewKey(args);
      },
      async describeCallAsync(args: Record<string, unknown>, context: { executionStarted: boolean; argsComplete: boolean; state: unknown }) {
        const path = typeof args.path === "string" ? args.path : "";
        const content = typeof args.content === "string" ? args.content : "";
        const base = callDescription(name, args, cwd, context.executionStarted);
        const preview = await inspectWritePreview(cwd, path, content);
        if (preview.kind === "create") {
          (context.state as Record<string, unknown>).writePreviewKind = "create";
          return { ...base, target: formatDisplayPath(preview.path, cwd), targetKind: "path" as const, lifecycle: builtinLifecycle({ ...context, isPartial: false, isError: false }, "call"), qualifiers: ["projected"], diff: { path: preview.path, before: "", after: preview.after, projected: true } };
        }
        if (preview.kind === "overwrite") {
          (context.state as Record<string, unknown>).writePreviewKind = "overwrite";
          return { ...base, target: formatDisplayPath(preview.path, cwd), targetKind: "path" as const, lifecycle: builtinLifecycle({ ...context, isPartial: false, isError: false }, "call"), qualifiers: ["projected"], diff: { path: preview.path, before: preview.before, after: preview.after, projected: true } };
        }
        return {
          ...base,
          ...(preview.path ? { target: formatDisplayPath(preview.path, cwd), targetKind: "path" as const } : {}),
          rows: [...(base.rows ?? []), { text: `projected preview unavailable: ${preview.reason}`, tone: "muted" }],
        };
      },
    } : {}),
    describeResult(result, options, context) {
      // Bash has a dedicated result description that strips exit
      // statements, keeps the tail-bounded output, and states the
      // exit code only when non-zero.
      if (name === "bash") {
        return bashResultDescription(
          context.args as Record<string, unknown>,
          result,
          options.isPartial,
          options.expanded,
          cwd,
        );
      }
      const writeKind = name === "write" ? (context.state as Record<string, unknown>)?.writePreviewKind as "create" | "overwrite" | undefined : undefined;
      const desc = resultDescription(name, context.args as Record<string, unknown>, result, options.isPartial, cwd, writeKind);
      return (name === "read" || name === "edit" || name === "write" || name === "ls" || name === "find" || name === "grep")
        ? { ...desc, lifecycle: builtinLifecycle(context, "result") }
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
