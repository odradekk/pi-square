import { stripVTControlCharacters } from "node:util";

const AUTH_HEADER_PATTERN = /(authorization\s*:\s*)[^,;\r\n]+/gi;
const SECRET_ASSIGNMENT_PATTERN = /((?:api[_-]?key|token|access[_-]?token|refresh[_-]?token|password|passphrase|secret)\s*[=:]\s*)([^\s,;]+)/gi;
const BEARER_PATTERN = /(bearer\s+)[A-Za-z0-9._~+/=-]+/gi;
const GITHUB_TOKEN_PATTERN = /\b(?:github_pat_|ghp_|gho_|ghu_|ghs_|ghr_)[A-Za-z0-9_]+\b/g;
const FIRECRAWL_TOKEN_PATTERN = /\bfc-[A-Za-z0-9_-]+\b/g;

export interface SanitizeDisplayOptions {
  readonly multiline?: boolean;
  readonly exactSecrets?: readonly string[];
  readonly tabs?: "escape" | "spaces";
}

function escapeControl(codePoint: number): string {
  return codePoint <= 0xff
    ? `\\x${codePoint.toString(16).padStart(2, "0")}`
    : `\\u${codePoint.toString(16).padStart(4, "0")}`;
}

export function redactDisplaySecrets(value: string, exactSecrets: readonly string[] = []): string {
  let output = value
    .replace(AUTH_HEADER_PATTERN, "$1[REDACTED]")
    .replace(SECRET_ASSIGNMENT_PATTERN, "$1[REDACTED]")
    .replace(BEARER_PATTERN, "$1[REDACTED]")
    .replace(GITHUB_TOKEN_PATTERN, "[REDACTED]")
    .replace(FIRECRAWL_TOKEN_PATTERN, "[REDACTED]");
  const secrets = [...new Set(exactSecrets.filter((secret) => secret.length > 0))]
    .sort((left, right) => right.length - left.length);
  for (const secret of secrets) output = output.split(secret).join("[REDACTED]");
  return output;
}

export function sanitizeDisplayText(value: unknown, options: SanitizeDisplayOptions = {}): string {
  const multiline = options.multiline !== false;
  const tabs = options.tabs ?? "spaces";
  const stripped = stripVTControlCharacters(String(value ?? "")).replace(/\r\n?/g, "\n");
  let output = "";
  for (const character of stripped) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint === 0x0a) output += multiline ? "\n" : "\\n";
    else if (codePoint === 0x09) output += tabs === "spaces" ? "   " : "\\t";
    else if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      output += escapeControl(codePoint);
    } else output += character;
  }
  return redactDisplaySecrets(output, options.exactSecrets);
}

export function sanitizeDisplayLine(value: unknown, exactSecrets: readonly string[] = []): string {
  return sanitizeDisplayText(value, { multiline: false, exactSecrets, tabs: "escape" });
}

function markdownFenceCandidate(line: string): string {
  let candidate = line;
  while (/^ {0,3}> ?/.test(candidate)) candidate = candidate.replace(/^ {0,3}> ?/, "");
  return candidate.replace(/^ {0,3}(?:(?:[-+*]|\d+[.)])\s+)? {0,3}/, "");
}

function escapedAt(text: string, index: number): boolean {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function neutralizeMarkdownLinks(line: string): string {
  let output = "";
  for (let index = 0; index < line.length;) {
    if (line[index] === "`") {
      let run = 1;
      while (line[index + run] === "`") run += 1;
      const marker = "`".repeat(run);
      const closing = line.indexOf(marker, index + run);
      if (closing >= 0) {
        output += line.slice(index, closing + run);
        index = closing + run;
        continue;
      }
    }
    if (line[index] === "[" && !escapedAt(line, index)) {
      output += "\\[";
      index += 1;
      continue;
    }
    if (line[index] === "<" && !escapedAt(line, index) && /^[A-Za-z][A-Za-z\d+.-]*:/.test(line.slice(index + 1))) {
      output += "\\<";
      index += 1;
      continue;
    }
    const scheme = /^[A-Za-z][A-Za-z\d+.-]*:/.exec(line.slice(index));
    const boundary = index === 0 || !/[A-Za-z\d+.-]/.test(line[index - 1]!);
    if (scheme && boundary) {
      output += `${scheme[0].slice(0, -1)}\\:`;
      index += scheme[0].length;
      continue;
    }
    const www = /^www\./i.exec(line.slice(index));
    if (www && boundary) {
      output += `${www[0].slice(0, 3)}\\.`;
      index += www[0].length;
      continue;
    }
    const email = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/.exec(line.slice(index));
    if (email && (index === 0 || !/[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]/.test(line[index - 1]!))) {
      output += email[0].replace("@", "\\@");
      index += email[0].length;
      continue;
    }
    output += line[index]!;
    index += 1;
  }
  return output;
}

export function sanitizeMarkdownForDisplay(value: unknown, exactSecrets: readonly string[] = []): string {
  const lines = sanitizeDisplayText(value, { exactSecrets }).split("\n");
  let fence: { marker: "`" | "~"; length: number } | undefined;
  return lines.map((line) => {
    const candidate = markdownFenceCandidate(line);
    if (fence) {
      if (new RegExp(`^${fence.marker}{${fence.length},}\\s*$`).test(candidate)) fence = undefined;
      return line;
    }
    const opening = /^(`{3,}|~{3,})(.*)$/.exec(candidate);
    if (opening && (opening[1]![0] === "~" || !opening[2]!.includes("`"))) {
      fence = { marker: opening[1]![0] as "`" | "~", length: opening[1]!.length };
      return line;
    }
    let unquoted = line;
    while (/^ {0,3}> ?/.test(unquoted)) unquoted = unquoted.replace(/^ {0,3}> ?/, "");
    return /^(?: {4}|\t)/.test(unquoted) ? line : neutralizeMarkdownLinks(line);
  }).join("\n");
}

export function safeHttpUrl(value: unknown): string | undefined {
  const clean = sanitizeDisplayLine(value).trim();
  try {
    const parsed = new URL(clean);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

export function truncateCodePoints(value: string, maximum: number, suffix = "\u2026"): string {
  const points = Array.from(value);
  if (points.length <= maximum) return value;
  const suffixPoints = Array.from(suffix);
  if (maximum <= suffixPoints.length) return suffixPoints.slice(0, Math.max(0, maximum)).join("");
  return points.slice(0, maximum - suffixPoints.length).join("") + suffix;
}
