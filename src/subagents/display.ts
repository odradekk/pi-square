import { stripVTControlCharacters } from "node:util";
import { redactDisplaySecrets } from "../display/sanitize";

/**
 * Display copy for subagent surfaces: control-free text redacted through the
 * shared display credential neutralizer, so bash/pwsh summaries and any other
 * timeline text can never carry credential values.
 */
export function sanitizeSubagentDisplay(value: unknown): string {
  return redactDisplaySecrets(
    stripVTControlCharacters(typeof value === "string" ? value : String(value ?? ""))
      .replace(/\r\n?/g, "\n")
      .replace(/\t/g, "   ")
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, ""),
  );
}
