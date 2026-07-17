import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { EventEmitter } from "node:events";
import { StringDecoder } from "node:string_decoder";
import ssh2, {
  type Channel,
  type ConnectConfig,
} from "ssh2";

const { Client, utils } = ssh2;

import type { SshConfig, SshProfileConfig, SshTargetConfig } from "../core/config";
import {
  SSH_PRIVATE_KEY_MAX_BYTES,
  SSH_SESSION_BUFFER_BYTES,
  type SshCommandResult,
  type SshSessionState,
  type SshSessionSummary,
} from "./contracts";
import { SshOutputBuffer } from "./buffer";
import { SshError } from "./errors";

const BOOTSTRAP_COMMAND = "unset PROMPT_COMMAND 2>/dev/null || :; PS1=''; PS2=''; PROMPT=''; RPROMPT=''; export PS1 PS2";
const DISCONNECTED_RECORD_LIMIT = 64;

export interface SshChannelLike extends EventEmitter {
  stderr?: EventEmitter;
  write(data: string | Buffer): boolean;
  end(): void;
  signal?(signalName: string): void;
}

export interface SshClientLike extends EventEmitter {
  connect(config: ConnectConfig): void;
  shell(
    window: { rows: number; cols: number; term: string; modes: { ECHO: 0; ECHONL: 0 } },
    callback: (error: Error | undefined, channel: Channel) => void,
  ): void;
  end(): void;
  destroy(): void;
}

export type SshClientFactory = () => SshClientLike;
export type SecretRequester = (purpose: string) => Promise<Buffer | undefined>;

interface ActiveCommand {
  marker: string;
  markerPattern: RegExp;
  pending: string;
  startCursor: number;
  completed: boolean;
  disconnected: boolean;
  exitCode?: number;
  done: Promise<void>;
  resolve: () => void;
}

function normalizeFingerprint(value: string): string {
  return value.replace(/=+$/, "");
}

