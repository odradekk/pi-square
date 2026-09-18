import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { EventEmitter } from "node:events";
import ssh2, {
  type Channel,
  type ConnectConfig,
  type PseudoTtyOptions,
} from "ssh2";

const { utils } = ssh2;

import type { SshProfileConfig, SshTargetConfig } from "../core/config";
import { SSH_PRIVATE_KEY_MAX_BYTES } from "./contracts";
import { SshError } from "./errors";

export interface SshChannelLike extends EventEmitter {
  stderr?: EventEmitter;
  write(data: string | Buffer): boolean;
  end(): void;
  signal?(signalName: string): void;
}

export interface SshClientLike extends EventEmitter {
  connect(config: ConnectConfig): void;
  shell(
    window: PseudoTtyOptions,
    callback: (error: Error | undefined, channel: Channel) => void,
  ): void;
  end(): void;
  destroy(): void;
}

export type SshClientFactory = () => SshClientLike;
export type SecretRequester = (purpose: string) => Promise<Buffer | undefined>;

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

export function safeReason(error: unknown): string {
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

export async function connectConfig(
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

interface ClientErrorGuard {
  readonly error: Error | undefined;
  release(): void;
}

export function guardClientErrorsUntilClose(client: SshClientLike): ClientErrorGuard {
  let firstError: Error | undefined;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    client.removeListener("error", onError);
    client.removeListener("close", onClose);
  };
  // ssh2 can emit a socket error and then a fatal pre-handshake error before close.
  const onError = (error: unknown) => {
    firstError ??= error instanceof Error ? error : new Error(String(error));
  };
  const onClose = () => release();
  client.on("error", onError);
  client.once("close", onClose);
  return {
    get error() { return firstError; },
    release,
  };
}

export function waitForReady(client: SshClientLike, config: ConnectConfig, signal?: AbortSignal): Promise<void> {
  return new Promise((resolveReady, rejectReady) => {
    let settled = false;
    const cleanup = () => {
      client.removeListener("ready", onReady);
      client.removeListener("error", onError);
      client.removeListener("close", onClose);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) rejectReady(error);
      else resolveReady();
    };
    const onReady = () => finish();
    const onError = (error: Error) => finish(error);
    const onClose = () => finish(new SshError("CONNECTION_CLOSED", "SSH connection closed before authentication completed"));
    const onAbort = () => {
      finish(new SshError("ABORTED", "SSH connection was cancelled"));
      try { client.destroy(); } catch { /* best effort */ }
    };
    client.once("ready", onReady);
    client.once("error", onError);
    client.once("close", onClose);
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      if (signal?.aborted) onAbort();
      else client.connect(config);
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

export function openShell(client: SshClientLike, signal?: AbortSignal): Promise<SshChannelLike> {
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
