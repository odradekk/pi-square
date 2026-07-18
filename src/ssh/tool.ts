import { stripVTControlCharacters } from "node:util";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ConfirmationCoordinator } from "../core/confirmation";
import {
  SSH_COMMAND_MAX_CHARS,
  SSH_INPUT_MAX_CHARS,
  SSH_LABEL_MAX_CHARS,
  SSH_LIST_SECTION_CHARS,
  SSH_MODEL_OUTPUT_CHARS,
  SSH_MODEL_RESULT_CHARS,
  SSH_READ_WAIT_MAX_MS,
  SSH_TOOL_VERSION,
  SSH_WAIT_DEFAULT_MS,
  SSH_WAIT_MAX_MS,
  type SshDetails,
  type SshOperation,
  type SshOutputPage,
  type SshProfileSummary,
  type SshSessionSummary,
  type SshToolParams,
} from "./contracts";
import { sshErrorCode, sshErrorMessage, SshError } from "./errors";
import { SshSessionManager } from "./manager";
import { renderSshCall, renderSshResult } from "./render";
import { promptSecret } from "./secret-input";

const OPERATIONS = ["connect", "command", "read", "input", "secret_input", "interrupt", "close", "list"] as const;
const NAME_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._-]*$";
const UPDATE_INTERVAL_MS = 100;

const parameters = Type.Object({
  operation: StringEnum(OPERATIONS, {
    description: "connect opens a persistent shell; command/read/input/secret_input/interrupt operate on it; close/list manage sessions",
  }),
  profile: Type.Optional(Type.String({ minLength: 1, maxLength: 64, pattern: NAME_PATTERN, description: "Configured agent-level SSH profile; connect only" })),
  target: Type.Optional(Type.String({ minLength: 1, maxLength: 64, pattern: NAME_PATTERN, description: "Allowlisted target in the profile; connect only" })),
  label: Type.Optional(Type.String({ minLength: 1, maxLength: SSH_LABEL_MAX_CHARS, description: "Optional human-readable session label; connect only" })),
  session: Type.Optional(Type.String({ minLength: 5, maxLength: 64, description: "Session ID returned by connect" })),
  command: Type.Optional(Type.String({ minLength: 1, maxLength: SSH_COMMAND_MAX_CHARS, description: "POSIX shell command; command only" })),
  data: Type.Optional(Type.String({ maxLength: SSH_INPUT_MAX_CHARS, description: "Non-secret stdin text; input only" })),
  newline: Type.Optional(Type.Boolean({ default: true, description: "Append a newline to input (default true)" })),
  prompt: Type.Optional(Type.String({ minLength: 1, maxLength: 500, description: "Purpose shown to the user by secure secret input; never contains the secret" })),
  cursor: Type.Optional(Type.Integer({ minimum: 0, description: "Output cursor returned by a previous call; read only" })),
  waitMs: Type.Optional(Type.Integer({ minimum: 0, maximum: SSH_WAIT_MAX_MS, description: "Bounded wait in milliseconds; command/read only" })),
}, {
  additionalProperties: false,
  description: "Persistent parent-session SSH shell operations",
});

const allowedFields: Record<SshOperation, ReadonlySet<string>> = {
  connect: new Set(["operation", "profile", "target", "label"]),
  command: new Set(["operation", "session", "command", "waitMs"]),
  read: new Set(["operation", "session", "cursor", "waitMs"]),
  input: new Set(["operation", "session", "data", "newline"]),
  secret_input: new Set(["operation", "session", "prompt"]),
  interrupt: new Set(["operation", "session"]),
  close: new Set(["operation", "session"]),
  list: new Set(["operation"]),
};

function cleanDisplay(value: unknown, max = 4_000): string {
  return stripVTControlCharacters(String(value ?? ""))
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
    .slice(0, max);
}

