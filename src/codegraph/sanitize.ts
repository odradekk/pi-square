import { stripVTControlCharacters } from "node:util";

export function sanitizeCodeGraphText(value: unknown): string {
  return stripVTControlCharacters(String(value ?? ""))
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
}
