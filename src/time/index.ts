import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// Provides the `time` tool. Time was previously injected as a prefix on
// every interactive user message; that was removed in favour of an
// explicit tool so the model reads the clock only when it actually
// needs to, and the user input stream stays untouched.

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function formatOffset(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function resolveTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "Unknown";
  } catch {
    return "Unknown";
  }
}

function formatNow(): string {
  const now = new Date();
  const y = now.getFullYear();
  const mo = pad(now.getMonth() + 1);
  const d = pad(now.getDate());
  const h = pad(now.getHours());
  const mi = pad(now.getMinutes());
  const s = pad(now.getSeconds());
  const offset = formatOffset(now);
  const tz = resolveTimezone();
  return [
    `${y}-${mo}-${d} ${h}:${mi}:${s}`,
    `ISO 8601: ${y}-${mo}-${d}T${h}:${mi}:${s}${offset}`,
    `Timezone: ${tz} (UTC${offset})`,
  ].join("\n");
}

export default function timeTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "time",
    label: "Time",
    description:
      "Return the current local date and time. Output includes year-month-day, hour:minute:second, ISO 8601 with offset, and IANA timezone. Call when the current date or time is genuinely needed; do not assume or fabricate.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      return {
        content: [{ type: "text" as const, text: formatNow() }],
        details: {},
      };
    },
  });
}
