/**
 * Background subagent completion messages.
 *
 * The completion message is the deliberate native-shell exception: Pi owns the
 * success/error message shell, while the bounded result inside it uses the same
 * canonical operational description as the `delegate` transcript entry.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Box, Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { OperationalDisplayComponent } from "../display/components";
import { DEFAULT_DISPLAY_POLICY } from "../display/types";
import { sanitizeSubagentDisplay } from "./display";
import { describeSubagentRun } from "./display-adapter";
import type { SubagentNotificationDetails, SubagentRunDetails } from "./types";

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

export function renderSubagentNotification(
  message: { content?: unknown; details?: SubagentNotificationDetails },
  options: { expanded: boolean },
  theme: Theme,
): Component {
  const details = message.details?.result;
  const error = message.details?.status === "error" || details?.phase === "error" || details?.phase === "aborted";
  const shell = new Box(1, 1, (text) => theme.bg(error ? "toolErrorBg" : "toolSuccessBg", text));
  if (!isRunDetails(details)) {
    const fallback = sanitizeSubagentDisplay(message.content || "Background subagent notification");
    shell.addChild(options.expanded ? new Text(fallback, 0, 0) : new OneVisualLine(fallback));
    return shell;
  }
  const description = describeSubagentRun(
    "delegate",
    details,
    {
      expanded: options.expanded,
      isPartial: false,
      isError: message.details?.status === "error",
    },
    sanitizeSubagentDisplay(message.content ?? ""),
  );
  shell.addChild(new OperationalDisplayComponent(
    description,
    DEFAULT_DISPLAY_POLICY,
    theme,
    { expanded: options.expanded },
  ));
  return shell;
}
