import { statSync } from "node:fs";
import { validateRunArtifacts } from "./artifacts";
import { isRunLeaseActive } from "./lease";
import { isStaleRunning } from "./status";
import type { SubagentRunDetails } from "./types";

const MAX_TIMELINE_EVENTS = 8;
const MAX_ASSISTANT_EXCERPT = 500;
const MAX_TASK_EXCERPT = 200;

export interface InspectionReport {
  id: string;
  artifactsDir: string;
  phase: string;
  isStale: boolean;
  active: boolean;
  resumable: boolean;
  resumeBlockReason?: "subagent_active";
  warnings: string[];
  rendered: string;
}

export function inspectRun(id: string, now = Date.now()): InspectionReport {
  const validated = validateRunArtifacts(id);
  const persisted = validated.details;
  const active = isRunLeaseActive(id);

  let mtimeMs = persisted.startedAt ?? now;
  try {
    mtimeMs = statSync(validated.artifactsDir).mtimeMs;
  } catch {
    // Fall back to startedAt when stat is unavailable.
  }

  const stale = !active && isStaleRunning(persisted, mtimeMs, now);
  const warnings: string[] = [];
  if (stale) warnings.push("The last execution ended without updating its recorded running phase; no live lease remains.");
  if (persisted.toolErrors.length > 0) warnings.push(`${persisted.toolErrors.length} tool call(s) failed during the run.`);

  const resumable = !active;
  const resumeBlockReason = active ? "subagent_active" as const : undefined;
  const rendered = renderReport(persisted, {
    artifactsDir: validated.artifactsDir,
    mtimeMs,
    stale,
    active,
    resumable,
    warnings,
    now,
  });

  return {
    id,
    artifactsDir: validated.artifactsDir,
    phase: persisted.phase,
    isStale: stale,
    active,
    resumable,
    resumeBlockReason,
    warnings,
    rendered,
  };
}

function renderReport(
  details: SubagentRunDetails,
  ctx: {
    artifactsDir: string;
    mtimeMs: number;
    stale: boolean;
    active: boolean;
    resumable: boolean;
    warnings: string[];
    now: number;
  },
): string {
  const phaseLabel = ctx.stale ? `${details.phase} (inactive stale record)` : details.phase;
  const lines = [`ID: ${details.id}`, `Phase: ${phaseLabel}`, `Active: ${ctx.active ? "yes" : "no"}`];
  if (details.agent?.name) {
    const meta = [
      details.agent.name,
      details.agent.model ? `model=${details.agent.model}` : null,
      details.agent.effort ? `effort=${details.agent.effort}` : null,
    ].filter(Boolean);
    lines.push(`Agent: ${meta.join(" · ")}`);
  }
  if (details.task) lines.push(`Task: ${clip(details.task, MAX_TASK_EXCERPT)}`);
  lines.push(`Cwd: ${details.cwd}`);
  lines.push(`Started: ${new Date(details.startedAt).toISOString()}`);
  if (details.endedAt) lines.push(`Ended: ${new Date(details.endedAt).toISOString()}`);
  lines.push(`Last activity: ${formatAgo(ctx.now - ctx.mtimeMs)} ago`);
  lines.push(`ArtifactsDir: ${ctx.artifactsDir}`);
  lines.push(`SessionFile: ${details.sessionFile}`);

  const timeline = details.timeline.slice(-MAX_TIMELINE_EVENTS);
  if (timeline.length > 0) {
    lines.push("", `Timeline (last ${timeline.length} events):`);
    for (const event of timeline) {
      const stamp = event.at ? new Date(event.at).toISOString().slice(11, 19) : "??:??:??";
      lines.push(`  ${stamp}  ${event.kind}  ${clip(event.text, 120)}`);
    }
  }

  const lastText = details.salvagedFinalText || details.finalText || details.rawSessionOutput || "";
  if (lastText) {
    lines.push("", "Last assistant text (excerpt):");
    lines.push(clip(lastText, MAX_ASSISTANT_EXCERPT).split("\n").map((line) => `  ${line}`).join("\n"));
  }

  lines.push("", "Resume assessment:");
  if (ctx.resumable) {
    lines.push("  ✓ Subagent can be resumed with the same ID and native session history.");
    lines.push(`  → resume_subagent({ id: "${details.id}", task: "..." })`);
  } else {
    lines.push("  → active: resume is blocked with SUBAGENT_ACTIVE until the current execution stops.");
  }
  for (const warning of ctx.warnings) lines.push(`  ! ${warning}`);
  return lines.join("\n");
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}

function formatAgo(diffMs: number): string {
  if (diffMs < 0) return "just now";
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

export const __testables = {
  renderReport,
  clip,
  formatAgo,
  MAX_TIMELINE_EVENTS,
  MAX_ASSISTANT_EXCERPT,
  MAX_TASK_EXCERPT,
};
