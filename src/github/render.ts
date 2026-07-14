import { getMarkdownTheme, keyHint } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text, type Component } from "@earendil-works/pi-tui";
import {
  sanitizeMarkdownForTerminal,
  sanitizeTerminalText,
} from "../web/shared/render";
import type {
  GitHubCommitDetails,
  GitHubReadDetails,
  GitHubSearchDetails,
  GitHubToolDetails,
  GitHubTreeDetails,
} from "./types";

interface RenderOptions {
  expanded: boolean;
  isPartial: boolean;
}

function safe(value: unknown, max = 500): string {
  const clean = sanitizeTerminalText(String(value ?? ""))
    .replace(/\b(?:github_pat_|ghp_|gho_|ghu_|ghs_|ghr_)[A-Za-z0-9_]+\b/g, "[REDACTED]")
    .replace(/(authorization\s*:\s*(?:bearer|token)\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function firstText(result: any): string | undefined {
  if (!Array.isArray(result?.content)) return undefined;
  return result.content.find((item: any) => item?.type === "text" && typeof item.text === "string")?.text;
}

function reusableText(context: any): Text {
  return context?.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
}

function callText(name: string, accent: string, metadata: string[], theme: any, context: any): Text {
  const component = reusableText(context);
  let output = theme.fg("toolTitle", theme.bold(`${name} `)) + theme.fg("accent", safe(accent, 120) || "(building…)");
  if (metadata.length) output += `\n  ${theme.fg("dim", metadata.map((item) => safe(item, 160)).join(" · "))}`;
  component.setText(output);
  return component;
}

function own(args: any, key: string): boolean {
  return Boolean(args && typeof args === "object" && Object.prototype.hasOwnProperty.call(args, key));
}

export function renderGitHubSearchCall(args: any, theme: any, context: any): Text {
  const metadata = [safe(args?.kind || "repositories")];
  if (own(args, "page")) metadata.push(`page ${safe(args.page)}`);
  if (own(args, "limit")) metadata.push(`limit ${safe(args.limit)}`);
  return callText("github_search", args?.query, metadata, theme, context);
}

export function renderGitHubReadCall(args: any, theme: any, context: any): Text {
  const target = `${safe(args?.repo)}:${safe(args?.path || "README")}`;
  const metadata: string[] = [];
  if (own(args, "ref")) metadata.push(`ref ${safe(args.ref)}`);
  if (own(args, "line")) metadata.push(`line ${safe(args.line)}`);
  if (own(args, "limit")) metadata.push(`limit ${safe(args.limit)}`);
  return callText("github_read", target, metadata, theme, context);
}

export function renderGitHubTreeCall(args: any, theme: any, context: any): Text {
  const target = `${safe(args?.repo)}:${safe(args?.path || ".")}`;
  const metadata: string[] = [];
  if (own(args, "ref")) metadata.push(`ref ${safe(args.ref)}`);
  if (own(args, "depth")) metadata.push(`depth ${safe(args.depth)}`);
  if (own(args, "offset")) metadata.push(`offset ${safe(args.offset)}`);
  if (own(args, "limit")) metadata.push(`limit ${safe(args.limit)}`);
  return callText("github_tree", target, metadata, theme, context);
}

export function renderGitHubCommitCall(args: any, theme: any, context: any): Text {
  const target = `${safe(args?.repo)}@${safe(args?.ref)}`;
  const metadata: string[] = [];
  if (own(args, "page")) metadata.push(`page ${safe(args.page)}`);
  if (own(args, "limit")) metadata.push(`limit ${safe(args.limit)}`);
  return callText("github_commit", target, metadata, theme, context);
}

function isDetails(value: unknown): value is GitHubToolDetails {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<GitHubToolDetails>;
  return ["search", "read", "tree", "commit"].includes(String(candidate.tool))
    && (candidate.phase === "loading" || candidate.phase === "done");
}

function searchSummary(details: GitHubSearchDetails, theme: any): string {
  let output = theme.fg("success", "✓") + " "
    + theme.fg("text", `${details.returned} ${details.kind === "code" ? "code" : "repository"} result${details.returned === 1 ? "" : "s"}`);
  const metadata = [`${details.total} total`, `page ${details.page}`];
  if (details.incomplete) metadata.push("incomplete");
  if (details.omitted) metadata.push(`${details.omitted} omitted`);
  if (details.hasMore) metadata.push("more");
  output += "  " + theme.fg(details.incomplete ? "warning" : "muted", metadata.join(" · "));
  return output;
}

function readSummary(details: GitHubReadDetails, theme: any): string {
  if (details.binary) {
    return theme.fg("warning", "—") + " " + theme.fg("text", `binary ${safe(details.resolvedPath ?? details.path ?? "README")}`)
      + theme.fg("muted", details.size === undefined ? "" : `  ${details.size} bytes`);
  }
  let output = theme.fg("success", "✓") + " " + theme.fg("text", safe(details.resolvedPath ?? details.path ?? "README"));
  const metadata = [`${details.returnedLines} lines`];
  if (details.totalLines !== undefined) metadata.push(`${details.totalLines} total`);
  if (details.hasMore) metadata.push("more");
  if (details.truncatedLines) metadata.push(`${details.truncatedLines} long-line truncated`);
  output += "  " + theme.fg("muted", metadata.join(" · "));
  return output;
}

function treeSummary(details: GitHubTreeDetails, theme: any): string {
  const incomplete = details.remoteTruncated || details.requestBudgetExhausted;
  let output = theme.fg(incomplete ? "warning" : "success", incomplete ? "—" : "✓") + " "
    + theme.fg("text", `${details.returned} tree entr${details.returned === 1 ? "y" : "ies"}`);
  const metadata = [`depth ${details.depth}`, `${details.requestsUsed} request${details.requestsUsed === 1 ? "" : "s"}`];
  if (details.total !== undefined) metadata.push(`${details.total} total`);
  if (details.hasMore) metadata.push("more");
  if (details.remoteTruncated) metadata.push("remote limit");
  if (details.requestBudgetExhausted) metadata.push("request cap");
  output += "  " + theme.fg(incomplete ? "warning" : "muted", metadata.join(" · "));
  return output;
}

function commitSummary(details: GitHubCommitDetails, theme: any): string {
  let output = theme.fg("success", "✓") + " " + theme.fg("text", `${details.returned} changed file${details.returned === 1 ? "" : "s"}`);
  const metadata: string[] = [];
  if (details.additions !== undefined || details.deletions !== undefined) metadata.push(`+${details.additions ?? 0} -${details.deletions ?? 0}`);
  metadata.push(`page ${details.page}`);
  if (details.omittedPatches) metadata.push(`${details.omittedPatches} patch omitted`);
  if (details.hasMore) metadata.push("more");
  output += "  " + theme.fg(details.omittedPatches ? "warning" : "muted", metadata.join(" · "));
  return output;
}

function summary(details: GitHubToolDetails | undefined, fallback: string | undefined, theme: any): string {
  if (!details) return theme.fg("success", "✓") + " " + theme.fg("text", safe(fallback || "GitHub result"));
  if (details.error) return theme.fg("error", `✗ ${safe(details.error, 300)}`);
  if (details.phase === "loading") {
    const labels = { search: "Searching GitHub…", read: "Reading GitHub file…", tree: "Browsing GitHub tree…", commit: "Loading GitHub commit…" } as const;
    return theme.fg("muted", labels[details.tool]);
  }
  switch (details.tool) {
    case "search": return searchSummary(details, theme);
    case "read": return readSummary(details, theme);
    case "tree": return treeSummary(details, theme);
    case "commit": return commitSummary(details, theme);
  }
}

export function renderGitHubResult(result: any, options: RenderOptions, theme: any): Component {
  const details = isDetails(result?.details) ? result.details : undefined;
  const content = firstText(result);
  if (options.isPartial) return new Text(summary(details, content, theme), 0, 0);
  const title = summary(details, content, theme);
  const expandable = Boolean(content && !details?.error);
  if (!options.expanded || !expandable) {
    const hint = !options.expanded && expandable ? `  ${keyHint("app.tools.expand", "to expand")}` : "";
    return new Text(title + hint, 0, 0);
  }
  const container = new Container();
  container.addChild(new Text(title, 0, 0));
  container.addChild(new Spacer(1));
  const sanitized = sanitizeMarkdownForTerminal(content!)
    .replace(/\b(?:github_pat_|ghp_|gho_|ghu_|ghs_|ghr_)[A-Za-z0-9_]+\b/g, "[REDACTED]")
    .replace(/(authorization\s*:\s*(?:bearer|token)\s+)[^\s,;]+/gi, "$1[REDACTED]");
  container.addChild(new Markdown(sanitized, 0, 0, getMarkdownTheme()));
  container.addChild(new Spacer(1));
  container.addChild(new Text(keyHint("app.tools.expand", "to collapse"), 0, 0));
  return container;
}
