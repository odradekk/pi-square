import { stripVTControlCharacters } from "node:util";
import {
  formatSize,
  type ExtensionAPI,
  type ToolDefinition,
  type TruncationResult,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { ShellOutputAccumulator, type ShellOutputOptions, type ShellOutputSnapshot } from "../output";
import {
  probePwsh,
  runPwsh,
  type PwshBinary,
  type PwshProbe,
  type PwshRunOptions,
  type PwshRunResult,
} from "../spawn";

const IS_WINDOWS = process.platform === "win32";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 600_000;
const UPDATE_THROTTLE_MS = 100;

const PwshParamsSchema = Type.Object({
  command: Type.String({ description: "PowerShell command or script to execute via -EncodedCommand" }),
  timeoutMs: Type.Optional(Type.Number({
    minimum: 1000,
    maximum: MAX_TIMEOUT_MS,
    description: `Execution timeout in milliseconds (default: ${DEFAULT_TIMEOUT_MS}, max: ${MAX_TIMEOUT_MS}).`,
  })),
  cwd: Type.Optional(Type.String({
    description: "Working directory for the command. Defaults to the agent's cwd.",
  })),
}, { additionalProperties: false });

type PwshParams = Static<typeof PwshParamsSchema>;

let probeCache: Promise<PwshProbe> | null = null;

export function getPwshProbe(): Promise<PwshProbe> {
  probeCache ??= probePwsh();
  return probeCache;
}

function safeMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return stripVTControlCharacters(raw)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .slice(0, 1_000) || "Unknown PowerShell failure";
}

function appendStatus(text: string, status: string): string {
  return `${text ? `${text}\n\n` : ""}${status}`;
}

