import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

import { ConfirmationCoordinator } from "../core/confirmation";
import type { RunCommandOptions, RunCommandResult } from "../core/process";
import {
  CODEGRAPH_LIFECYCLE_OUTPUT_CAP,
  CODEGRAPH_MAX_FILES,
  CODEGRAPH_MODEL_OUTPUT_CAP,
  CODEGRAPH_PATH_MAX,
  CODEGRAPH_PROCESS_OUTPUT_CAP,
  CODEGRAPH_QUERY_MAX,
  CODEGRAPH_QUERY_TIMEOUT_MS,
  CODEGRAPH_STDERR_CAP,
  type CodeGraphBinary,
  type CodeGraphDetails,
  type CodeGraphOperation,
  type CodeGraphParams,
  type CodeGraphStatus,
} from "./contracts";
import { findCodeGraphRoot, hasCodeGraphIndex, hasCodeGraphResidue, resolveCodeGraphPath } from "./paths";
import { sanitizeCodeGraphText } from "./sanitize";

export interface CodeGraphToolDeps {
  resolveBinary: () => Promise<CodeGraphBinary>;
  runCommand: (
    command: string,
    args: string[],
    options: RunCommandOptions,
  ) => Promise<RunCommandResult>;
  confirmations?: ConfirmationCoordinator;
}

interface CodeGraphContext {
  cwd: string;
  hasUI: boolean;
  ui: {
    confirm(title: string, message: string, options?: { signal?: AbortSignal }): Promise<boolean>;
  };
}

const FULL_OPERATIONS = ["explore", "status", "init", "sync", "reindex"] as const;
const READ_ONLY_OPERATIONS = ["explore", "status"] as const;

const projectPathSchema = Type.String({
  minLength: 1,
  maxLength: CODEGRAPH_PATH_MAX,
  description: "Project directory within the current workspace (default: cwd)",
});
const querySchema = Type.String({
  minLength: 1,
  maxLength: CODEGRAPH_QUERY_MAX,
  description: "Semantic code question, flow, area, file, or symbol; required only for operation=explore",
});
const maxFilesSchema = Type.Integer({
  minimum: 1,
  maximum: CODEGRAPH_MAX_FILES,
  description: "Maximum source files returned by CodeGraph; valid only for operation=explore",
});

const readOnlyParameters = Type.Object({
  operation: StringEnum(READ_ONLY_OPERATIONS, {
    description: "explore queries an existing index; status reports index health",
  }),
  query: Type.Optional(querySchema),
  projectPath: Type.Optional(projectPathSchema),
  maxFiles: Type.Optional(maxFilesSchema),
}, {
  additionalProperties: false,
  description: "Read-only CodeGraph explore and status operations",
});

const fullParameters = Type.Object({
  operation: StringEnum(FULL_OPERATIONS, {
    description: "explore queries code; status reports health; init and reindex require confirmation; sync updates an existing index",
  }),
  query: Type.Optional(querySchema),
  projectPath: Type.Optional(projectPathSchema),
  maxFiles: Type.Optional(maxFilesSchema),
}, {
  additionalProperties: false,
  description: "CodeGraph query and index lifecycle operations",
});