function validateParams(params: SshToolParams): void {
  if (!OPERATIONS.includes(params?.operation)) throw new SshError("INVALID_ARGUMENT", `Unsupported SSH operation '${String(params?.operation)}'`);
  const unexpected = Object.keys(params).filter((key) => !allowedFields[params.operation].has(key));
  if (unexpected.length > 0) throw new SshError("INVALID_ARGUMENT", `${params.operation} does not accept: ${unexpected.join(", ")}`);
  if (params.operation === "connect") {
    if (typeof params.profile !== "string" || !new RegExp(NAME_PATTERN).test(params.profile)) throw new SshError("INVALID_ARGUMENT", "connect requires a valid profile name");
    if (params.target !== undefined && !new RegExp(NAME_PATTERN).test(params.target)) throw new SshError("INVALID_ARGUMENT", "target is invalid");
    if (params.label !== undefined && (params.label.length < 1 || params.label.length > SSH_LABEL_MAX_CHARS)) throw new SshError("INVALID_ARGUMENT", "label is invalid");
    return;
  }
  if (params.operation === "list") return;
  if (typeof params.session !== "string" || params.session.length < 5 || params.session.length > 64) throw new SshError("INVALID_ARGUMENT", `${params.operation} requires a session ID`);
  if (params.operation === "command") {
    if (typeof params.command !== "string" || params.command.length < 1 || params.command.length > SSH_COMMAND_MAX_CHARS) throw new SshError("INVALID_ARGUMENT", `command must contain 1-${SSH_COMMAND_MAX_CHARS} characters`);
    if (/[\u0000-\u0008\u000b-\u000d\u000e-\u001f\u007f]/.test(params.command)) throw new SshError("INVALID_ARGUMENT", "command cannot contain terminal control characters");
    if (params.waitMs !== undefined && (!Number.isInteger(params.waitMs) || params.waitMs < 0 || params.waitMs > SSH_WAIT_MAX_MS)) throw new SshError("INVALID_ARGUMENT", `waitMs must be an integer from 0-${SSH_WAIT_MAX_MS}`);
  } else if (params.operation === "read") {
    if (params.cursor !== undefined && (!Number.isSafeInteger(params.cursor) || params.cursor < 0)) throw new SshError("INVALID_ARGUMENT", "cursor must be a non-negative safe integer");
    if (params.waitMs !== undefined && (!Number.isInteger(params.waitMs) || params.waitMs < 0 || params.waitMs > SSH_READ_WAIT_MAX_MS)) throw new SshError("INVALID_ARGUMENT", `read waitMs must be an integer from 0-${SSH_READ_WAIT_MAX_MS}`);
  } else if (params.operation === "input") {
    if (typeof params.data !== "string" || params.data.length > SSH_INPUT_MAX_CHARS) throw new SshError("INVALID_ARGUMENT", `data must be at most ${SSH_INPUT_MAX_CHARS} characters`);
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(params.data)) throw new SshError("INVALID_ARGUMENT", "input data cannot contain terminal control characters");
  } else if (params.operation === "secret_input" && params.prompt !== undefined && (params.prompt.length < 1 || params.prompt.length > 500)) {
    throw new SshError("INVALID_ARGUMENT", "prompt must contain 1-500 characters");
  }
}

function pageMetadata(page: SshOutputPage): Omit<SshOutputPage, "text"> {
  const { text: _text, ...metadata } = page;
  return metadata;
}

function result(details: SshDetails, output?: string, isError = false) {
  const body = {
    version: SSH_TOOL_VERSION,
    status: details.status,
    operation: details.operation,
    code: details.code,
    message: details.message,
    ...(details.session ? { session: details.session } : {}),
    ...(details.sessions ? { sessions: details.sessions } : {}),
    ...(details.profiles ? { profiles: details.profiles } : {}),
    ...(details.omissions ? { omissions: details.omissions } : {}),
    ...(details.output ? { outputPage: details.output } : {}),
    ...(details.exitCode !== undefined ? { exitCode: details.exitCode } : {}),
    ...(output !== undefined ? { output: cleanDisplay(output, SSH_MODEL_OUTPUT_CHARS) } : {}),
  };
  const serialized = JSON.stringify(body);
  if (serialized.length > SSH_MODEL_RESULT_CHARS) {
    throw new SshError("MODEL_OUTPUT_LIMIT", "SSH result exceeded the model output limit");
  }
  return {
    content: [{ type: "text" as const, text: serialized }],
    ...(isError ? { isError: true } : {}),
    details,
  };
}

