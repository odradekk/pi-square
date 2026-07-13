import { stripVTControlCharacters } from "node:util";
import { Text } from "@earendil-works/pi-tui";

/**
 * Produces a compact URL label for tool-call summaries and result chrome.
 * Returns a string for every input without throwing, falling back to a truncated raw value when URL parsing fails.
 * Preserves the original host casing from valid URLs and truncates only the displayed path or raw fallback text.
 */
export function shortenUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.length > 30 ? parsed.pathname.slice(0, 27) + "..." : parsed.pathname;
    return parsed.host + path;
  } catch {
    return url.length > 50 ? url.slice(0, 47) + "..." : url;
  }
}

/**
 * Produces a stable URL key for client-side result de-duplication.
 * Returns a string for every input without throwing, using a trimmed raw fallback when URL parsing fails.
 * Strips a leading `www.`, removes fragments, trailing path slashes, and common tracking parameters
 * (`utm_*`, `gclid`, `fbclid`, `msclkid`); sorts remaining query parameters; preserves protocol, host (lowercased),
 * path case, and meaningful query parameters.
 */
export function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.host.replace(/^www\./, "").toLowerCase();
    const path = parsed.pathname.replace(/\/+$/, "");
    const params = new URLSearchParams(parsed.searchParams);
    for (const key of [...new Set(params.keys())]) {
      const lower = key.toLowerCase();
      if (lower.startsWith("utm_") || lower === "gclid" || lower === "fbclid" || lower === "msclkid") {
        params.delete(key);
      }
    }
    params.sort();
    const query = params.toString();
    return `${parsed.protocol}//${host}${path}${query ? `?${query}` : ""}`;
  } catch {
    return url.replace(/\/+$/, "");
  }
}

/** Removes terminal escape sequences and non-printing controls from display-only text. */
export function sanitizeTerminalText(value: string): string {
  return stripVTControlCharacters(String(value))
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
    .replace(/\r\n?/g, "\n");
}

function markdownFenceCandidate(line: string): string {
  let candidate = line;
  while (/^ {0,3}> ?/.test(candidate)) candidate = candidate.replace(/^ {0,3}> ?/, "");
  return candidate.replace(/^ {0,3}(?:(?:[-+*]|\d+[.)])\s+)? {0,3}/, "");
}

function isEscapedAt(text: string, index: number): boolean {
  let slashes = 0;
  for (let i = index - 1; i >= 0 && text[i] === "\\"; i--) slashes++;
  return slashes % 2 === 1;
}

function neutralizeMarkdownLinks(line: string): string {
  let output = "";
  for (let i = 0; i < line.length;) {
    if (line[i] === "`") {
      let runLength = 1;
      while (line[i + runLength] === "`") runLength++;
      const marker = "`".repeat(runLength);
      const closing = line.indexOf(marker, i + runLength);
      if (closing >= 0) {
        output += line.slice(i, closing + runLength);
        i = closing + runLength;
        continue;
      }
    }
    if (line[i] === "[" && !isEscapedAt(line, i)) {
      output += "\\[";
      i++;
      continue;
    }
    if (
      line[i] === "<"
      && !isEscapedAt(line, i)
      && /^[A-Za-z][A-Za-z\d+.-]*:/.test(line.slice(i + 1))
    ) {
      output += "\\<";
      i++;
      continue;
    }
    output += line[i];
    i++;
  }
  return output;
}

/**
 * Sanitizes untrusted Markdown for terminal rendering without changing model-facing content.
 * Source-authored links are rendered inert outside code; the tool adds its own validated
 * HTTP(S) heading links separately.
 */
