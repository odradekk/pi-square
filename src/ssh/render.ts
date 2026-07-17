import { stripVTControlCharacters } from "node:util";
import { Text, type Component } from "@earendil-works/pi-tui";
import type { SshDetails } from "./contracts";

function sanitizeLine(value: unknown): string {
  return stripVTControlCharacters(String(value ?? ""))
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
    .slice(0, 20_000);
}

function firstText(result: any): string {
  if (!Array.isArray(result?.content)) return "";
  return result.content.find((item: any) => item?.type === "text" && typeof item.text === "string")?.text ?? "";
}

export function renderSshCall(args: any, theme: any, context: any): Component {
  const text = context?.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
  const operation = sanitizeLine(args?.operation || "ssh");
  let target = "";
  if (args?.session) target = ` ${theme.fg("accent", sanitizeLine(args.session))}`;
  else if (args?.profile) {
    target = ` ${theme.fg("accent", sanitizeLine(args.profile))}`;
    if (args?.target) target += theme.fg("muted", `/${sanitizeLine(args.target)}`);
  }
  let body = theme.fg("toolTitle", theme.bold(`ssh ${operation}`)) + target;
  if (operation === "command" && typeof args?.command === "string") {
    body += `\n${theme.fg("dim", "$ ")}${sanitizeLine(args.command)}`;
  } else if (operation === "secret_input") {
    body += `\n${theme.fg("warning", "secure user input required")}`;
  }
  text.setText(body);
  return text;
}

export function renderSshResult(result: any, options: any, theme: any): Component {
  const details = result?.details as SshDetails | undefined;
  const text = new Text("", 0, 0);
  if (!details) {
    text.setText(theme.fg(result?.isError ? "error" : "text", sanitizeLine(firstText(result)) || "SSH result unavailable"));
    return text;
  }
  const glyph = details.status === "success" ? "+" : details.status === "running" ? "~" : details.status === "declined" ? "-" : "x";
  const color = details.status === "success" ? "success" : details.status === "running" ? "warning" : details.status === "declined" ? "muted" : "error";
  let body = theme.fg(color, glyph) + " " + theme.fg("text", sanitizeLine(details.message));
  if (details.session) {
    body += theme.fg("muted", `\n${details.session.id} · ${details.session.profile}/${details.session.target} · ${details.session.commandState}`);
  }
  const raw = firstText(result);
  const parsedOutput = (() => {
    try {
      const parsed = JSON.parse(raw);
      return typeof parsed?.output === "string" ? sanitizeLine(parsed.output) : "";
    } catch {
      return "";
    }
  })();
  if (parsedOutput) {
    const lines = parsedOutput.split("\n");
    const selected = options?.expanded ? lines : lines.slice(-5);
    body += `\n${selected.join("\n")}`;
    if (!options?.expanded && lines.length > selected.length) body += theme.fg("dim", `\n... ${lines.length - selected.length} earlier lines`);
  }
  text.setText(body);
  return text;
}
