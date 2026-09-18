import { stripVTControlCharacters } from "node:util";
import { redactDisplaySecrets } from "../display/sanitize";

/**
 * Display copy for subagent surfaces: control-free text redacted through the
 * shared display credential neutralizer's common credential forms. The
 * redaction is defense in depth for arbitrary timeline text, not a guarantee
 * that every credential spelling is recognized.
 */
export function sanitizeSubagentDisplay(value: unknown): string {
  return redactDisplaySecrets(
    stripVTControlCharacters(typeof value === "string" ? value : String(value ?? ""))
      .replace(/\r\n?/g, "\n")
      .replace(/\t/g, "   ")
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, ""),
  );
}