function formatSnapshot(
  snapshot: ShellOutputSnapshot,
  getLastLineBytes: () => number,
  emptyText = "(no output)",
): string {
  const truncation = snapshot.truncation;
  let text = snapshot.content || emptyText;
  if (!truncation.truncated || !snapshot.fullOutputPath) return text;

  const startLine = truncation.totalLines - truncation.outputLines + 1;
  const endLine = truncation.totalLines;
  if (truncation.lastLinePartial) {
    text += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} `
      + `(line is ${formatSize(getLastLineBytes())}). Full output: ${snapshot.fullOutputPath}]`;
  } else if (truncation.truncatedBy === "lines") {
    text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. `
      + `Full output: ${snapshot.fullOutputPath}]`;
  } else {
    text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} `
      + `(${formatSize(truncation.maxBytes)} limit). Full output: ${snapshot.fullOutputPath}]`;
  }
  return text;
}

export interface PwshToolDetails {
  phase?: "running";
  flavor?: PwshBinary["flavor"];
  version?: string | null;
  exitCode?: number;
  durationMs?: number;
  timedOut?: boolean;
  aborted?: boolean;
  truncation?: TruncationResult;
  fullOutputPath?: string;
  unavailable?: boolean;
  executionFailed?: boolean;
  reason?: string;
}

interface PwshToolDependencies {
  probe?: () => Promise<PwshProbe>;
  run?: (options: PwshRunOptions) => Promise<PwshRunResult>;
  output?: ShellOutputOptions;
}

const PROMPT_SNIPPET = IS_WINDOWS
  ? "Use pwsh to run PowerShell commands on Windows. Prefer pwsh for system tasks such as cmdlets, services, processes, the registry, and .NET."
  : "Use pwsh only when a task explicitly requires PowerShell semantics.";

const PROMPT_GUIDELINES = IS_WINDOWS
  ? [
      "On Windows, pwsh is the only model-callable shell tool; use it for system commands and scripts.",
      "pwsh transports commands with PowerShell -EncodedCommand. Multi-line scripts work; quoting follows PowerShell rules.",
      "pwsh defaults to a 30-second timeout. Increase timeoutMs only for genuinely long-running commands.",
    ]
  : [
      "pwsh is unavailable on non-Windows platforms; use bash for shell commands.",
    ];

export function createPwshToolDefinition(
  dependencies: PwshToolDependencies = {},
): ToolDefinition<typeof PwshParamsSchema, PwshToolDetails> {
  const resolveProbe = dependencies.probe ?? getPwshProbe;
  const executeRun = dependencies.run ?? runPwsh;

  return {
    name: "pwsh",
    label: "pwsh",
    description: "Execute a command in PowerShell 7+, falling back to Windows PowerShell 5.1 when pwsh is unavailable. Output is streamed live and truncated to the same bounded tail as Pi's bash tool.",
    promptSnippet: PROMPT_SNIPPET,
    promptGuidelines: PROMPT_GUIDELINES,
    parameters: PwshParamsSchema,
    async execute(_toolCallId, params: PwshParams, signal, onUpdate, context) {
      const probe = await resolveProbe();
      if (!probe.available || !probe.binary) {
        const reason = safeMessage(probe.reason ?? "pwsh unavailable");
        return {
          content: [{ type: "text" as const, text: `pwsh unavailable: ${reason}` }],
          isError: true,
          details: { unavailable: true, reason },
        };
      }

      const requestedTimeout = Number(params.timeoutMs);
      const timeoutMs = Number.isFinite(requestedTimeout)
        ? Math.min(MAX_TIMEOUT_MS, Math.max(1000, requestedTimeout))
        : DEFAULT_TIMEOUT_MS;
      const output = new ShellOutputAccumulator({ tempFilePrefix: "pi-pwsh", ...dependencies.output });
      let acceptingOutput = true;
      let updateTimer: NodeJS.Timeout | undefined;
      let updateDirty = false;
      let lastUpdateAt = 0;
      let finalized = false;

      const partialDetails = (snapshot?: ShellOutputSnapshot): PwshToolDetails => ({
        phase: "running",
        flavor: probe.binary!.flavor,
        version: probe.binary!.version,
        ...(snapshot?.truncation.truncated ? { truncation: snapshot.truncation } : {}),
        ...(snapshot?.fullOutputPath ? { fullOutputPath: snapshot.fullOutputPath } : {}),
      });
      const emitOutputUpdate = () => {
        if (!onUpdate || !updateDirty) return;
        updateDirty = false;
        lastUpdateAt = Date.now();
        const snapshot = output.snapshot({ persistIfTruncated: true });
        onUpdate({
          content: [{ type: "text" as const, text: snapshot.content }],
          details: partialDetails(snapshot),
        });
      };
      const clearUpdateTimer = () => {
        if (!updateTimer) return;
        clearTimeout(updateTimer);
        updateTimer = undefined;
      };
      const scheduleOutputUpdate = () => {
        if (!onUpdate) return;
        updateDirty = true;
        const delay = UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt);
        if (delay <= 0) {
          clearUpdateTimer();
          emitOutputUpdate();
          return;
        }
        updateTimer ??= setTimeout(() => {
          updateTimer = undefined;
          emitOutputUpdate();
        }, delay);
      };
      const finishOutput = async (): Promise<ShellOutputSnapshot> => {
        if (!finalized) {
          finalized = true;
          acceptingOutput = false;
          output.finish();
          clearUpdateTimer();
          emitOutputUpdate();
        }
        const snapshot = output.snapshot({ persistIfTruncated: true });
        await output.close();
        return snapshot;
      };

      onUpdate?.({ content: [], details: partialDetails() });
      try {
        const result = await executeRun({
          command: String(params.command ?? ""),
          binary: probe.binary,
          timeoutMs,
          cwd: typeof params.cwd === "string" && params.cwd.length > 0 ? params.cwd : context?.cwd,
          signal,
          onData(chunk) {
            if (!acceptingOutput) return;
            output.append(chunk);
            scheduleOutputUpdate();
          },
        });
        const snapshot = await finishOutput();
        let text = formatSnapshot(snapshot, () => output.getLastLineBytes());
        if (result.timedOut) text = appendStatus(text, `Command timed out after ${(timeoutMs / 1000).toFixed(1)} seconds`);
        else if (result.aborted) text = appendStatus(text, "Command aborted");
        else if (result.exitCode !== 0) text = appendStatus(text, `Command exited with code ${result.exitCode}`);
        const isError = result.timedOut || result.aborted || result.exitCode !== 0;
        return {
          content: [{ type: "text" as const, text }],
          isError,
          details: {
            flavor: probe.binary.flavor,
            version: probe.binary.version,
            exitCode: result.exitCode,
            durationMs: result.durationMs,
            timedOut: result.timedOut,
            aborted: result.aborted,
            ...(snapshot.truncation.truncated ? { truncation: snapshot.truncation } : {}),
            ...(snapshot.fullOutputPath ? { fullOutputPath: snapshot.fullOutputPath } : {}),
          },
        };
      } catch (error) {
        let reason = safeMessage(error);
        let preserved = "";
        try {
          const snapshot = await finishOutput();
          preserved = formatSnapshot(snapshot, () => output.getLastLineBytes(), "");
        } catch (outputError) {
          reason = safeMessage(outputError);
        }
        return {
          content: [{
            type: "text" as const,
            text: appendStatus(preserved, `pwsh execution failed: ${reason}`),
          }],
          isError: true,
          details: {
            flavor: probe.binary.flavor,
            version: probe.binary.version,
            executionFailed: true,
            reason,
          },
        };
      } finally {
        clearUpdateTimer();
      }
    },
  };
}

export function registerPwshTool(pi: ExtensionAPI): void {
  pi.registerTool(createPwshToolDefinition());
}
