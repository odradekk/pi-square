import { stripVTControlCharacters } from "node:util";

import { getMarkdownTheme, keyHint } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text, type Component } from "@earendil-works/pi-tui";

import type { CodeGraphDetails, CodeGraphOperation } from "./contracts";

interface RenderOptions {
  expanded: boolean;
  isPartial: boolean;
}

export function sanitizeCodeGraphText(value: unknown): string {
  return stripVTControlCharacters(String(value ?? ""))
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
}

function inline(value: unknown, max = 160): string {
  const clean = sanitizeCodeGraphText(value).replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, Math.max(0, max - 3))}...`;
}

function firstText(result: any): string {
  if (!Array.isArray(result?.content)) return "";
  return result.content.find((item: any) => item?.type === "text" && typeof item.text === "string")?.text ?? "";
}

function operationLabel(operation: CodeGraphOperation): string {
  return operation === "reindex" ? "reindex" : operation;
}

export function renderCodeGraphCall(args: any, theme: any, context: any): Component {
  const text = context?.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
  const operation = inline(args?.operation || "...");
  const subject = args?.operation === "explore" ? inline(args?.query || "...", 100) : inline(args?.projectPath || ".", 100);
  let output = theme.fg("toolTitle", theme.bold("codegraph ")) + theme.fg("accent", operation);
  if (subject) output += theme.fg("muted", " ") + theme.fg("text", subject);
  const metadata: string[] = [];
  if (args?.projectPath && args.operation === "explore") metadata.push(`projectPath=${inline(args.projectPath, 80)}`);
  if (typeof args?.maxFiles === "number") metadata.push(`maxFiles=${args.maxFiles}`);
  if (metadata.length > 0) output += `\n  ${theme.fg("dim", metadata.join(" · "))}`;
  text.setText(output);
  return text;
}

function summary(details: CodeGraphDetails | undefined, fallback: string, theme: any): string {
  if (!details) return theme.fg("error", `x ${inline(fallback || "CodeGraph failed")}`);
  const operation = operationLabel(details.operation);
  if (details.phase === "running") {
    const message = details.message ? ` · ${inline(details.message, 100)}` : "";
    return theme.fg("accent", `> ${operation}`) + theme.fg("muted", message);
  }
  if (details.phase === "declined") return theme.fg("warning", `- ${operation} declined`);
  if (details.phase === "recoverable") {
    return theme.fg("warning", `! ${details.code || "RECOVERABLE"}`)
      + theme.fg("muted", details.message ? ` · ${inline(details.message, 100)}` : "");
  }
  if (details.phase === "aborted") return theme.fg("warning", `x ${operation} aborted`);
  if (details.phase === "error") {
    return theme.fg("error", `x ${details.code || "CODEGRAPH_ERROR"}`)
      + theme.fg("muted", details.message ? ` · ${inline(details.message, 100)}` : "");
  }
  const extras: string[] = [];
  if (details.autoSynced) extras.push("auto-synced");
  if (details.status?.fileCount !== undefined) extras.push(`${details.status.fileCount} files`);
  if (details.outputTruncated) extras.push("output truncated");
  if (details.stderrTruncated) extras.push("stderr truncated");
  return theme.fg("success", `+ ${operation} done`)
    + (extras.length > 0 ? theme.fg("muted", ` · ${extras.join(" · ")}`) : "");
}

export function renderCodeGraphResult(result: any, options: RenderOptions, theme: any): Component {
  const details = result?.details as CodeGraphDetails | undefined;
  const text = firstText(result);
  if (options.isPartial || details?.phase === "running") {
    return new Text(summary(details, text, theme), 0, 0);
  }

  const container = new Container();
  container.addChild(new Text(summary(details, text, theme), 0, 0));
  if (!options.expanded) {
    container.addChild(new Text(theme.fg("dim", `  ${keyHint("app.tools.expand", "to expand")}`), 0, 0));
    return container;
  }

  const safe = sanitizeCodeGraphText(text).trim();
  if (safe) {
    container.addChild(new Spacer(1));
    if (details?.operation === "explore" && details.phase === "done") {
      container.addChild(new Markdown(safe, 0, 0, getMarkdownTheme()));
    } else {
      container.addChild(new Text(theme.fg("toolOutput", safe), 0, 0));
    }
  }
  container.addChild(new Spacer(1));
  container.addChild(new Text(keyHint("app.tools.expand", "to collapse"), 0, 0));
  return container;
}
