import { keyHint } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, type Component } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import type { PdfSearchDetails } from "./contracts";

function clean(value: unknown, maximum = 240): string {
  const text = stripVTControlCharacters(String(value ?? ""))
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const points = Array.from(text);
  return points.length > maximum ? `${points.slice(0, maximum - 1).join("")}…` : text;
}

export function renderPdfSearchCall(args: any, theme: any, context: any): Component {
  const component = context?.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
  const query = clean(args?.query || "(building…)", 100);
  const path = clean(args?.path || "PDF required", 100);
  const limit = args?.limit === undefined ? "" : ` · limit ${clean(args.limit, 8)}`;
  component.setText(
    theme.fg("toolTitle", theme.bold("pdf_search "))
    + theme.fg("accent", query)
    + theme.fg("muted", ` in ${path}${limit}`),
  );
  return component;
}

function firstText(result: any): string {
  const entry = Array.isArray(result?.content)
    ? result.content.find((item: any) => item?.type === "text" && typeof item.text === "string")
    : undefined;
  return entry?.text ?? "";
}

function summary(details: PdfSearchDetails | undefined, fallback: string, theme: any): string {
  if (!details) return theme.fg("error", `✗ ${clean(fallback || "Missing PDF search details")}`);
  if (details.status === "error" || details.status === "aborted") {
    const color = details.status === "aborted" ? "warning" : "error";
    return theme.fg(color, `${details.status === "aborted" ? "×" : "✗"} ${clean(details.error || details.errorCode)}`);
  }
  const returned = details.returned ?? 0;
  if (returned === 0) {
    return theme.fg("dim", `No matching pages${details.pageCount ? ` in ${details.pageCount} pages` : ""}`);
  }
  let text = theme.fg("success", "✓") + " " + theme.fg("text", `${returned} matching ${returned === 1 ? "page" : "pages"}`);
  const extras = [
    details.totalMatches !== undefined && details.totalMatches > returned ? `${details.totalMatches} total` : undefined,
    details.cacheHit ? "cached" : undefined,
    details.durationMs !== undefined ? `${details.durationMs} ms` : undefined,
  ].filter((value): value is string => Boolean(value));
  if (extras.length) text += "  " + theme.fg("muted", extras.join(" · "));
  return text;
}

export function renderPdfSearchResult(
  result: any,
  options: { expanded: boolean; isPartial: boolean },
  theme: any,
): Component {
  const details = result?.details as PdfSearchDetails | undefined;
  if (options.isPartial) {
    const phase = details?.phase === "searching" ? "Searching PDF pages…" : "Extracting PDF text…";
    return new Text(theme.fg("muted", phase), 0, 0);
  }

  const line = summary(details, firstText(result), theme);
  if (!options.expanded || details?.status !== "success" || details.matches.length === 0) {
    const hint = details?.status === "success" && details.matches.length > 0
      ? `  ${keyHint("app.tools.expand", "to expand")}`
      : "";
    return new Text(line + hint, 0, 0);
  }

  const container = new Container();
  container.addChild(new Text(line, 0, 0));
  for (const match of details.matches) {
    container.addChild(new Spacer(1));
    const heading = theme.fg("accent", theme.bold(`Page ${match.page}`))
      + theme.fg("muted", `  ${match.type} · ${match.score.toFixed(3)}${match.edits ? ` · ${match.edits} edits` : ""}`);
    container.addChild(new Text(heading, 0, 0));
    container.addChild(new Text(clean(match.context, 260), 0, 0));
  }
  container.addChild(new Spacer(1));
  container.addChild(new Text(keyHint("app.tools.expand", "to collapse"), 0, 0));
  return container;
}
