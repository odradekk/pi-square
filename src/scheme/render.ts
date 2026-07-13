import { stripVTControlCharacters } from "node:util";
import { keyHint } from "@earendil-works/pi-coding-agent";
import {
  Container,
  Text,
  truncateToWidth,
  wrapTextWithAnsi,
  type Component,
} from "@earendil-works/pi-tui";

const PREVIEW_VISUAL_LINES = 5;

export interface SchemeRenderDetails {
  phase?: "evaluating" | "done";
  access?: "readonly" | "write" | "fullaccess";
  exitCode?: number;
  durationMs?: number;
  timedOut?: boolean;
  aborted?: boolean;
  truncated?: boolean;
  outputLimitBytes?: number;
  stderr?: string;
  spawnFailed?: boolean;
  reason?: string;
}

interface SchemeRenderState {
  startedAt?: number;
  endedAt?: number;
  interval?: ReturnType<typeof setInterval>;
}

class SchemeResultComponent extends Container {}

function sanitizeDisplay(value: unknown): string {
  return stripVTControlCharacters(String(value ?? ""))
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "   ")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
}

function hasOwn(value: unknown, key: string): boolean {
  return Boolean(value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, key));
}

function firstText(result: any): string {
  if (!Array.isArray(result?.content)) return "";
  return result.content
    .filter((item: any) => item?.type === "text" && typeof item.text === "string")
    .map((item: any) => item.text)
    .join("\n");
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.floor(ms))}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function styleOutput(output: string, theme: any): string {
  return output.split("\n").map((line) => theme.fg("toolOutput", line)).join("\n");
}

function visualTail(styled: string, width: number): { lines: string[]; skipped: number } {
  const safeWidth = Math.max(1, width);
  const visual = styled.split("\n").flatMap((line) => wrapTextWithAnsi(line || " ", safeWidth));
  return {
    lines: visual.slice(-PREVIEW_VISUAL_LINES),
    skipped: Math.max(0, visual.length - PREVIEW_VISUAL_LINES),
  };
}

function callText(args: any, theme: any): string {
  const access = args?.access === "write" || args?.access === "fullaccess" ? args.access : "readonly";
  const accessColor = access === "fullaccess" ? "warning" : "muted";
  let header = theme.fg("toolTitle", theme.bold("scheme"));
  header += theme.fg("muted", "  access=") + theme.fg(accessColor, access);
  if (hasOwn(args, "timeoutMs") && Number.isFinite(args?.timeoutMs)) {
    header += theme.fg("muted", ` · timeout=${Number(args.timeoutMs)}ms`);
  }

  const source: string = hasOwn(args, "code")
    ? sanitizeDisplay(args.code)
    : String(theme.fg("dim", "(building...)"));
  const indented = source.split("\n").map((line: string) => `  ${line}`).join("\n");
  return `${header}\n${theme.fg("accent", indented)}`;
}

export function renderSchemeCall(args: any, theme: any, context: any): Component {
  const state = (context?.state ?? {}) as SchemeRenderState;
  if (context?.executionStarted && state.startedAt === undefined) {
    state.startedAt = Date.now();
    state.endedAt = undefined;
  }
  const component = context?.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
  component.setText(callText(args, theme));
  return component;
}

function rebuildResult(
  component: SchemeResultComponent,
  result: any,
  options: { expanded: boolean; isPartial: boolean },
  theme: any,
  state: SchemeRenderState,
): void {
  component.clear();
  const output = sanitizeDisplay(firstText(result)).trimEnd();
  const details = result?.details as SchemeRenderDetails | undefined;

  if (output) {
    const styled = styleOutput(output, theme);
    if (options.expanded) {
      component.addChild(new Text(`\n${styled}`, 0, 0));
    } else {
      component.addChild({
        render(width: number): string[] {
          const preview = visualTail(styled, width);
          if (preview.skipped === 0) return ["", ...preview.lines];
          const hint = theme.fg("muted", `... (${preview.skipped} earlier visual lines, `)
            + keyHint("app.tools.expand", "to expand")
            + theme.fg("muted", ")");
          return ["", truncateToWidth(hint, Math.max(1, width), "..."), ...preview.lines];
        },
        invalidate(): void {},
      });
    }
  } else if (options.isPartial) {
    component.addChild(new Text(`\n${theme.fg("muted", "Evaluating...")}`, 0, 0));
  }

  if (details?.truncated) {
    const limit = details.outputLimitBytes ? ` (${details.outputLimitBytes} byte limit)` : "";
    component.addChild(new Text(`\n${theme.fg("warning", `[Output limit reached${limit}]`)}`, 0, 0));
  }

  if (options.expanded && output) {
    const styled = styleOutput(output, theme);
    component.addChild({
      render(width: number): string[] {
        if (visualTail(styled, width).skipped === 0) return [];
        const hint = theme.fg("muted", "(")
          + keyHint("app.tools.expand", "to collapse")
          + theme.fg("muted", ")");
        return ["", truncateToWidth(hint, Math.max(1, width), "...")];
      },
      invalidate(): void {},
    });
  }

  if (state.startedAt !== undefined) {
    const label = options.isPartial ? "Elapsed" : "Took";
    const endedAt = state.endedAt ?? Date.now();
    component.addChild(new Text(`\n${theme.fg("muted", `${label} ${formatDuration(endedAt - state.startedAt)}`)}`, 0, 0));
  } else if (!options.isPartial && typeof details?.durationMs === "number") {
    component.addChild(new Text(`\n${theme.fg("muted", `Took ${formatDuration(details.durationMs)}`)}`, 0, 0));
  }

  component.invalidate();
}

export function renderSchemeResult(
  result: any,
  options: { expanded: boolean; isPartial: boolean },
  theme: any,
  context: any,
): Component {
  const state = (context?.state ?? {}) as SchemeRenderState;
  if (options.isPartial) state.startedAt ??= Date.now();
  if (options.isPartial && !state.interval) {
    state.interval = setInterval(() => context?.invalidate?.(), 1000);
  }
  if (!options.isPartial || context?.isError) {
    state.endedAt ??= Date.now();
    if (state.interval) {
      clearInterval(state.interval);
      state.interval = undefined;
    }
  }

  const component = context?.lastComponent instanceof SchemeResultComponent
    ? context.lastComponent
    : new SchemeResultComponent();
  rebuildResult(component, result, options, theme, state);
  return component;
}
