import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  DEFAULT_MAX_OUTPUT_BYTES,
  evalScheme,
  type AccessMode,
  type SandboxOutputEvent,
  type SandboxResult,
} from "../sandbox";

export interface SchemeRenderDetails {
  phase?: "evaluating" | "done";
  access?: AccessMode;
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

const DEFAULT_TIMEOUT_MS = 30_000;
const UPDATE_THROTTLE_MS = 100;

const EMSCRIPTEN_NOISE = [
  /^Calling stub instead of sigaction/,
  /^warning: unsupported syscall/,
  /^mount-err:/,
];

function cleanStderr(raw: string): string {
  return raw
    .split("\n")
    .filter((line) => !EMSCRIPTEN_NOISE.some((re) => re.test(line)))
    .join("\n")
    .trim();
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function buildFooter(result: SandboxResult, access: AccessMode): string {
  const parts = [`access=${access}`, `exit=${result.exitCode}`, `duration=${formatDuration(result.durationMs)}`];
  if (result.timedOut) parts.push("timed_out");
  if (result.aborted) parts.push("aborted");
  return `\n-- scheme ${parts.join(" ")}`;
}

export function buildSchemeOutput(result: SandboxResult, access: AccessMode, timeoutMs: number): string {
  const stdout = result.stdout.trimEnd();
  const stderr = cleanStderr(result.stderr);
  const footer = buildFooter(result, access);

  if (result.aborted) {
    const sections = ["Execution aborted"];
    if (stdout) sections.push(stdout);
    if (stderr) sections.push(`[stderr]\n${stderr}`);
    return sections.join("\n\n") + footer;
  }

  if (result.timedOut) {
    const sections = [`Execution timed out after ${formatDuration(timeoutMs)}`];
    if (stdout) sections.push(stdout);
    if (stderr) sections.push(`[stderr]\n${stderr}`);
    return sections.join("\n\n") + footer;
  }

  if (stdout) {
    return (stderr ? `${stdout}\n\n[stderr]\n${stderr}` : stdout) + footer;
  }

  if (stderr) return stderr + footer;
  return `(no output)${footer}`;
}

function buildLiveOutput(stdoutChunks: Buffer[], stderrChunks: Buffer[]): string {
  const stdout = Buffer.concat(stdoutChunks).toString("utf8").trimEnd();
  const stderr = cleanStderr(Buffer.concat(stderrChunks).toString("utf8"));
  if (stdout) return stderr ? `${stdout}\n\n[stderr]\n${stderr}` : stdout;
  return stderr;
}

interface SchemeToolDependencies {
  evaluate?: typeof evalScheme;
  now?: () => number;
}

export function createSchemeToolDefinition(dependencies: SchemeToolDependencies = {}): ToolDefinition<any, SchemeRenderDetails> {
  const evaluate = dependencies.evaluate ?? evalScheme;
  const now = dependencies.now ?? Date.now;

  return {
    name: "scheme",
    label: "Scheme",
    description: "Evaluate Chez Scheme code in a sandboxed WASM environment. Runs R6RS-compliant Scheme with full Chez Scheme standard library. Use (display ...) or (printf ...) for output. Access levels: readonly (default) mounts cwd read-only at /work; write allows read+write at /work; fullaccess exposes the full host filesystem at /host with system() enabled.",
    promptSnippet: "Use scheme to run Scheme/Lisp code. Output comes from (display ...) or (printf ...). Default mode mounts cwd read-only at /work. Use access='write' for write access, access='fullaccess' for full host access.",
    promptGuidelines: [
      "Default access is readonly — cwd is mounted read-only at /work.",
      "Use access='write' when the Scheme code needs to create or modify files in cwd.",
      "Use access='fullaccess' only when full host access or system() is genuinely needed.",
    ],
    parameters: Type.Object({
      code: Type.String({ description: "Scheme code to evaluate" }),
      timeoutMs: Type.Optional(Type.Number({
        minimum: 1000,
        maximum: 120000,
        description: "Execution timeout in milliseconds (default: 30000)",
      })),
      access: Type.Optional(StringEnum(["readonly", "write", "fullaccess"] as const, {
        description: "Host filesystem access level (default: readonly). readonly: read files in cwd at /work. write: read+write in cwd at /work. fullaccess: full host access at /host, system() enabled.",
      })),
    }),
    async execute(_toolCallId: string, params: any, signal?: AbortSignal, onUpdate?: (update: any) => void) {
      const access: AccessMode = params.access ?? "readonly";
      const timeoutMs = Number.isFinite(params.timeoutMs) ? Number(params.timeoutMs) : DEFAULT_TIMEOUT_MS;
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let truncated = false;
      let updateTimer: ReturnType<typeof setTimeout> | undefined;
      let updateDirty = false;
      let lastUpdateAt = 0;

      const updateDetails = (): SchemeRenderDetails => ({
        phase: "evaluating",
        access,
        ...(truncated ? { truncated: true, outputLimitBytes: DEFAULT_MAX_OUTPUT_BYTES } : {}),
      });
      const emitUpdate = () => {
        if (!onUpdate || !updateDirty) return;
        updateDirty = false;
        lastUpdateAt = now();
        const output = buildLiveOutput(stdoutChunks, stderrChunks);
        onUpdate({
          content: output ? [{ type: "text" as const, text: output }] : [],
          details: updateDetails(),
        });
      };
      const clearUpdateTimer = () => {
        if (updateTimer) clearTimeout(updateTimer);
        updateTimer = undefined;
      };
      const scheduleUpdate = () => {
        if (!onUpdate) return;
        updateDirty = true;
        const delay = UPDATE_THROTTLE_MS - (now() - lastUpdateAt);
        if (delay <= 0) {
          clearUpdateTimer();
          emitUpdate();
          return;
        }
        updateTimer ??= setTimeout(() => {
          updateTimer = undefined;
          emitUpdate();
        }, delay);
      };
      const handleOutput = (event: SandboxOutputEvent) => {
        const wasTruncated = truncated;
        if (event.chunk.byteLength > 0) {
          const target = event.stream === "stdout" ? stdoutChunks : stderrChunks;
          target.push(Buffer.from(event.chunk));
        }
        truncated ||= event.truncated;
        if (event.chunk.byteLength > 0 || truncated !== wasTruncated) scheduleUpdate();
      };

      onUpdate?.({ content: [], details: updateDetails() });

      try {
        const result = await evaluate(params.code, {
          timeoutMs,
          access,
          signal,
          maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
          onOutput: handleOutput,
        });
        truncated ||= result.truncated;
        if (truncated) updateDirty = true;
        clearUpdateTimer();
        emitUpdate();

        const output = buildSchemeOutput(result, access, timeoutMs);
        const stderr = cleanStderr(result.stderr);
        const details: SchemeRenderDetails = {
          access,
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          timedOut: result.timedOut,
          ...(result.aborted ? { aborted: true } : {}),
          ...(truncated ? { truncated: true, outputLimitBytes: DEFAULT_MAX_OUTPUT_BYTES } : {}),
          ...(stderr ? { stderr } : {}),
        };
        return {
          content: [{ type: "text" as const, text: output }],
          isError: result.timedOut || result.aborted || result.exitCode !== 0,
          details,
        };
      } catch (error: any) {
        clearUpdateTimer();
        const reason = error?.message ?? String(error);
        return {
          content: [{ type: "text" as const, text: `scheme failed to start: ${reason}` }],
          isError: true,
          details: { access, spawnFailed: true, reason },
        };
      } finally {
        clearUpdateTimer();
      }
    },
  };
}

export function registerSchemeTool(pi: ExtensionAPI): void {
  pi.registerTool(createSchemeToolDefinition());
}
