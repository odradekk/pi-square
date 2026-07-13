import { stripVTControlCharacters } from "node:util";
import {
  formatSize,
  highlightCode,
  keyHint,
  truncateToVisualLines,
  type Theme,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { PwshToolDetails } from "./tools/pwsh";

const PREVIEW_LINES = 5;

export interface ShellRenderState {
  startedAt?: number;
  endedAt?: number;
  interval?: NodeJS.Timeout;
}

interface ResultCache {
  width?: number;
  lines?: string[];
  skipped?: number;
}

interface ShellToolResult {
  content: Array<{ type: string; text?: string }>;
  details?: PwshToolDetails;
}

class ShellResultComponent extends Container {
  readonly cache: ResultCache = {};
}

function sanitizeDisplay(value: unknown): string {
  const safe = stripVTControlCharacters(typeof value === "string" ? value : String(value ?? ""))
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
  return safe.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, (character) => {
    const code = character.charCodeAt(0);
    return code <= 0xff
      ? `\\x${code.toString(16).padStart(2, "0")}`
      : `\\u${code.toString(16).padStart(4, "0")}`;
  });
}

function commandText(
  args: Record<string, unknown> | undefined,
  shell: "bash" | "pwsh",
  theme: Theme,
): string {
  const safeArgs = args ?? {};
  const rawCommand = safeArgs.command;
  if (typeof rawCommand !== "string") {
    return theme.fg("toolTitle", theme.bold(shell === "bash" ? "$ " : "PS> "))
      + theme.fg("error", "(invalid command)");
  }

  const command = sanitizeDisplay(rawCommand);
  const prompt = shell === "bash" ? "$ " : "PS> ";
  const styledPrompt = theme.fg("toolTitle", theme.bold(prompt));
  const highlighted = highlightCode(command || "...", shell === "bash" ? "bash" : "powershell");
  const continuation = " ".repeat(prompt.length);
  const lines = highlighted.map((line, index) => `${index === 0 ? styledPrompt : continuation}${line}`);
  const metadata: string[] = [];
  if (shell === "pwsh" && typeof safeArgs.cwd === "string" && safeArgs.cwd.length > 0) {
    metadata.push(`cwd=${sanitizeDisplay(safeArgs.cwd)}`);
  }
  if (shell === "bash" && typeof safeArgs.timeout === "number") {
    metadata.push(`timeout=${safeArgs.timeout}s`);
  }
  if (shell === "pwsh" && typeof safeArgs.timeoutMs === "number") {
    metadata.push(`timeout=${(safeArgs.timeoutMs / 1000).toFixed(1)}s`);
  }
  if (metadata.length > 0) lines.push(theme.fg("muted", `  (${metadata.join(" ")})`));
  return lines.join("\n");
}

function renderCommandCall(
  args: Record<string, unknown> | undefined,
  shell: "bash" | "pwsh",
  theme: Theme,
  context: any,
) {
  const state = context.state as ShellRenderState;
  if (context.executionStarted && state.startedAt === undefined) {
    state.startedAt = Date.now();
    state.endedAt = undefined;
  }
  const component = context.lastComponent instanceof Text
    ? context.lastComponent
    : new Text("", 0, 0);
  component.setText(commandText(args, shell, theme));
  return component;
}