export function hostFingerprint(key: Buffer): string {
  return `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
}

export function matchesFingerprint(actual: string, expected: readonly string[]): boolean {
  const actualBuffer = Buffer.from(normalizeFingerprint(actual));
  return expected.some((candidate) => {
    const candidateBuffer = Buffer.from(normalizeFingerprint(candidate));
    return actualBuffer.length === candidateBuffer.length && timingSafeEqual(actualBuffer, candidateBuffer);
  });
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return resolve(homedir(), path.slice(2));
  return resolve(path);
}

function safeReason(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 500) || "SSH connection closed";
}

async function loadPrivateKey(
  profile: SshProfileConfig,
  requestSecret: SecretRequester,
): Promise<{ privateKey: Buffer; passphrase?: Buffer }> {
  if (profile.auth.method !== "privateKey") throw new SshError("AUTH_CONFIG", "SSH profile does not use private-key authentication");
  let bytes: Buffer;
  try {
    const path = expandHome(profile.auth.privateKeyPath);
    const stat = statSync(path);
    if (!stat.isFile() || stat.size <= 0 || stat.size > SSH_PRIVATE_KEY_MAX_BYTES) {
      throw new SshError("PRIVATE_KEY_INVALID", "Configured SSH private key must be a non-empty regular file no larger than 1 MiB");
    }
    bytes = readFileSync(path);
  } catch (error) {
    if (error instanceof SshError) throw error;
    throw new SshError("PRIVATE_KEY_UNAVAILABLE", "Configured SSH private key could not be read");
  }

  const parsed = utils.parseKey(bytes);
  if (!(parsed instanceof Error)) return { privateKey: bytes };
  if (!/encrypted|passphrase/i.test(parsed.message)) {
    bytes.fill(0);
    throw new SshError("PRIVATE_KEY_INVALID", "Configured SSH private key is invalid or unsupported");
  }
  const passphrase = await requestSecret(`Unlock private key for SSH profile '${profile.name}'`);
  if (!passphrase) {
    bytes.fill(0);
    throw new SshError("SECRET_INPUT_CANCELLED", "Private-key passphrase entry was cancelled");
  }
  const unlocked = utils.parseKey(bytes, passphrase);
  if (unlocked instanceof Error) {
    bytes.fill(0);
    passphrase.fill(0);
    throw new SshError("PRIVATE_KEY_PASSPHRASE", "SSH private-key passphrase was rejected");
  }
  return { privateKey: bytes, passphrase };
}

async function connectConfig(
  profile: SshProfileConfig,
  target: SshTargetConfig,
  requestSecret: SecretRequester,
): Promise<ConnectConfig> {
  const config: ConnectConfig = {
    host: target.host,
    port: target.port,
    username: target.username,
    readyTimeout: profile.connectTimeoutMs,
    keepaliveInterval: profile.keepaliveIntervalMs,
    keepaliveCountMax: profile.keepaliveCountMax,
    agentForward: false,
    hostVerifier: (key: Buffer) => matchesFingerprint(hostFingerprint(key), target.fingerprints),
  };
  if (profile.auth.method === "agent") {
    const agent = profile.auth.socket
      ?? process.env.SSH_AUTH_SOCK
      ?? (process.platform === "win32" ? "pageant" : undefined);
    if (!agent) throw new SshError("SSH_AGENT_UNAVAILABLE", "SSH agent authentication requires a configured socket or SSH_AUTH_SOCK");
    config.agent = agent;
  } else {
    const key = await loadPrivateKey(profile, requestSecret);
    config.privateKey = key.privateKey;
    if (key.passphrase) config.passphrase = key.passphrase;
  }
  return config;
}

function possibleMarkerSuffixLength(text: string, marker: string): number {
  const markerIndex = text.lastIndexOf(marker);
  if (markerIndex >= 0 && /^-?[0-9]*\r?$/.test(text.slice(markerIndex + marker.length))) {
    let start = markerIndex;
    if (start > 0 && text[start - 1] === "\n") start -= 1;
    if (start > 0 && text[start - 1] === "\r") start -= 1;
    return text.length - start;
  }
  let keep = 0;
  for (const candidate of [marker, `\n${marker}`, `\r\n${marker}`]) {
    const limit = Math.min(text.length, candidate.length - 1);
    for (let length = limit; length > keep; length -= 1) {
      if (candidate.startsWith(text.slice(-length))) {
        keep = length;
        break;
      }
    }
  }
  return keep;
}

function waitForPromise(promise: Promise<void>, timeoutMs: number, signal?: AbortSignal): Promise<"done" | "timeout" | "aborted"> {
  if (signal?.aborted) return Promise.resolve("aborted");
  return new Promise((resolveResult) => {
    let settled = false;
    const finish = (result: "done" | "timeout" | "aborted") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolveResult(result);
    };
    const timer = setTimeout(() => finish("timeout"), timeoutMs);
    const onAbort = () => finish("aborted");
    signal?.addEventListener("abort", onAbort, { once: true });
    void promise.then(() => finish("done"));
  });
}

export class SshSession {
  readonly createdAt = Date.now();
  lastActivityAt = this.createdAt;
  state: SshSessionState = "connected";
  disconnectReason?: string;
  private readonly output = new SshOutputBuffer(SSH_SESSION_BUFFER_BYTES);
  private readonly decoder = new StringDecoder("utf8");
  private active?: ActiveCommand;
  private readonly listeners = new Set<() => void>();

  constructor(
    readonly id: string,
    readonly label: string | undefined,
    readonly profile: SshProfileConfig,
    readonly target: SshTargetConfig,
    private readonly client: SshClientLike,
    private readonly channel: SshChannelLike,
  ) {
    channel.on("data", (chunk: Buffer | string) => this.handleData(chunk));
    channel.stderr?.on("data", (chunk: Buffer | string) => this.handleData(chunk));
    channel.on("close", () => this.markDisconnected("SSH shell channel closed"));
    channel.on("error", (error: unknown) => this.markDisconnected(safeReason(error)));
    client.on("error", (error: unknown) => this.markDisconnected(safeReason(error)));
    client.on("close", () => this.markDisconnected("SSH transport closed"));
  }

  get isRunning(): boolean {
    return this.active !== undefined;
  }

  summary(): SshSessionSummary {
    return {
      id: this.id,
      ...(this.label ? { label: this.label } : {}),
      profile: this.profile.name,
      target: this.target.name,
      endpoint: `${this.target.username}@${this.target.host}:${this.target.port}`,
      state: this.state,
      commandState: this.active ? "running" : this.state === "connected" ? "idle" : "disconnected",
      createdAt: this.createdAt,
      lastActivityAt: this.lastActivityAt,
      oldestCursor: this.output.oldestCursor,
      newestCursor: this.output.newestCursor,
      ...(this.disconnectReason ? { disconnectReason: this.disconnectReason } : {}),
    };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async bootstrap(signal?: AbortSignal): Promise<void> {
    const result = await this.command(BOOTSTRAP_COMMAND, 5_000, signal);
    if (result.state !== "completed" || result.exitCode !== 0) {
      throw new SshError("SHELL_BOOTSTRAP_FAILED", "Remote POSIX shell did not complete the initialization handshake");
    }
  }

  async command(command: string, waitMs: number, signal?: AbortSignal): Promise<SshCommandResult> {
    this.assertConnected();
    if (this.active) throw new SshError("COMMAND_ACTIVE", "This SSH session already has a running foreground command");
    const startCursor = this.output.newestCursor;
    let resolveDone!: () => void;
    const token = randomBytes(18).toString("hex");
    const marker = `__PI_SSH_${token}__:`;
    const active: ActiveCommand = {
      marker,
      markerPattern: new RegExp(`(?:\\r?\\n)?${marker}(-?[0-9]+)\\r?\\n`),
      pending: "",
      startCursor,
      completed: false,
      disconnected: false,
      done: new Promise<void>((resolvePromise) => { resolveDone = resolvePromise; }),
      resolve: () => resolveDone(),
    };
    this.active = active;
    this.touch();
    const frame = `${command}\n__pi_square_rc=$?\nprintf '\\n${marker}%s\\n' "$__pi_square_rc"\nunset __pi_square_rc\n`;
    this.channel.write(frame);
    const outcome = await waitForPromise(active.done, waitMs, signal);
    if (outcome === "aborted") this.interrupt();
    const state = active.completed ? "completed" : active.disconnected ? "disconnected" : "running";
    return {
      state,
      ...(active.completed && active.exitCode !== undefined ? { exitCode: active.exitCode } : {}),
      page: this.output.read(startCursor),
    };
  }

  async read(cursor: number | undefined, waitMs: number, signal?: AbortSignal): Promise<SshCommandResult> {
    this.assertReadable();
    this.touch();
    const requested = cursor ?? this.output.oldestCursor;
    const before = this.output.newestCursor;
    if (waitMs > 0 && requested >= before && this.state === "connected") {
      let resolveChange!: () => void;
      const changed = new Promise<void>((resolvePromise) => { resolveChange = resolvePromise; });
      const unsubscribe = this.subscribe(resolveChange);
      try {
        await waitForPromise(changed, waitMs, signal);
      } finally {
        unsubscribe();
      }
    }
    const page = this.output.read(requested);
    return {
      state: this.active ? "running" : this.state === "connected" ? "idle" : "disconnected",
      page,
    };
  }

  input(data: string | Buffer, newline: boolean): void {
    this.assertConnected();
    if (!this.active) throw new SshError("NO_ACTIVE_COMMAND", "SSH input requires a running foreground command");
    this.channel.write(data);
    if (newline) this.channel.write("\n");
    this.touch();
  }

  interrupt(): void {
    this.assertConnected();
    if (!this.active) throw new SshError("NO_ACTIVE_COMMAND", "SSH interrupt requires a running foreground command");
    try {
      if (this.channel.signal) this.channel.signal("INT");
      else this.channel.write("\x03");
    } catch {
      this.channel.write("\x03");
    }
    this.touch();
  }

  close(reason = "SSH session closed"): void {
    if (this.state === "closed" || this.state === "closing") return;
    this.state = "closing";
    this.disconnectReason = reason;
    try { this.channel.end(); } catch { /* best effort */ }
    try { this.client.end(); } catch { /* best effort */ }
    this.state = "closed";
    this.flushDecoder();
    this.finishActive(true);
    this.emitChange();
  }

  private handleData(chunk: Buffer | string): void {
    const text = Buffer.isBuffer(chunk) ? this.decoder.write(chunk) : String(chunk);
    if (!text) return;
    this.touch();
    const active = this.active;
    if (!active) {
      this.output.append(text);
      this.emitChange();
      return;
    }
    active.pending += text;
    const match = active.markerPattern.exec(active.pending);
    if (match && match.index >= 0) {
      this.output.append(active.pending.slice(0, match.index));
      const remainder = active.pending.slice(match.index + match[0].length);
      if (remainder) this.output.append(remainder);
      active.pending = "";
      active.exitCode = Number.parseInt(match[1]!, 10);
      active.completed = true;
      this.active = undefined;
      active.resolve();
      this.emitChange();
      return;
    }
    const keep = possibleMarkerSuffixLength(active.pending, active.marker);
    if (active.pending.length > keep) {
      this.output.append(active.pending.slice(0, active.pending.length - keep));
      active.pending = keep > 0 ? active.pending.slice(-keep) : "";
    }
    this.emitChange();
  }

  private markDisconnected(reason: string): void {
    if (this.state === "closed" || this.state === "closing" || this.state === "disconnected") return;
    this.state = "disconnected";
    this.disconnectReason = reason;
    this.flushDecoder();
    this.output.end();
    this.finishActive(true);
    this.emitChange();
  }

  private flushDecoder(): void {
    const remaining = this.decoder.end();
    if (remaining) this.handleData(remaining);
  }

  private finishActive(disconnected: boolean): void {
    const active = this.active;
    if (!active) return;
    if (active.pending) this.output.append(active.pending);
    active.pending = "";
    active.disconnected = disconnected;
    this.active = undefined;
    active.resolve();
  }

  private assertConnected(): void {
    if (this.state !== "connected") throw new SshError("SESSION_DISCONNECTED", `SSH session is ${this.state}`);
  }

  private assertReadable(): void {
    if (this.state === "closed") throw new SshError("SESSION_CLOSED", "SSH session is closed");
  }

  private touch(): void {
    this.lastActivityAt = Date.now();
  }

  private emitChange(): void {
    for (const listener of this.listeners) listener();
  }
}

function waitForReady(client: SshClientLike, config: ConnectConfig, signal?: AbortSignal): Promise<void> {
  return new Promise((resolveReady, rejectReady) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      if (error) rejectReady(error);
      else resolveReady();
    };
    const onAbort = () => {
      finish(new SshError("ABORTED", "SSH connection was cancelled"));
      try { client.destroy(); } catch { /* best effort */ }
    };
    client.once("ready", () => finish());
    client.once("error", (error: Error) => finish(error));
    client.once("close", () => finish(new SshError("CONNECTION_CLOSED", "SSH connection closed before authentication completed")));
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      client.connect(config);
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    } finally {
      if (Buffer.isBuffer(config.privateKey)) config.privateKey.fill(0);
      if (Buffer.isBuffer(config.passphrase)) config.passphrase.fill(0);
      delete config.privateKey;
      delete config.passphrase;
    }
  });
}

function openShell(client: SshClientLike, signal?: AbortSignal): Promise<SshChannelLike> {
  return new Promise((resolveShell, rejectShell) => {
    let settled = false;
    const cleanup = () => {
      client.removeListener("error", onError);
      client.removeListener("close", onClose);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (error?: Error, channel?: SshChannelLike) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) rejectShell(error);
      else resolveShell(channel!);
    };
    const onError = (error: Error) => finish(error);
    const onClose = () => finish(new SshError("CONNECTION_CLOSED", "SSH transport closed before the shell channel opened"));
    const onAbort = () => {
      finish(new SshError("ABORTED", "SSH shell creation was cancelled"));
      try { client.destroy(); } catch { /* best effort */ }
    };
    client.once("error", onError);
    client.once("close", onClose);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    client.shell(
      { rows: 40, cols: 120, term: "dumb", modes: { ECHO: 0, ECHONL: 0 } },
      (error, channel) => finish(error, channel),
    );
  });
}

export class SshSessionManager {
  private config: SshConfig = { maxSessions: 8, profiles: [] };
  private readonly sessions = new Map<string, SshSession>();
  private pendingConnections = 0;
  private readonly pendingByProfile = new Map<string, number>();
  private readonly pendingClients = new Set<SshClientLike>();
  private readonly timer: NodeJS.Timeout;

  constructor(private readonly createClient: SshClientFactory = () => new Client()) {
    this.timer = setInterval(() => this.sweepIdle(), 30_000);
    this.timer.unref();
  }

  configure(config: SshConfig): void {
    this.config = structuredClone(config);
  }

  profiles(): SshProfileConfig[] {
    return this.config.profiles.map((profile) => structuredClone(profile));
  }

  resolve(profileName: string, targetName?: string): { profile: SshProfileConfig; target: SshTargetConfig } {
    const profile = this.config.profiles.find((candidate) => candidate.name === profileName);
    if (!profile) throw new SshError("PROFILE_NOT_FOUND", `Unknown SSH profile '${profileName}'`);
    const selectedTarget = targetName ?? profile.defaultTarget;
    const target = profile.targets.find((candidate) => candidate.name === selectedTarget);
    if (!target) throw new SshError("TARGET_NOT_FOUND", `Unknown target '${selectedTarget}' in SSH profile '${profileName}'`);
    return { profile, target };
  }

  async connect(
    profileName: string,
    targetName: string | undefined,
    label: string | undefined,
    requestSecret: SecretRequester,
    signal?: AbortSignal,
  ): Promise<SshSession> {
    const { profile, target } = this.resolve(profileName, targetName);
    const connected = [...this.sessions.values()].filter((session) => session.state === "connected");
    if (connected.length + this.pendingConnections >= this.config.maxSessions) {
      throw new SshError("GLOBAL_SESSION_LIMIT", `SSH global session limit (${this.config.maxSessions}) reached`);
    }
    const profileCount = connected.filter((session) => session.profile.name === profile.name).length;
    const profilePending = this.pendingByProfile.get(profile.name) ?? 0;
    if (profileCount + profilePending >= profile.maxSessions) {
      throw new SshError("PROFILE_SESSION_LIMIT", `SSH profile '${profile.name}' session limit (${profile.maxSessions}) reached`);
    }

    this.pendingConnections += 1;
    this.pendingByProfile.set(profile.name, profilePending + 1);
    const client = this.createClient();
    this.pendingClients.add(client);
    try {
      const config = await connectConfig(profile, target, requestSecret);
      await waitForReady(client, config, signal);
      const channel = await openShell(client, signal);
      const session = new SshSession(
        `ssh-${randomBytes(8).toString("hex")}`,
        label,
        profile,
        target,
        client,
        channel,
      );
      try {
        await session.bootstrap(signal);
      } catch (error) {
        session.close("SSH shell initialization failed");
        throw error;
      }
      this.sessions.set(session.id, session);
      this.pruneDisconnected();
      return session;
    } catch (error) {
      try { client.end(); } catch { /* best effort */ }
      if (error instanceof SshError) throw error;
      throw new SshError("CONNECTION_FAILED", safeReason(error));
    } finally {
      this.pendingClients.delete(client);
      this.pendingConnections -= 1;
      const remaining = (this.pendingByProfile.get(profile.name) ?? 1) - 1;
      if (remaining > 0) this.pendingByProfile.set(profile.name, remaining);
      else this.pendingByProfile.delete(profile.name);
    }
  }

  get(id: string): SshSession {
    const session = this.sessions.get(id);
    if (!session) throw new SshError("SESSION_NOT_FOUND", `Unknown SSH session '${id}'`);
    return session;
  }

  list(): SshSessionSummary[] {
    return [...this.sessions.values()]
      .map((session) => session.summary())
      .sort((left, right) => left.createdAt - right.createdAt);
  }

  close(id: string, reason?: string): SshSessionSummary {
    const session = this.get(id);
    session.close(reason);
    const summary = session.summary();
    this.sessions.delete(id);
    return summary;
  }

  reset(reason = "Pi session reset"): void {
    for (const client of this.pendingClients) {
      try { client.destroy(); } catch { /* best effort */ }
    }
    for (const session of this.sessions.values()) session.close(reason);
    this.sessions.clear();
  }

  dispose(reason = "Pi session shutdown"): void {
    clearInterval(this.timer);
    this.reset(reason);
  }

  sweepIdle(now = Date.now()): string[] {
    const closed: string[] = [];
    for (const [id, session] of this.sessions) {
      const timeoutMs = session.profile.idleTimeoutMinutes * 60_000;
      if (session.state === "connected" && !session.isRunning && now - session.lastActivityAt >= timeoutMs) {
        session.close("SSH session closed after idle timeout");
        this.sessions.delete(id);
        closed.push(id);
      }
    }
    this.pruneDisconnected();
    return closed;
  }

  private pruneDisconnected(): void {
    const disconnected = [...this.sessions.values()]
      .filter((session) => session.state === "disconnected")
      .sort((left, right) => left.lastActivityAt - right.lastActivityAt);
    for (const session of disconnected.slice(0, Math.max(0, disconnected.length - DISCONNECTED_RECORD_LIMIT))) {
      this.sessions.delete(session.id);
    }
  }
}
