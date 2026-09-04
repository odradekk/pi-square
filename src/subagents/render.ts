/**
 * Background subagent completion messages.
 *
 * The completion message is the deliberate native-shell exception: Pi owns the
 * success/error message shell, while the bounded result inside it reuses the
 * canonical operational description of the run's own transcript entry —
 * `delegate_subagent` for a fresh run, `resume_subagent` for a resumed one.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Box, Spacer, Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { OperationalDisplayComponent } from "../display/components";
import { DEFAULT_DISPLAY_POLICY } from "../display/types";
import { sanitizeSubagentDisplay } from "./display";
import { parseV5NotificationDetails } from "./delivery";
import { describeSubagentRun } from "./display-adapter";
import type { SubagentNotificationDetails } from "./types";

export { sanitizeSubagentDisplay } from "./display";

class OneVisualLine implements Component {
  constructor(private readonly text: string) {}

  render(width: number): string[] {
    return [truncateToWidth(this.text, Math.max(1, width), "…")];
  }

  invalidate(): void {}
}

export function renderSubagentNotification(
  message: { content?: unknown; details?: SubagentNotificationDetails },
  options: { expanded: boolean },
  theme: Theme,
): Component {
  // Malformed entries are rejected by the shared V5 payload parser, so a
  // corrupted entry neither renders as a run nor confirms on delivery.
  const entries = parseV5NotificationDetails(message.details) ?? [];
  const error = entries.some((entry) => (
    entry.status === "failed"
    || entry.result.phase === "failed"
    || entry.result.phase === "aborted"
  ));
  const shell = new Box(1, 1, (text) => theme.bg(error ? "toolErrorBg" : "toolSuccessBg", text));
  if (entries.length === 0) {
    const fallback = sanitizeSubagentDisplay(message.content || "Background subagent notification");
    shell.addChild(options.expanded ? new Text(fallback, 0, 0) : new OneVisualLine(fallback));
    return shell;
  }

  // One delivery may carry several runs. Each run reuses the canonical
  // description of its own transcript entry, named by the run operation so a
  // resumed run keeps its Resume identity; only a single-run delivery can
  // fall back to the message text, because that text describes one run.
  const fallbackText = entries.length === 1 ? sanitizeSubagentDisplay(message.content ?? "") : "";
  entries.forEach((entry, index) => {
    if (index > 0) shell.addChild(new Spacer(1));
    const description = describeSubagentRun(
      entry.result.operation === "resume" ? "resume_subagent" : "delegate_subagent",
      entry.result,
      {
        expanded: options.expanded,
        isError: entry.status === "failed",
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
