import { stripVTControlCharacters } from "node:util";

const AUTH_HEADER_PATTERN = /(authorization\s*:\s*)[^,;\r\n]+/gi;
const SECRET_ASSIGNMENT_PATTERN = /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[=:]\s*)([^\s,;]+)/gi;
const BEARER_PATTERN = /(bearer\s+)[A-Za-z0-9._~+/=-]+/gi;

export function sanitizeSubagentDisplay(value: unknown): string {
  return stripVTControlCharacters(typeof value === "string" ? value : String(value ?? ""))
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "   ")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
    .replace(AUTH_HEADER_PATTERN, "$1[REDACTED]")
    .replace(SECRET_ASSIGNMENT_PATTERN, "$1[REDACTED]")
    .replace(BEARER_PATTERN, "$1[REDACTED]");
}
