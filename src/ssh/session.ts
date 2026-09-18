import { randomBytes } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

import type { SshProfileConfig, SshTargetConfig } from "../core/config";
import {
  SSH_SESSION_BUFFER_BYTES,
  type SshCommandResult,
  type SshCommandState,
  type SshSessionState,
  type SshSessionSummary,
} from "./contracts";
import { SshOutputBuffer } from "./buffer";
import { SshError } from "./errors";
import { safeReason, type SshChannelLike, type SshClientLike } from "./connect";

const BOOTSTRAP_COMMAND = "unset PROMPT_COMMAND 2>/dev/null || :; PS1=''; PS2=''; PROMPT=''; RPROMPT=''; export PS1 PS2";

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
  private activityAt = this.createdAt;
  private currentState: SshSessionState = "connected";
  private terminationReason?: string;
  private readonly output = new SshOutputBuffer(SSH_SESSION_BUFFER_BYTES);
  private readonly decoder = new StringDecoder("utf8");
  private active?: ActiveCommand;
  private readonly listeners = new Set<() => void>();
  private channelEnded = false;
  private transportEnded = false;

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
    channel.on("close", () => {
      this.channelEnded = true;
      this.markDisconnected("SSH shell channel closed");
    });
    channel.on("error", (error: unknown) => this.markDisconnected(safeReason(error)));
    client.on("error", (error: unknown) => this.markDisconnected(safeReason(error)));
    client.on("close", () => {
      this.transportEnded = true;
      this.markDisconnected("SSH transport closed");
    });
  }

  get state(): SshSessionState {
    return this.currentState;
  }

  get disconnectReason(): string | undefined {
    return this.terminationReason;
  }

  get lastActivityAt(): number {
    return this.activityAt;
  }

  get isRunning(): boolean {
    return this.active !== undefined;
  }

  get commandState(): SshCommandState {
    return this.active ? "running" : this.currentState === "connected" ? "idle" : "disconnected";
  }

  summary(): SshSessionSummary {
    return {
      id: this.id,
      ...(this.label ? { label: this.label } : {}),
      profile: this.profile.name,
      target: this.target.name,
      endpoint: `${this.target.username}@${this.target.host}:${this.target.port}`,
      state: this.currentState,
      commandState: this.commandState,
      createdAt: this.createdAt,
      lastActivityAt: this.activityAt,
      oldestCursor: this.output.oldestCursor,
      newestCursor: this.output.newestCursor,
      ...(this.terminationReason ? { disconnectReason: this.terminationReason } : {}),
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
      state: this.commandState,
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
    if (this.currentState === "closed") return;
    this.teardown("closed", reason);
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
    if (this.currentState === "closed" || this.currentState === "closing" || this.currentState === "disconnected") return;
    this.teardown("disconnected", reason);
  }

  /**
   * The one teardown sequence shared by an explicit close and an observed
   * disconnect. The terminal state is already in place when the channel and
   * transport are ended, so their close events re-enter `markDisconnected` as a
   * no-op; the session decoder and any running command are drained first.
   *
   * Draining before the two end calls is only safe because neither
   * `Channel.end()` nor `Client.end()` synchronously delivers inbound data:
   * both write on the outgoing side and surface anything further through a
   * later event-loop turn. So no completion marker can arrive after
   * `finishActive` has cleared the active command, which is what keeps
   * `handleData`'s no-active-command branch from appending a raw marker to the
   * model-facing output. If a future ssh2 ever emitted `data` synchronously
   * from either call, that invariant would break and the drain would have to
   * move back after the ends.
   */
  private teardown(state: "disconnected" | "closed", reason: string): void {
    this.currentState = state;
    this.terminationReason = reason;
    this.flushDecoder();
    this.finishActive(true);
    this.endChannel();
    this.endTransport();
    this.emitChange();
  }

  private endChannel(): void {
    if (this.channelEnded) return;
    this.channelEnded = true;
    try { this.channel.end(); } catch { /* best effort */ }
  }

  private endTransport(): void {
    if (this.transportEnded) return;
    this.transportEnded = true;
    try { this.client.end(); } catch { /* best effort */ }
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
    this.activityAt = Date.now();
  }

  private emitChange(): void {
    for (const listener of this.listeners) listener();
  }
}
