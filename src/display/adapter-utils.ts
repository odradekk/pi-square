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

export function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : {};
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

export function summarySection(title: string, entries: Array<DisplayMetadataEntry | undefined>): DisplaySection | undefined {
  const items = metadata(entries);
  return items.length > 0
    ? { title, blocks: [{ kind: "list", items }] }
    : undefined;
}

export function recordsSection(title: string, items: DisplayRecordItem[], compact = false): DisplaySection | undefined {
  return items.length > 0 ? { title, blocks: [{ kind: "records", items }], compact } : undefined;
}

export function pathsSection(title: string, items: DisplayPathItem[]): DisplaySection | undefined {
  return items.length > 0 ? { title, blocks: [{ kind: "paths", items }], compact: false } : undefined;
}

export function matchesSection(title: string, items: DisplayMatchItem[]): DisplaySection | undefined {
  return items.length > 0 ? { title, blocks: [{ kind: "matches", items }], compact: false } : undefined;
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
): DisplaySection | undefined {
  return text ? { title, blocks: [{ kind: "code", text, ...(language ? { language } : {}), lineNumbers }], compact: false } : undefined;
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