function textOutput(result: ShellToolResult): string {
  return result.content
    .filter((item): item is { type: "text"; text: string } => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
}

function formatDuration(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
}

function powerShellIdentity(details: PwshToolDetails | undefined): string | undefined {
  if (!details?.flavor) return undefined;
  const name = details.flavor === "windows-powershell" ? "Windows PowerShell" : "PowerShell";
  return details.version ? `${name} ${sanitizeDisplay(details.version)}` : name;
}

function rebuildResult(
  component: ShellResultComponent,
  result: ShellToolResult,
  options: { expanded: boolean; isPartial: boolean },
  theme: Theme,
  state: ShellRenderState,
): void {
  component.clear();
  let output = sanitizeDisplay(textOutput(result)).trim();
  const truncation = result.details?.truncation;
  const fullOutputPath = result.details?.fullOutputPath;
  if (!options.isPartial && truncation?.truncated && fullOutputPath && output.endsWith("]")) {
    const footerStart = output.lastIndexOf("\n\n[");
    if (footerStart !== -1 && output.slice(footerStart).includes(sanitizeDisplay(fullOutputPath))) {
      output = output.slice(0, footerStart).trimEnd();
    }
  }
  if (output) {
    const styled = output.split("\n").map((line) => theme.fg("toolOutput", line)).join("\n");
    if (options.expanded) {
      component.addChild(new Text(`\n${styled}`, 0, 0));
    } else {
      component.addChild({
        render(width: number) {
          if (component.cache.width !== width || component.cache.lines === undefined) {
            const preview = truncateToVisualLines(styled, PREVIEW_LINES, width);
            component.cache.width = width;
            component.cache.lines = preview.visualLines;
            component.cache.skipped = preview.skippedCount;
          }
          if ((component.cache.skipped ?? 0) > 0) {
            const hint = theme.fg("muted", `... (${component.cache.skipped} earlier visual lines,`)
              + ` ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
            return ["", truncateToWidth(hint, width, "..."), ...(component.cache.lines ?? [])];
          }
          return ["", ...(component.cache.lines ?? [])];
        },
        invalidate() {
          component.cache.width = undefined;
          component.cache.lines = undefined;
          component.cache.skipped = undefined;
        },
      });
    }
  }

  if (truncation?.truncated || fullOutputPath) {
    const warnings: string[] = [];
    if (fullOutputPath) warnings.push(`Full output: ${sanitizeDisplay(fullOutputPath)}`);
    if (truncation?.truncated) {
      if (truncation.truncatedBy === "lines") {
        warnings.push(`Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`);
      } else {
        warnings.push(`Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes)} limit)`);
      }
    }
    component.addChild(new Text(`\n${theme.fg("warning", `[${warnings.join(". ")}]`)}`, 0, 0));
  }

  const identity = powerShellIdentity(result.details);
  const duration = options.isPartial
    ? (state.startedAt === undefined ? undefined : Date.now() - state.startedAt)
    : result.details?.durationMs
      ?? (state.startedAt === undefined ? undefined : (state.endedAt ?? Date.now()) - state.startedAt);
  const status = [
    duration === undefined ? undefined : `${options.isPartial ? "Elapsed" : "Took"} ${formatDuration(duration)}`,
    identity,
  ].filter((part): part is string => Boolean(part));
  if (status.length > 0) component.addChild(new Text(`\n${theme.fg("muted", status.join(" | "))}`, 0, 0));
}

export function renderPwshCall(args: unknown, theme: Theme, context: any) {
  return renderCommandCall(args as Record<string, unknown> | undefined, "pwsh", theme, context);
}

export function renderPwshResult(
  result: ShellToolResult,
  options: { expanded: boolean; isPartial: boolean },
  theme: Theme,
  context: any,
) {
  const state = context.state as ShellRenderState;
  if (state.startedAt === undefined) state.startedAt = Date.now();
  if (options.isPartial && !state.interval) {
    state.interval = setInterval(() => context.invalidate(), 1000);
    state.interval.unref?.();
  }
  if (!options.isPartial || context.isError) {
    state.endedAt ??= Date.now();
    if (state.interval) {
      clearInterval(state.interval);
      state.interval = undefined;
    }
  }
  const component = context.lastComponent instanceof ShellResultComponent
    ? context.lastComponent
    : new ShellResultComponent();
  rebuildResult(component, result, options, theme, state);
  component.invalidate();
  return component;
}

export function withBashCommandRendering<T extends ToolDefinition<any, any, any>>(definition: T): T {
  return {
    ...definition,
    renderCall(args, theme, context) {
      return renderCommandCall(args as Record<string, unknown>, "bash", theme, context);
    },
  } as T;
}
