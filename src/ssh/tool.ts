import { StringEnum } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { ConfirmationCoordinator } from "../core/confirmation";
import { withOwnedInputSurface } from "../core/input-surface";
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
  type SshCommandState,
  type SshDetails,
  type SshOperation,
  type SshOutputPage,
  type SshProfileSummary,
  type SshSessionSummary,
  type SshToolParams,
} from "./contracts";
import { sshErrorCode, sshErrorMessage, SshError } from "./errors";
import { SshSessionManager } from "./manager";
import { promptSecret } from "./secret-input";
import { projectTerminalOutput } from "./terminal-output";

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
  cursor: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: "Output cursor returned by a previous call; read only" })),
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
  return projectTerminalOutput(value, max);
}

function validateParams(params: SshToolParams): void {
  if (!Value.Check(parameters, params)) {
    const first = [...Value.Errors(parameters, params)][0];
    const errorPath = first ? String((first as any).path ?? (first as any).instancePath ?? "/") : "/";
    throw new SshError("INVALID_ARGUMENT", first ? `${errorPath}: ${first.message}` : "schema validation failed");
  }
  const unexpected = Object.keys(params).filter((key) => !allowedFields[params.operation].has(key));
  if (unexpected.length > 0) throw new SshError("INVALID_ARGUMENT", `${params.operation} does not accept: ${unexpected.join(", ")}`);
  if (params.operation === "connect") {
    if (params.profile === undefined) throw new SshError("INVALID_ARGUMENT", "connect requires a valid profile name");
    return;
  }
  if (params.operation === "list") return;
  if (params.session === undefined) throw new SshError("INVALID_ARGUMENT", `${params.operation} requires a session ID`);
  if (params.operation === "command") {
    if (params.command === undefined) throw new SshError("INVALID_ARGUMENT", `command must contain 1-${SSH_COMMAND_MAX_CHARS} characters`);
    if (/[\u0000-\u0008\u000b-\u000d\u000e-\u001f\u007f]/.test(params.command)) throw new SshError("INVALID_ARGUMENT", "command cannot contain terminal control characters");
  } else if (params.operation === "read") {
    if (params.waitMs !== undefined && params.waitMs > SSH_READ_WAIT_MAX_MS) throw new SshError("INVALID_ARGUMENT", `read waitMs must be at most ${SSH_READ_WAIT_MAX_MS}`);
  } else if (params.operation === "input") {
    if (params.data === undefined) throw new SshError("INVALID_ARGUMENT", `data must be at most ${SSH_INPUT_MAX_CHARS} characters`);
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(params.data)) throw new SshError("INVALID_ARGUMENT", "input data cannot contain terminal control characters");
  }
}

/** The model-facing outcome of one observed command state. */
interface CommandOutcome {
  status: SshDetails["status"];
  code: string;
  message: string;
}

/** A command state plus the aborted wait that can end a command or a read. */
type CommandOutcomeState = SshCommandState | "aborted";

/** What an operation observed when it resolved a command state. */
interface CommandObservation {
  /** The operation reporting the state. */
  operation: "command" | "read";
  /** The projected page carries text; a read reports this in its message. */
  hasOutput?: boolean;
  /** Exit code of a completed command. */
  exitCode?: number;
  /** A throttled streaming update published while the command is still running. */
  streaming?: boolean;
}

/** The message a read reports about its projected page. */
function readOutputMessage(hasOutput: boolean | undefined): string {
  return hasOutput ? "SSH output read" : "No new SSH output";
}

/**
 * The single mapping from command state to the model-facing status, code, and
 * message shared by `command` and `read`, so the two operations cannot derive
 * the same state differently. The message follows the observer: a read reports
 * whether its page carried text, a command reports its lifecycle, and the
 * streaming update published while waiting is worded differently from the
 * final wait.
 *
 * The type covers every `SshCommandState`, but the manager only produces a
 * subset per caller: `command` resolves to `completed | disconnected |
 * running`, `read` to `running | idle | disconnected`. `idle` under
 * `command` and `completed` under `read` are therefore unreachable today —
 * if the manager ever widened either caller's result to include its missing
 * state, revisit the message for that row before relying on it.
 */