function baseDetails(operation: SshOperation, status: SshDetails["status"], code: string, message: string): SshDetails {
  return { version: SSH_TOOL_VERSION, operation, status, code, message };
}

function failure(operation: SshOperation, error: unknown) {
  const code = sshErrorCode(error);
  const message = cleanDisplay(sshErrorMessage(error), 1_000);
  return result(baseDetails(operation, code === "ABORTED" ? "aborted" : "error", code, message), undefined, true);
}

function confirmationAvailable(ctx: any): boolean {
  return Boolean(ctx?.hasUI && ctx?.ui && typeof ctx.ui.confirm === "function");
}

function boundedList(manager: SshSessionManager): {
  profiles: SshProfileSummary[];
  sessions: SshSessionSummary[];
  omissions: { profiles: number; targets: number; sessions: number };
} {
  const profiles: SshProfileSummary[] = [];
  let omittedProfiles = 0;
  let omittedTargets = 0;
  for (const profile of manager.profiles()) {
    const summary: SshProfileSummary = {
      name: profile.name,
      defaultTarget: profile.defaultTarget,
      targets: [],
      maxSessions: profile.maxSessions,
    };
    if (JSON.stringify([...profiles, summary]).length > SSH_LIST_SECTION_CHARS) {
      omittedProfiles += 1;
      omittedTargets += profile.targets.length;
      continue;
    }
    profiles.push(summary);
    for (const target of profile.targets) {
      const targetSummary = { name: target.name, endpoint: `${target.username}@${target.host}:${target.port}` };
      summary.targets.push(targetSummary);
      if (JSON.stringify(profiles).length > SSH_LIST_SECTION_CHARS) {
        summary.targets.pop();
        omittedTargets += 1;
      }
    }
  }

  const sessions: SshSessionSummary[] = [];
  let omittedSessions = 0;
  const rankedSessions = manager.list().sort((left, right) => {
    const leftRank = left.state === "connected" ? left.commandState === "running" ? 0 : 1 : 2;
    const rightRank = right.state === "connected" ? right.commandState === "running" ? 0 : 1 : 2;
    return leftRank - rightRank || right.createdAt - left.createdAt;
  });
  for (const session of rankedSessions) {
    if (JSON.stringify([...sessions, session]).length > SSH_LIST_SECTION_CHARS) omittedSessions += 1;
    else sessions.push(session);
  }
  return { profiles, sessions, omissions: { profiles: omittedProfiles, targets: omittedTargets, sessions: omittedSessions } };
}

export interface SshToolController {
  definition: ToolDefinition;
  resetApprovals(): void;
}

