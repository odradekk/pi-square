import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type {
  DisplayDescriptionV1,
  DisplayMatchItem,
  DisplayMetadataEntry,
  DisplayPathItem,
  DisplayRecordItem,
  DisplaySection,
} from "./types";

export type UnknownRecord = Record<string, unknown>;

/** True when a path.relative() result escapes its base directory. */
function escapesBase(path: string): boolean {
  return path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path);
}

/**
 * C2 path presentation: a path inside the working directory is relative to
 * it, a path under the home directory uses the `~` prefix, and anything else
 * stays absolute. Middle elision is width-aware and lives in layout.ts.
 */
export function formatDisplayPath(value: string, cwd: string): string {
  if (!value) return value;
  const home = homedir();
  const absolute = value === "~" || value.startsWith("~/") || value.startsWith(`~${sep}`)
    ? join(home, value.slice(1))
    : isAbsolute(value)
      ? value
      : resolve(cwd, value);
  const workspace = relative(cwd, absolute);
  if (workspace === "") return ".";
  if (!escapesBase(workspace)) return workspace;
  const homeRelative = relative(home, absolute);
  if (homeRelative === "") return "~";
  if (!escapesBase(homeRelative)) return `~${sep}${homeRelative}`;
  return absolute;
}

export function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : {};
}

/**
 * Mutation family: the only tools whose collapsed entries keep a bounded
 * evidence body below the single row — edit, insert, replace, and write. The
 * anchored mutations keep the strictest shape: their body is the
 * authoritative diff only.
 * Every other tool's collapsed entry is exactly one row; its evidence is
 * visible only when expanded.
 */
export const MUTATION_FAMILY_TOOLS: ReadonlySet<string> = new Set([
  "edit",
  "insert",
  "replace",
  "write",
]);

/**
 * C8 expanded sections that only restate the header (identity, target, and
 * status fields). Matched case-insensitively against the section title.
 */
export const RESTATING_SECTION_TITLES: ReadonlySet<string> = new Set([
  "file",
  "target",
  "directory",
  "query",
  "request",
  "summary",
  "action",
  "persistence",
  "status",
]);

/** Human byte size in the design-doc shape: `640 B`, `6.4 KB`, `2.1 MB`. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${Math.floor(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let scaled = bytes / 1024;
  let unitIndex = 0;
  while (scaled >= 1024 && unitIndex < units.length - 1) {
    scaled /= 1024;
    unitIndex += 1;
  }
  return `${scaled >= 100 ? Math.round(scaled) : scaled.toFixed(1)} ${units[unitIndex]}`;
}

/**
 * C4 collapsed summary sentence for the extension tools, composed from the
 * structured details every tool already returns. Returns undefined when no
 * counts are known; the caller then falls back to the first flat row.
 */
