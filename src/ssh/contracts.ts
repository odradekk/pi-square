export const SSH_TOOL_VERSION = 1;
export const SSH_COMMAND_MAX_CHARS = 20_000;
export const SSH_INPUT_MAX_CHARS = 4_096;
export const SSH_LABEL_MAX_CHARS = 64;
export const SSH_WAIT_DEFAULT_MS = 10_000;
export const SSH_WAIT_MAX_MS = 60_000;
export const SSH_READ_WAIT_MAX_MS = 30_000;
export const SSH_SESSION_BUFFER_BYTES = 256 * 1024;
export const SSH_MODEL_OUTPUT_CHARS = 24_000;
export const SSH_LIST_SECTION_CHARS = 24_000;
export const SSH_MODEL_RESULT_CHARS = 64_000;
export const SSH_PRIVATE_KEY_MAX_BYTES = 1024 * 1024;

export type SshOperation =
  | "connect"
  | "command"
  | "read"
  | "input"
  | "secret_input"
  | "interrupt"
  | "close"
  | "list";

export interface SshToolParams {
  operation: SshOperation;
  profile?: string;
  target?: string;
  label?: string;
  session?: string;
  command?: string;
  data?: string;
  newline?: boolean;
  prompt?: string;
  cursor?: number;
  waitMs?: number;
}

export type SshSessionState = "connected" | "disconnected" | "closing" | "closed";
export type SshCommandState = "idle" | "running" | "completed" | "disconnected";

export interface SshOutputPage {
  text: string;
  requestedCursor: number;
  cursor: number;
  nextCursor: number;
  oldestCursor: number;
  newestCursor: number;
  cursorExpired: boolean;
  hasMore: boolean;
  droppedChars: number;
}

export interface SshSessionSummary {
  id: string;
  label?: string;
  profile: string;
  target: string;
  endpoint: string;
  state: SshSessionState;
  commandState: SshCommandState;
  createdAt: number;
  lastActivityAt: number;
  oldestCursor: number;
  newestCursor: number;
  disconnectReason?: string;
}

export interface SshCommandResult {
  state: SshCommandState;
  exitCode?: number;
  page: SshOutputPage;
}

export interface SshProfileSummary {
  name: string;
  defaultTarget: string;
  targets: Array<{ name: string; endpoint: string }>;
  maxSessions: number;
}

export interface SshDetails {
  version: 1;
  operation: SshOperation;
  status: "success" | "running" | "declined" | "aborted" | "error";
  code: string;
  message: string;
  session?: SshSessionSummary;
  sessions?: SshSessionSummary[];
  profiles?: SshProfileSummary[];
  omissions?: { profiles: number; targets: number; sessions: number };
  output?: Omit<SshOutputPage, "text">;
  exitCode?: number;
}