function serialize(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function boundedText(value: string): { text: string; chars: number; truncated: boolean } {
  const codePoints = Array.from(value);
  if (codePoints.length <= CODEGRAPH_MODEL_OUTPUT_CAP) {
    return { text: value, chars: codePoints.length, truncated: false };
  }
  const suffix = "\n\n[CodeGraph output truncated by pi-square]";
  const suffixLength = Array.from(suffix).length;
  return {
    text: `${codePoints.slice(0, CODEGRAPH_MODEL_OUTPUT_CAP - suffixLength).join("")}${suffix}`,
    chars: CODEGRAPH_MODEL_OUTPUT_CAP,
    truncated: true,
  };
}

function result(
  details: CodeGraphDetails,
  content: string | object,
  isError = false,
) {
  return {
    content: [{ type: "text" as const, text: typeof content === "string" ? content : serialize(content) }],
    ...(isError ? { isError: true } : {}),
    details,
  };
}

function stateResult(
  operation: CodeGraphOperation,
  projectPath: string,
  phase: CodeGraphDetails["phase"],
  code: string,
  message: string,
  isError = false,
  extra: Partial<CodeGraphDetails> = {},
) {
  const safeMessage = sanitizeCodeGraphText(message).replace(/\s+/g, " ").trim().slice(0, 1_000);
  const details: CodeGraphDetails = {
    version: 1,
    operation,
    phase,
    projectPath,
    code,
    message: safeMessage,
    ...extra,
  };
  return result(details, { version: 1, status: phase, operation, projectPath, code, message: safeMessage }, isError);
}

function validateParams(params: CodeGraphParams, allowWrite: boolean): string | undefined {
  const allowed: CodeGraphOperation[] = allowWrite
    ? ["explore", "status", "init", "sync", "reindex"]
    : ["explore", "status"];
  if (!allowed.includes(params?.operation)) return `Unsupported CodeGraph operation: ${String(params?.operation)}`;
  if (params.projectPath !== undefined && (typeof params.projectPath !== "string" || params.projectPath.length === 0 || params.projectPath.length > CODEGRAPH_PATH_MAX)) {
    return `projectPath must contain 1-${CODEGRAPH_PATH_MAX} characters`;
  }
  if (params.operation === "explore") {
    if (typeof params.query !== "string" || params.query.trim().length === 0 || params.query.length > CODEGRAPH_QUERY_MAX) {
      return `explore query must contain 1-${CODEGRAPH_QUERY_MAX} characters`;
    }
    if (params.maxFiles !== undefined && (!Number.isInteger(params.maxFiles) || params.maxFiles < 1 || params.maxFiles > CODEGRAPH_MAX_FILES)) {
      return `maxFiles must be an integer from 1 to ${CODEGRAPH_MAX_FILES}`;
    }
  } else if (params.query !== undefined || params.maxFiles !== undefined) {
    return `${params.operation} does not accept query or maxFiles`;
  }
  return undefined;
}

function codeGraphEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DO_NOT_TRACK: "1",
    CODEGRAPH_TELEMETRY: "0",
    CODEGRAPH_NO_UPDATE_CHECK: "1",
    CODEGRAPH_NO_DOWNLOAD: "1",
    CODEGRAPH_NO_WATCH: "1",
    NO_COLOR: "1",
    FORCE_COLOR: "0",
  };
}

function progressMessage(chunk: Buffer): string | undefined {
  const lines = sanitizeCodeGraphText(chunk.toString("utf8"))
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const last = lines.at(-1);
  if (!last) return undefined;
  return last.length <= 160 ? last : `${last.slice(0, 157)}...`;
}

function commandFailure(
  operation: CodeGraphOperation,
  projectPath: string,
  command: RunCommandResult,
) {
  if (command.status === "aborted") {
    return stateResult(operation, projectPath, "aborted", "ABORTED", "CodeGraph operation was cancelled", true);
  }
  const stderr = sanitizeCodeGraphText(command.stderr.toString("utf8")).trim();
  const message = command.status === "timeout"
    ? "CodeGraph operation timed out"
    : command.status === "stdout-cap"
      ? "CodeGraph process output exceeded its safety limit"
      : command.status === "stopped"
        ? "CodeGraph process stopped before completion"
        : `CodeGraph exited with code ${command.exitCode ?? "unknown"}${stderr ? `: ${stderr}` : ""}`;
  return stateResult(operation, projectPath, "error", `PROCESS_${command.status.toUpperCase().replace(/-/g, "_")}`, message, true, {
    stderrTruncated: command.stderrTruncated,
  });
}

// Shared confirmation-content grammar: bounded, sanitized `Label: value`
// lines followed by a blank line and a plain-language consequence note.
// The confirmation shell itself (ctx.ui.confirm) stays Pi-native and runs
// behind the shared FIFO coordinator; only the message content adopts this
// grammar, matching the pattern already used by ssh.ts and web/parse.ts.
function confirmationContent(fields: ReadonlyArray<[string, string]>, note: string): string {
  const lines = fields.map(([label, value]) => `${label}: ${sanitizeCodeGraphText(value).replace(/\s+/g, " ").trim()}`);
  return [...lines, "", note].join("\n");
}

function pendingChanges(status: CodeGraphStatus): number {
  const pending = status.pendingChanges;
  return (pending?.added ?? 0) + (pending?.modified ?? 0) + (pending?.removed ?? 0);
}

function healthIssue(status: CodeGraphStatus): { code: string; message: string } | undefined {
  if (status.worktreeMismatch) {
    return { code: "WORKTREE_MISMATCH", message: "The CodeGraph index belongs to a different Git worktree" };
  }
  const state = status.index?.state;
  if (status.index?.reindexRecommended || state === "indexing" || state === "partial" || state === "failed") {
    return {
      code: "REINDEX_REQUIRED",
      message: `The CodeGraph index requires a confirmed full rebuild${state ? ` (state: ${state})` : ""}`,
    };
  }
  return undefined;
}

