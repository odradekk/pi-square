/**
 * Background subagent completion messages.
 *
 * The completion message is the deliberate native-shell exception: Pi owns the
 * success/error message shell, while the bounded result inside it uses the same
 * canonical operational description as the `delegate` transcript entry.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Box, Spacer, Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { OperationalDisplayComponent } from "../display/components";
import { DEFAULT_DISPLAY_POLICY } from "../display/types";
import { sanitizeSubagentDisplay } from "./display";
import { describeSubagentRun } from "./display-adapter";
import type {
  AnySubagentNotificationDetails,
  LegacySubagentNotificationDetails,
  SubagentRunDetails,
} from "./types";

export { sanitizeSubagentDisplay } from "./display";

class OneVisualLine implements Component {
  constructor(private readonly text: string) {}

  render(width: number): string[] {
    return [truncateToWidth(this.text, Math.max(1, width), "\u2026")];
  }

  invalidate(): void {}
}

function isRunDetails(value: unknown): value is SubagentRunDetails {
  const details = value as Partial<SubagentRunDetails> | undefined;
  return details?.version === 3
    && typeof details.id === "string"
    && (details.mode === "fg" || details.mode === "bg" || details.mode === "resume")
    && (details.phase === "running" || details.phase === "cancelling" || details.phase === "done" || details.phase === "error" || details.phase === "aborted");
}

interface NotificationEntry {
  status: "done" | "error" | "aborted";
  result: SubagentRunDetails;
}

/**
 * Reads the runs of one completion message. A V4 delivery carries a list of
 * results; a V3 message persisted by an earlier session carries exactly one.
 */
function notificationEntries(details: AnySubagentNotificationDetails | undefined): NotificationEntry[] {
  if (!details) return [];
  if ("results" in details && Array.isArray(details.results)) {
    return details.results
      .filter((entry) => isRunDetails(entry?.result))
      .map((entry) => ({ status: entry.status, result: entry.result }));
  }
  const legacy = details as LegacySubagentNotificationDetails;
  return isRunDetails(legacy.result) ? [{ status: legacy.status, result: legacy.result }] : [];
}

export function renderSubagentNotification(
  message: { content?: unknown; details?: AnySubagentNotificationDetails },
  options: { expanded: boolean },
  theme: Theme,
): Component {
  const entries = notificationEntries(message.details);
  const error = entries.some((entry) => (
    entry.status === "error"
    || entry.status === "aborted"
    || entry.result.phase === "error"
    || entry.result.phase === "aborted"
  ));
  const shell = new Box(1, 1, (text) => theme.bg(error ? "toolErrorBg" : "toolSuccessBg", text));
  if (entries.length === 0) {
    const fallback = sanitizeSubagentDisplay(message.content || "Background subagent notification");
    shell.addChild(options.expanded ? new Text(fallback, 0, 0) : new OneVisualLine(fallback));
    return shell;
  }

  // One delivery may carry several runs. Each run reuses the canonical
  // description of the `delegate` transcript entry; only a single-run delivery
  // can fall back to the message text, because that text describes one run.
  const fallbackText = entries.length === 1 ? sanitizeSubagentDisplay(message.content ?? "") : "";
  entries.forEach((entry, index) => {
    if (index > 0) shell.addChild(new Spacer(1));
    const description = describeSubagentRun(
      "delegate",
      entry.result,
      {
        expanded: options.expanded,
        isPartial: false,
        isError: entry.status === "error",
      },
      fallbackText,
    );
    shell.addChild(new OperationalDisplayComponent(
      description,
      DEFAULT_DISPLAY_POLICY,
      theme,
      { expanded: options.expanded },
    ));
  });
  return shell;
}