export function createSshToolController(
  manager: SshSessionManager,
  confirmations = new ConfirmationCoordinator(),
): SshToolController {
  const approvedTargets = new Set<string>();

  const definition: ToolDefinition = {
    name: "ssh",
    label: "SSH",
    description: "Manage bounded persistent SSH shell sessions using agent-configured profiles and pinned host fingerprints. Parent session only.",
    promptSnippet: "Use ssh connect/list to select an allowlisted remote target, then command/read/input/interrupt/close by session ID. Use secret_input only when a foreground process explicitly needs a user-provided secret.",
    promptGuidelines: [
      "SSH is remote write-capable. Respect confirmation boundaries and inspect the selected profile/target before executing commands.",
      "Only one foreground command may run per SSH session. Use read, input, secret_input, or interrupt until it completes.",
      "Never put passwords, passphrases, tokens, or other secrets in command or input parameters; request secret_input instead.",
      "SSH sessions preserve remote shell state but do not survive Pi shutdown or transport disconnection.",
    ],
    parameters,
    async execute(_toolCallId, rawParams, signal, onUpdate, ctx) {
      const params = rawParams as SshToolParams;
      const operation = OPERATIONS.includes(params?.operation) ? params.operation : "list";
      try {
        validateParams(params);

        if (params.operation === "list") {
          const { profiles, sessions, omissions } = boundedList(manager);
          const omitted = omissions.profiles + omissions.targets + omissions.sessions;
          const details: SshDetails = {
            ...baseDetails("list", "success", "OK", `${profiles.length} SSH profiles; ${sessions.length} sessions${omitted > 0 ? `; ${omitted} entries omitted by output limits` : ""}`),
            profiles,
            sessions,
            omissions,
          };
          return result(details);
        }

        if (params.operation === "connect") {
          const { profile, target } = manager.resolve(params.profile!, params.target);
          const approvalKey = `${profile.name}\0${target.name}\0${target.username}\0${target.host}\0${target.port}`;
          if (target.name !== profile.defaultTarget && !approvedTargets.has(approvalKey)) {
            if (!confirmationAvailable(ctx)) throw new SshError("CONFIRMATION_UNAVAILABLE", "Non-default SSH targets require interactive confirmation");
            const confirmed = await confirmations.run(signal, async (confirmationSignal) => {
              if (approvedTargets.has(approvalKey)) return true;
              const approved = await ctx.ui.confirm(
                "Connect to alternate SSH target",
                [
                  `Profile: ${cleanDisplay(profile.name)}`,
                  `Target: ${cleanDisplay(target.name)}`,
                  `Endpoint: ${cleanDisplay(`${target.username}@${target.host}:${target.port}`)}`,
                  `Pinned fingerprints: ${target.fingerprints.map((item) => cleanDisplay(item)).join(", ")}`,
                  "",
                  "This authorizes this exact configured endpoint for the current Pi session.",
                ].join("\n"),
                { signal: confirmationSignal },
              );
              if (approved) approvedTargets.add(approvalKey);
              return approved;
            });
            if (!confirmed) return result(baseDetails("connect", "declined", "DECLINED", "SSH connection was declined"));
          }
          const requestSecret = async (purpose: string) => {
            if (ctx?.mode !== "tui" || !ctx?.ui) throw new SshError("SECRET_INPUT_UNAVAILABLE", "Encrypted SSH keys require the interactive TUI");
            return promptSecret(ctx.ui, `${purpose}\nTarget: ${target.username}@${target.host}:${target.port}`, signal);
          };
          const session = await manager.connect(profile.name, target.name, params.label, requestSecret, signal);
          const page = await session.read(undefined, 0, signal);
          const details: SshDetails = {
            ...baseDetails("connect", "success", "CONNECTED", `Connected ${session.id} to ${session.summary().endpoint}`),
            session: session.summary(),
            output: pageMetadata(page.page),
          };
          return result(details, page.page.text);
        }

        const session = manager.get(params.session!);
        if (params.operation === "command") {
          const startCursor = session.summary().newestCursor;
          let updateTimer: NodeJS.Timeout | undefined;
          const publish = () => {
            if (updateTimer) return;
            updateTimer = setTimeout(() => {
              updateTimer = undefined;
              void session.read(startCursor, 0).then((snapshot) => {
                const partialDetails: SshDetails = {
                  ...baseDetails("command", "running", "COMMAND_RUNNING", "Remote command is running"),
                  session: session.summary(),
                  output: pageMetadata(snapshot.page),
                };
                onUpdate?.(result(partialDetails, snapshot.page.text));
              }).catch(() => {});
            }, UPDATE_INTERVAL_MS);
          };
          const unsubscribe = session.subscribe(publish);
          try {
            const commandResult = await session.command(params.command!, params.waitMs ?? SSH_WAIT_DEFAULT_MS, signal);
            if (signal?.aborted) {
              const details: SshDetails = {
                ...baseDetails("command", "aborted", "ABORTED", "Remote command wait was cancelled and an interrupt was sent"),
                session: session.summary(),
                output: pageMetadata(commandResult.page),
              };
              return result(details, commandResult.page.text, true);
            }
            const completed = commandResult.state === "completed";
            const details: SshDetails = {
              ...baseDetails("command", completed ? "success" : commandResult.state === "disconnected" ? "error" : "running", completed ? "COMMAND_COMPLETED" : commandResult.state === "disconnected" ? "SESSION_DISCONNECTED" : "COMMAND_RUNNING", completed ? `Remote command exited with code ${commandResult.exitCode}` : commandResult.state === "disconnected" ? "SSH session disconnected before the command completed" : "Remote command is still running"),
              session: session.summary(),
              output: pageMetadata(commandResult.page),
              ...(commandResult.exitCode !== undefined ? { exitCode: commandResult.exitCode } : {}),
            };
            return result(details, commandResult.page.text, commandResult.state === "disconnected");
          } finally {
            unsubscribe();
            if (updateTimer) clearTimeout(updateTimer);
          }
        }

        if (params.operation === "read") {
          const readResult = await session.read(params.cursor, Math.min(params.waitMs ?? 0, SSH_READ_WAIT_MAX_MS), signal);
          const details: SshDetails = {
            ...baseDetails("read", signal?.aborted ? "aborted" : readResult.state === "disconnected" ? "error" : readResult.state === "running" ? "running" : "success", signal?.aborted ? "ABORTED" : readResult.state === "disconnected" ? "SESSION_DISCONNECTED" : readResult.state === "running" ? "COMMAND_RUNNING" : "OK", signal?.aborted ? "SSH output wait was cancelled" : readResult.page.text ? "SSH output read" : "No new SSH output"),
            session: session.summary(),
            output: pageMetadata(readResult.page),
          };
          return result(details, readResult.page.text, readResult.state === "disconnected" || Boolean(signal?.aborted));
        }

        if (params.operation === "input") {
          session.input(params.data!, params.newline ?? true);
          return result({
            ...baseDetails("input", "success", "INPUT_SENT", "Non-secret input sent to the running remote command"),
            session: session.summary(),
          });
        }

        if (params.operation === "secret_input") {
          if (ctx?.mode !== "tui" || !ctx?.ui) throw new SshError("SECRET_INPUT_UNAVAILABLE", "Secret SSH input requires the interactive TUI");
          if (!session.isRunning) throw new SshError("NO_ACTIVE_COMMAND", "Secret SSH input requires a running foreground command");
          const purpose = cleanDisplay(params.prompt || "Provide a secret requested by the current remote process", 500);
          const secret = await promptSecret(ctx.ui, `${purpose}\nSession: ${session.id}\nEndpoint: ${session.summary().endpoint}`, signal);
          if (!secret) return result(baseDetails("secret_input", "declined", "DECLINED", "Secret input was cancelled"));
          try {
            session.input(secret, true);
          } finally {
            secret.fill(0);
          }
          return result({
            ...baseDetails("secret_input", "success", "SECRET_SENT", "Secret input was sent once and was not included in tool content"),
            session: session.summary(),
          });
        }

        if (params.operation === "interrupt") {
          session.interrupt();
          return result({
            ...baseDetails("interrupt", "success", "INTERRUPT_SENT", "Interrupt sent to the running remote command"),
            session: session.summary(),
          });
        }

        const summary = manager.close(params.session!, "SSH session closed by tool call");
        return result({
          ...baseDetails("close", "success", "CLOSED", `Closed SSH session ${params.session}`),
          session: summary,
        });
      } catch (error) {
        return failure(operation, error);
      }
    },
    renderCall: renderSshCall,
    renderResult: renderSshResult,
  };

  return {
    definition,
    resetApprovals() { approvedTargets.clear(); },
  };
}

export function createSshToolDefinition(
  manager = new SshSessionManager(),
  confirmations = new ConfirmationCoordinator(),
): ToolDefinition {
  return createSshToolController(manager, confirmations).definition;
}