export function composeInternalSummary(
  name: string,
  detailsValue: unknown,
  text: string,
): string | undefined {
  const details = asRecord(detailsValue);
  const counts = asRecord(details.counts);
  const page = asRecord(details.page);

  if (name === "replace" || name === "insert") {
    const status = stringOf(details.status)?.toLowerCase();
    if (status === "warning") {
      const code = stringOf(details.errorCode);
      if (code === "E_RANGE_STALE") return "Nothing was modified · stale range";
      return `Nothing was modified · ${name} refused`;
    }
    const metrics = asRecord(details.metrics);
    const classification = stringOf(metrics.classification);
    if (classification === "noop") return "No changes";
    const attempted = numberOf(metrics.edits_attempted);
    if (attempted !== undefined) {
      const action = name === "insert"
        ? `${numberOf(metrics.added_lines) ?? attempted} ${numberOf(metrics.added_lines) === 1 ? "line" : "lines"} inserted`
        : `${attempted} ${attempted === 1 ? "range" : "ranges"} replaced`;
      const added = numberOf(metrics.added_lines);
      const removed = numberOf(metrics.removed_lines);
      const changes = added !== undefined || removed !== undefined
        ? ` · +${added ?? 0}/-${removed ?? 0} lines`
        : "";
      return `${action}${changes}`;
    }
  }

  if (name === "todo" && numberOf(counts.total) !== undefined) {
    const parts = [`${counts.total} tasks`];
    if (numberOf(counts.completed)) parts.push(`${counts.completed} completed`);
    if (numberOf(counts.inProgress)) parts.push(`${counts.inProgress} in progress`);
    if (numberOf(counts.pending)) parts.push(`${counts.pending} pending`);
    return parts.join(" · ");
  }

  if (name === "pwsh") {
    const outputLines = text ? text.split("\n").length : 0;
    return outputLines === 0 ? "No output" : `${outputLines} lines`;
  }

  if (name === "web_fetch") {
    const succeeded = numberOf(details.succeeded);
    if (succeeded !== undefined) {
      const head = `${succeeded} ${succeeded === 1 ? "page" : "pages"} fetched`;
      const failed = numberOf(details.failed) ?? 0;
      return failed > 0 ? `${head} · ${failed} failed` : head;
    }
  }

  const returned = numberOf(page.returned) ?? numberOf(details.returned);
  const total = numberOf(page.total) ?? numberOf(details.total) ?? numberOf(details.totalMatches);
  if (returned !== undefined) {
    const noun = "results";
    if (returned === 0) return `No ${noun}`;
    const head = total !== undefined && total > returned
      ? `${returned} of ${total} ${noun}`
      : `${total ?? returned} ${noun}`;
    if (page.hasMore === true || details.hasMore === true) {
      const offset = numberOf(page.nextOffset) ?? ((numberOf(page.offset) ?? 0) + returned);
      return `${head} · continue at offset ${offset}`;
    }
    return head;
  }

  const countEntries = Object.entries(counts).slice(0, 8);
  if (countEntries.length > 0) {
    return countEntries.map(([key, value]) => `${key} ${String(value)}`).join(" · ");
  }
  return stringOf(details.message);
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function numberOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function booleanOf(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function textOf(result: AgentToolResult<unknown>): string {
  return Array.isArray(result.content)
    ? result.content
      .filter((item): item is { type: "text"; text: string } => item?.type === "text" && typeof (item as { text?: unknown }).text === "string")
      .map((item) => item.text)
      .join("\n")
    : "";
}

export function field(label: string, value: unknown, tone?: DisplayMetadataEntry["tone"]): DisplayMetadataEntry | undefined {
  if (value === undefined || value === "") return undefined;
  return { label, value: String(value), ...(tone ? { tone } : {}) };
}

export function metadata(entries: Array<DisplayMetadataEntry | undefined>): DisplayMetadataEntry[] {
  return entries.filter((entry): entry is DisplayMetadataEntry => Boolean(entry));
}

export function pageMetadata(page: UnknownRecord): DisplayMetadataEntry[] {
  return metadata([
    field("offset", page.offset),
    field("returned", page.returned),
    field("total", page.total),
    field("next", page.nextOffset),
    page.hasMore === true ? field("hasMore", "true", "warning") : undefined,
  ]);
}

export function summarySection(title: string, entries: Array<DisplayMetadataEntry | undefined>, compact = false): DisplaySection | undefined {
  const items = metadata(entries);
  return items.length > 0
    ? { title, blocks: [{ kind: "list", items }], compact }
    : undefined;
}

export function recordsSection(title: string, items: DisplayRecordItem[], compact = false): DisplaySection | undefined {
  return items.length > 0 ? { title, blocks: [{ kind: "records", items }], compact } : undefined;
}

export function pathsSection(title: string, items: DisplayPathItem[], compact = false): DisplaySection | undefined {
  return items.length > 0 ? { title, blocks: [{ kind: "paths", items }], compact } : undefined;
}

export function matchesSection(title: string, items: DisplayMatchItem[], compact = false): DisplaySection | undefined {
  return items.length > 0 ? { title, blocks: [{ kind: "matches", items }], compact } : undefined;
}

export function textSection(title: string, text: string | undefined, tone?: "default" | "muted" | "accent" | "success" | "warning" | "error", compact = false): DisplaySection | undefined {
  return text
    ? { title, blocks: [{ kind: "text", text, ...(tone ? { tone } : {}) }], compact }
    : undefined;
}

export function markdownSection(title: string, text: string | undefined): DisplaySection | undefined {
  return text ? { title, blocks: [{ kind: "markdown", text }], compact: false } : undefined;
}

export function codeSection(
  title: string,
  text: string | undefined,
  language?: string,
  lineNumbers = true,
  startLine?: number,
): DisplaySection | undefined {
  return text ? { title, blocks: [{ kind: "code", text, ...(language ? { language } : {}), lineNumbers, ...(startLine !== undefined ? { startLine } : {}) }], compact: false } : undefined;
}

export function sections(...values: Array<DisplaySection | undefined>): DisplaySection[] {
  return values.filter((section): section is DisplaySection => Boolean(section));
}

export function baseDescription(
  current: DisplayDescriptionV1,
  additions: Partial<DisplayDescriptionV1>,
): DisplayDescriptionV1 {
  return { ...current, ...additions };
}

/** Pluralize a count noun: `3 files`, `1 file`. */
export function plural(count: number, singular: string, pluralForm?: string): string {
  return `${count} ${count === 1 ? singular : (pluralForm ?? `${singular}s`)}`;
}

/**
 * Convert an ISO timestamp to a relative age string: `22h ago`, `9d ago`,
 * `just now`. Returns `unknown` when the timestamp is missing or invalid.
 */
export function formatRelativeAge(timestamp: unknown, now: number = Date.now()): string {
  const iso = stringOf(timestamp);
  if (!iso) return "unknown";
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return "unknown";
  const seconds = Math.max(0, Math.round((now - parsed) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.round(months / 12)}y ago`;
}