export function sanitizeMarkdownForTerminal(value: string): string {
  const lines = sanitizeTerminalText(value).split("\n");
  let fence: { marker: "`" | "~"; length: number } | undefined;

  return lines.map((line) => {
    const candidate = markdownFenceCandidate(line);
    if (fence) {
      const closing = new RegExp(`^${fence.marker}{${fence.length},}\\s*$`);
      if (closing.test(candidate)) fence = undefined;
      return line;
    }

    const opening = /^(`{3,}|~{3,})(.*)$/.exec(candidate);
    if (opening && (opening[1][0] === "~" || !opening[2].includes("`"))) {
      fence = { marker: opening[1][0] as "`" | "~", length: opening[1].length };
      return line;
    }

    let unquoted = line;
    while (/^ {0,3}> ?/.test(unquoted)) unquoted = unquoted.replace(/^ {0,3}> ?/, "");
    if (/^(?: {4}|\t)/.test(unquoted)) return line;
    return neutralizeMarkdownLinks(line);
  }).join("\n");
}

/** Escapes untrusted plain text before placing it in Markdown labels or prose. */
export function escapeMarkdownText(value: string): string {
  return sanitizeTerminalText(value).replace(/\s+/g, " ").trim().replace(/([\\`*_[\]<>#])/g, "\\$1");
}

/** Formats a safe HTTP(S) Markdown link, falling back to escaped plain text. */
export function formatMarkdownLink(label: string, url: string): string {
  const safeUrl = sanitizeTerminalText(url).trim();
  const escapedLabel = escapeMarkdownText(label || safeUrl);
  try {
    const parsed = new URL(safeUrl);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return `[${escapedLabel}](<${parsed.toString()}>)`;
    }
  } catch {
    // Fall through to inert text for malformed or unsupported URLs.
  }
  return `${escapedLabel} (${escapeMarkdownText(safeUrl)})`;
}

/** Formats a safe HTTP(S) URL as a visible Markdown autolink. */
export function formatMarkdownUrl(url: string): string {
  const safeUrl = sanitizeTerminalText(url).trim();
  try {
    const parsed = new URL(safeUrl);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return `<${parsed.toString()}>`;
    }
  } catch {
    // Fall through to inert text for malformed or unsupported URLs.
  }
  return escapeMarkdownText(safeUrl);
}

/**
 * Builds the shared themed title block used by tool renderers.
 * Returns a `Text` node and lets theme formatting errors surface to the caller.
 * Preserves detail ordering and appends suffix text exactly as supplied after the accent segment.
 */
export function renderToolTitle(theme: any, name: string, accent: string, details: string[] = [], suffix = ""): Text {
  let text = theme.fg("toolTitle", theme.bold(`${name} `)) + theme.fg("accent", accent);
  if (suffix) {
    text += theme.fg("muted", suffix);
  }
  for (const line of details) {
    text += "\n  " + theme.fg("dim", line);
  }
  return new Text(text, 0, 0);
}

/**
 * Builds the shared themed error line for tool renderers.
 * Returns a `Text` node and lets theme formatting errors surface to the caller.
 * Applies only the package-standard error glyph and color, without altering the message text.
 */
export function renderError(theme: any, message: string): Text {
  return new Text(theme.fg("error", `✗ ${message}`), 0, 0);
}

/**
 * Builds the shared empty-result placeholder for tool renderers.
 * Returns a `Text` node and lets theme formatting errors surface to the caller.
 * Normalizes empty states to the same dimmed `No result` label across tools.
 */
export function renderNoResult(theme: any): Text {
  return new Text(theme.fg("dim", "✗ No result"), 0, 0);
}

/**
 * Appends a bounded preview of text content to an existing rendered string.
 * Returns the original string unchanged for non-text content and otherwise adds up to `maxLines` preview lines.
 * Counts lines with a simple newline split and adds an omitted-line summary when content exceeds the preview limit.
 */
export function appendTextPreview(text: string, content: any, theme: any, maxLines: number): string {
  if (content?.type !== "text") return text;
  const lines = content.text.split("\n");
  for (const line of lines.slice(0, maxLines)) {
    text += "\n" + theme.fg("dim", line);
  }
  if (lines.length > maxLines) {
    text += "\n" + theme.fg("muted", `… ${lines.length - maxLines} more lines`);
  }
  return text;
}
