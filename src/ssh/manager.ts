import { randomBytes } from "node:crypto";
import ssh2 from "ssh2";

const { Client } = ssh2;

import type { SshConfig, SshProfileConfig, SshTargetConfig } from "../core/config";
import { type SshSessionSummary } from "./contracts";
import { SshError } from "./errors";
import { SshSession } from "./session";
import {
  connectConfig,
  guardClientErrorsUntilClose,
  openShell,
  safeReason,
  waitForReady,
  type SecretRequester,
  type SshClientFactory,
  type SshClientLike,
} from "./connect";

const DISCONNECTED_RECORD_LIMIT = 64;

export class SshSessionManager {
  private config: SshConfig = { maxSessions: 8, profiles: [] };
  private readonly sessions = new Map<string, SshSession>();
  // In-flight connections, keyed by client with the owning profile name as the value.
  private readonly pendingClients = new Map<SshClientLike, string>();
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
    if (connected.length + this.pendingClients.size >= this.config.maxSessions) {
      throw new SshError("GLOBAL_SESSION_LIMIT", `SSH global session limit (${this.config.maxSessions}) reached`);
    }
    const profileCount = connected.filter((session) => session.profile.name === profile.name).length;
    const profilePending = [...this.pendingClients.values()].filter((name) => name === profile.name).length;
    if (profileCount + profilePending >= profile.maxSessions) {
      throw new SshError("PROFILE_SESSION_LIMIT", `SSH profile '${profile.name}' session limit (${profile.maxSessions}) reached`);
    }

    const client = this.createClient();
    const clientErrorGuard = guardClientErrorsUntilClose(client);
    let session: SshSession | undefined;
    this.pendingClients.set(client, profile.name);
    try {
      const config = await connectConfig(profile, target, requestSecret);
      await waitForReady(client, config, signal);
      if (clientErrorGuard.error) throw clientErrorGuard.error;
      const channel = await openShell(client, signal);
      if (clientErrorGuard.error) {
        try { channel.end(); } catch { /* best effort */ }
        throw clientErrorGuard.error;
      }
      session = new SshSession(
        `ssh-${randomBytes(8).toString("hex")}`,
        label,
        profile,
        target,
        client,
        channel,
      );
      clientErrorGuard.release();
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
      if (session) session.close("SSH connection setup failed");
      else {
        try { client.end(); } catch { /* best effort */ }
      }
      if (error instanceof SshError) throw error;
      throw new SshError("CONNECTION_FAILED", safeReason(error));
    } finally {
      this.pendingClients.delete(client);
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
    for (const client of this.pendingClients.keys()) {
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
      session.close("Disconnected SSH record pruned");
      this.sessions.delete(session.id);
    }
  }
}

export { hostFingerprint, matchesFingerprint } from "./connect";