function parseStatus(stdout: Buffer): CodeGraphStatus {
  const raw = sanitizeCodeGraphText(stdout.toString("utf8")).trim();
  const parsed = JSON.parse(raw) as CodeGraphStatus;
  if (!parsed || parsed.initialized !== true) throw new Error("CodeGraph status did not report an initialized index");
  return {
    initialized: true,
    ...(typeof parsed.version === "string" ? { version: parsed.version } : {}),
    ...(typeof parsed.projectPath === "string" ? { projectPath: parsed.projectPath } : {}),
    ...(typeof parsed.indexPath === "string" ? { indexPath: parsed.indexPath } : {}),
    ...(typeof parsed.lastIndexed === "string" || parsed.lastIndexed === null ? { lastIndexed: parsed.lastIndexed } : {}),
    ...(typeof parsed.fileCount === "number" ? { fileCount: parsed.fileCount } : {}),
    ...(typeof parsed.nodeCount === "number" ? { nodeCount: parsed.nodeCount } : {}),
    ...(typeof parsed.edgeCount === "number" ? { edgeCount: parsed.edgeCount } : {}),
    ...(typeof parsed.dbSizeBytes === "number" ? { dbSizeBytes: parsed.dbSizeBytes } : {}),
    ...(Array.isArray(parsed.languages) ? { languages: parsed.languages.filter((item): item is string => typeof item === "string").slice(0, 100) } : {}),
    pendingChanges: {
      added: Number(parsed.pendingChanges?.added) || 0,
      modified: Number(parsed.pendingChanges?.modified) || 0,
      removed: Number(parsed.pendingChanges?.removed) || 0,
    },
    worktreeMismatch: Boolean(parsed.worktreeMismatch),
    index: {
      reindexRecommended: Boolean(parsed.index?.reindexRecommended),
      state: typeof parsed.index?.state === "string" || parsed.index?.state === null ? parsed.index.state : null,
      pendingRefs: Number(parsed.index?.pendingRefs) || 0,
    },
  };
}