const COMMAND_OUTCOMES: Record<CommandOutcomeState, {
  status: SshDetails["status"];
  code: string;
  message: (observation: CommandObservation) => string;
}> = {
  idle: {
    status: "success",
    code: "OK",
    message: ({ hasOutput }) => readOutputMessage(hasOutput),
  },
  running: {
    status: "running",
    code: "COMMAND_RUNNING",
    message: (observation) => {
      if (observation.operation === "read") return readOutputMessage(observation.hasOutput);
      return observation.streaming ? "Remote command is running" : "Remote command is still running";
    },
  },
  completed: {
    status: "success",
    code: "COMMAND_COMPLETED",
    message: ({ exitCode }) => `Remote command exited with code ${exitCode}`,
  },
  disconnected: {
    status: "error",
    code: "SESSION_DISCONNECTED",
    message: (observation) => {
      if (observation.operation === "read") return readOutputMessage(observation.hasOutput);
      return "SSH session disconnected before the command completed";
    },
  },
  aborted: {
    status: "aborted",
    code: "ABORTED",
    message: ({ operation }) => operation === "read"
      ? "SSH output wait was cancelled"
      : "Remote command wait was cancelled and an interrupt was sent",
  },
};

function commandOutcome(state: CommandOutcomeState, observation: CommandObservation): CommandOutcome {
  const row = COMMAND_OUTCOMES[state];
  return { status: row.status, code: row.code, message: row.message(observation) };
}

/** Build the model-facing details for one observed page. */
function pageDetails(
  operation: SshOperation,
  session: SshSessionSummary,
  page: SshOutputPage,
  outcome: CommandOutcome,
  exitCode?: number,
): SshDetails {
  const { text: _text, ...outputPage } = page;
  return {
    ...baseDetails(operation, outcome.status, outcome.code, outcome.message),
    session,
    outputPage,
    ...(exitCode !== undefined ? { exitCode } : {}),
  };
}

function result(details: SshDetails, output?: string) {
  const body = {
    ...details,
    ...(output !== undefined ? { output: cleanDisplay(output, SSH_MODEL_OUTPUT_CHARS) } : {}),
  };
  const serialized = JSON.stringify(body);
  if (serialized.length > SSH_MODEL_RESULT_CHARS) {
    throw new SshError("MODEL_OUTPUT_LIMIT", "SSH result exceeded the model output limit");
  }
  return {
    content: [{ type: "text" as const, text: serialized }],
    ...(details.status === "error" || details.status === "aborted" ? { isError: true } : {}),
    details,
  };
}

function baseDetails(operation: SshOperation, status: SshDetails["status"], code: string, message: string): SshDetails {
  return { version: SSH_TOOL_VERSION, status, operation, code, message };
}

function failure(operation: SshOperation, error: unknown) {
  const code = sshErrorCode(error);
  const message = cleanDisplay(sshErrorMessage(error), 1_000);
  return result(baseDetails(operation, code === "ABORTED" ? "aborted" : "error", code, message));
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
      "Do not use exec or exit when later calls must reuse the persistent shell or receive its completion marker; either command may end the SSH session.",
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
            sessions,
            profiles,
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
              const approved = await withOwnedInputSurface(() => ctx.ui.confirm(
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
              ));
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
          const details = pageDetails("connect", session.summary(), page.page, {
            status: "success",
            code: "CONNECTED",
            message: `Connected ${session.id} to ${session.summary().endpoint}`,
          });
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
                const partialDetails = pageDetails(
                  "command",
                  session.summary(),
                  snapshot.page,
                  commandOutcome("running", { operation: "command", streaming: true }),
                );
                onUpdate?.(result(partialDetails, snapshot.page.text));
              }).catch(() => {});
            }, UPDATE_INTERVAL_MS);
          };
          const unsubscribe = session.subscribe(publish);
          try {
            const commandResult = await session.command(params.command!, params.waitMs ?? SSH_WAIT_DEFAULT_MS, signal);
            const aborted = Boolean(signal?.aborted);
            const exitCode = aborted ? undefined : commandResult.exitCode;
            const details = pageDetails(
              "command",
              session.summary(),
              commandResult.page,
              commandOutcome(aborted ? "aborted" : commandResult.state, { operation: "command", exitCode }),
              exitCode,
            );
            return result(details, commandResult.page.text);
          } finally {
            unsubscribe();
            if (updateTimer) clearTimeout(updateTimer);
          }
        }

        if (params.operation === "read") {
          const readResult = await session.read(params.cursor, Math.min(params.waitMs ?? 0, SSH_READ_WAIT_MAX_MS), signal);
          const details = pageDetails(
            "read",
            session.summary(),
            readResult.page,
            commandOutcome(signal?.aborted ? "aborted" : readResult.state, {
              operation: "read",
              hasOutput: Boolean(readResult.page.text),
            }),
          );
          return result(details, readResult.page.text);
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
