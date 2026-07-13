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