export function createCodeGraphToolDefinition(deps: CodeGraphToolDeps, allowWrite = true) {
  const confirmations = deps.confirmations ?? new ConfirmationCoordinator();
  return {
    name: "codegraph" as const,
    label: "CodeGraph",
    description: allowWrite
      ? "Local semantic code intelligence with bounded explore, status, initialization, incremental sync, and confirmed reindex operations. Paths stay within cwd."
      : "Read-only local semantic code intelligence over an existing CodeGraph index. Supports explore and status only; paths stay within cwd.",
    promptSnippet:
      "Use codegraph explore first for cross-file behavior, call flows, architecture, and impact when an index is available. Use grep for exact text and read for a known file.",
    promptGuidelines: [
      "Use explore for semantic or cross-file questions and treat returned source as already read unless CodeGraph reports a recoverable index condition.",
      "Use grep for literal text, configuration, and documentation; use read when the exact file is already known.",
      allowWrite
        ? "When NOT_INDEXED is returned, request init once; initialization and reindex require user confirmation, while incremental sync is automatic."
        : "When NOT_INDEXED or REINDEX_REQUIRED is returned, fall back to the available local read-only tools because this child profile cannot modify indexes.",
    ],
    parameters: allowWrite ? fullParameters : readOnlyParameters,

    async execute(
      _toolCallId: string,
      params: CodeGraphParams,
      signal: AbortSignal | undefined,
      onUpdate: ((value: any) => void) | undefined,
      ctx: CodeGraphContext,
    ) {
      const inputError = validateParams(params, allowWrite);
      if (inputError) return stateResult(params?.operation ?? "status", ctx?.cwd ?? process.cwd(), "error", "INVALID_ARGUMENT", inputError, true);

      const operation = params.operation;
      let paths;
      try {
        paths = resolveCodeGraphPath(ctx?.cwd ?? process.cwd(), params.projectPath);
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? String(error.code) : "INVALID_PATH";
        const message = error instanceof Error ? error.message : String(error);
        return stateResult(operation, params.projectPath ?? ctx?.cwd ?? process.cwd(), "error", code, message, true);
      }
      const { workspaceRoot, requestedPath } = paths;
      const indexedRoot = findCodeGraphRoot(requestedPath, workspaceRoot);

      if (operation !== "init" && indexedRoot === undefined) {
        return stateResult(
          operation,
          requestedPath,
          "recoverable",
          "NOT_INDEXED",
          allowWrite
            ? "No CodeGraph index exists here; request operation=init once, or use the existing local tools if initialization is declined"
            : "No CodeGraph index exists here; use the existing local read-only tools",
        );
      }

      if (operation === "init" && hasCodeGraphIndex(requestedPath)) {
        return stateResult(operation, requestedPath, "recoverable", "ALREADY_INDEXED", "CodeGraph is already initialized at this path");
      }
      if (operation === "init" && hasCodeGraphResidue(requestedPath)) {
        return stateResult(
          operation,
          requestedPath,
          "recoverable",
          "INDEX_DIRECTORY_EXISTS",
          "A .codegraph directory exists without a usable index; inspect it manually before retrying",
        );
      }

      let binary: CodeGraphBinary;
      try {
        binary = await deps.resolveBinary();
      } catch (error) {
        return stateResult(operation, requestedPath, "error", "BINARY_UNAVAILABLE", error instanceof Error ? error.message : String(error), true);
      }

      let lastProgressAt = 0;
      let lastProgressMessage = "";
      const emit = (activeOperation: CodeGraphOperation, projectPath: string, message: string, force = false): void => {
        const now = Date.now();
        if (!force && message === lastProgressMessage && now - lastProgressAt < 100) return;
        if (!force && now - lastProgressAt < 100) return;
        lastProgressAt = now;
        lastProgressMessage = message;
        onUpdate?.({
          content: [{ type: "text", text: serialize({ version: 1, status: "running", operation: activeOperation, projectPath, message }) }],
          details: { version: 1, operation: activeOperation, phase: "running", projectPath, message } satisfies CodeGraphDetails,
        });
      };

      const run = async (
        args: string[],
        projectPath: string,
        activeOperation: CodeGraphOperation,
        lifecycle: boolean,
      ): Promise<RunCommandResult> => {
        const onProgress = (chunk: Buffer): void => {
          const message = progressMessage(chunk);
          if (message) emit(activeOperation, projectPath, message);
        };
        return deps.runCommand(binary.command, [...binary.prefixArgs, ...args], {
          signal,
          cwd: projectPath,
          env: codeGraphEnv(),
          killTree: true,
          timeout: lifecycle ? 0 : CODEGRAPH_QUERY_TIMEOUT_MS,
          stdoutCap: lifecycle ? CODEGRAPH_LIFECYCLE_OUTPUT_CAP : CODEGRAPH_PROCESS_OUTPUT_CAP,
          stderrCap: CODEGRAPH_STDERR_CAP,
          captureStdout: true,
          onChunk: lifecycle ? onProgress : undefined,
          onStderrChunk: lifecycle ? onProgress : undefined,
        });
      };

      const statusFor = async (projectPath: string): Promise<CodeGraphStatus | ReturnType<typeof commandFailure>> => {
        const command = await run(["status", projectPath, "--json"], projectPath, operation, false);
        if (command.status !== "ok") return commandFailure(operation, projectPath, command);
        try {
          return parseStatus(command.stdout);
        } catch (error) {
          return stateResult(
            operation,
            projectPath,
            "error",
            "INVALID_STATUS_OUTPUT",
            error instanceof Error ? error.message : String(error),
            true,
          );
        }
      };

      if (operation === "init") {
        if (!ctx?.hasUI) {
          return stateResult(operation, requestedPath, "error", "CONFIRMATION_UNAVAILABLE", "CodeGraph init requires an interactive confirmation", true);
        }
        const confirmed = await confirmations.run(
          signal,
          (confirmationSignal) => ctx.ui.confirm(
            "Initialize CodeGraph",
            confirmationContent(
              [
                ["Project", requestedPath],
                ["Action", "create a local .codegraph index"],
                ["Writes", "persistent SQLite database under the project path"],
              ],
              "This scans source files under the project path. Declining performs no persistent write.",
            ),
            { signal: confirmationSignal },
          ),
        );
        if (signal?.aborted) return stateResult(operation, requestedPath, "aborted", "ABORTED", "CodeGraph initialization was cancelled", true);
        if (!confirmed) return stateResult(operation, requestedPath, "declined", "USER_DECLINED", "CodeGraph initialization was declined");
        emit(operation, requestedPath, "initializing index");
        const command = await run(["init", requestedPath], requestedPath, operation, true);
        if (command.status !== "ok") return commandFailure(operation, requestedPath, command);
        const finalStatus = await statusFor(requestedPath);
        if ("content" in finalStatus) return finalStatus;
        const details: CodeGraphDetails = { version: 1, operation, phase: "done", projectPath: requestedPath, status: finalStatus };
        return result(details, { version: 1, status: "done", operation, projectPath: requestedPath, index: finalStatus });
      }

      const projectPath = indexedRoot!;

      if (operation === "reindex") {
        if (!ctx?.hasUI) {
          return stateResult(operation, projectPath, "error", "CONFIRMATION_UNAVAILABLE", "CodeGraph reindex requires an interactive confirmation", true);
        }
        const confirmed = await confirmations.run(
          signal,
          (confirmationSignal) => ctx.ui.confirm(
            "Rebuild CodeGraph index",
            confirmationContent(
              [
                ["Project", projectPath],
                ["Action", "replace the existing index with a full rebuild"],
                ["Source files", "not modified"],
              ],
              "This scans source files under the project path. Declining performs no persistent write.",
            ),
            { signal: confirmationSignal },
          ),
        );
        if (signal?.aborted) return stateResult(operation, projectPath, "aborted", "ABORTED", "CodeGraph reindex was cancelled", true);
        if (!confirmed) return stateResult(operation, projectPath, "declined", "USER_DECLINED", "CodeGraph reindex was declined");
        emit(operation, projectPath, "rebuilding index");
        const command = await run(["index", projectPath], projectPath, operation, true);
        if (command.status !== "ok") return commandFailure(operation, projectPath, command);
        const finalStatus = await statusFor(projectPath);
        if ("content" in finalStatus) return finalStatus;
        const details: CodeGraphDetails = { version: 1, operation, phase: "done", projectPath, status: finalStatus };
        return result(details, { version: 1, status: "done", operation, projectPath, index: finalStatus });
      }

      if (operation === "sync") {
        emit(operation, projectPath, "synchronizing index");
        const command = await run(["sync", projectPath], projectPath, operation, true);
        if (command.status !== "ok") return commandFailure(operation, projectPath, command);
        const finalStatus = await statusFor(projectPath);
        if ("content" in finalStatus) return finalStatus;
        const details: CodeGraphDetails = { version: 1, operation, phase: "done", projectPath, status: finalStatus };
        return result(details, { version: 1, status: "done", operation, projectPath, index: finalStatus });
      }

      let currentStatus = await statusFor(projectPath);
      if ("content" in currentStatus) return currentStatus;
      if (operation === "status") {
        const details: CodeGraphDetails = { version: 1, operation, phase: "done", projectPath, status: currentStatus };
        return result(details, { version: 1, status: "done", operation, projectPath, index: currentStatus });
      }

      const issue = healthIssue(currentStatus);
      if (issue) return stateResult(operation, projectPath, "recoverable", issue.code, issue.message, false, { status: currentStatus });

      let autoSynced = false;
      if (pendingChanges(currentStatus) > 0 || (currentStatus.index?.pendingRefs ?? 0) > 0) {
        emit(operation, projectPath, `auto-syncing ${pendingChanges(currentStatus)} changed files`);
        const sync = await run(["sync", projectPath], projectPath, operation, true);
        if (sync.status !== "ok") return commandFailure(operation, projectPath, sync);
        autoSynced = true;
        currentStatus = await statusFor(projectPath);
        if ("content" in currentStatus) return currentStatus;
        const afterIssue = healthIssue(currentStatus);
        if (afterIssue) return stateResult(operation, projectPath, "recoverable", afterIssue.code, afterIssue.message, false, { status: currentStatus, autoSynced });
        if (pendingChanges(currentStatus) > 0 || (currentStatus.index?.pendingRefs ?? 0) > 0) {
          return stateResult(
            operation,
            projectPath,
            "recoverable",
            "SYNC_INCOMPLETE",
            "The workspace changed while CodeGraph was synchronizing; use the existing local tools for live files",
            false,
            { status: currentStatus, autoSynced },
          );
        }
      }

      const exploreArgs = ["explore", params.query!.trim(), "--path", projectPath];
      if (params.maxFiles !== undefined) exploreArgs.push("--max-files", String(params.maxFiles));
      emit(operation, projectPath, "exploring semantic graph");
      const command = await run(exploreArgs, projectPath, operation, false);
      if (command.status !== "ok") return commandFailure(operation, projectPath, command);
      const bounded = boundedText(sanitizeCodeGraphText(command.stdout.toString("utf8")).trim());
      const details: CodeGraphDetails = {
        version: 1,
        operation,
        phase: "done",
        projectPath,
        status: currentStatus,
        autoSynced,
        outputChars: bounded.chars,
        outputTruncated: bounded.truncated,
        stderrTruncated: command.stderrTruncated,
      };
      return result(details, bounded.text || "CodeGraph returned no relevant source for this query.");
    },
  };
}
