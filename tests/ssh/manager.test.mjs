import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import jiti from "jiti";

const load = jiti(import.meta.url, { moduleCache: false });
const { hostFingerprint, matchesFingerprint, SshSessionManager } = await load("../../src/ssh/manager.ts");

class FakeChannel extends EventEmitter {
  constructor() {
    super();
    this.stderr = new EventEmitter();
    this.writes = [];
    this.pendingMarker = undefined;
    this.signals = [];
  }

  write(data) {
    const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
    this.writes.push(text);
    const marker = text.match(/(__PI_SSH_[a-f0-9]+__:)/)?.[1];
    if (!marker) return true;
    const command = text.split("\n", 1)[0];
    if (command === "hold") {
      this.pendingMarker = marker;
      setImmediate(() => this.emit("data", "waiting for input: "));
      return true;
    }
    if (command === "split") {
      const boundary = marker.length - 5;
      setImmediate(() => {
        this.emit("data", `split-output\r\n${marker.slice(0, boundary)}`);
        setImmediate(() => this.emit("data", `${marker.slice(boundary)}0\r\n`));
      });
      return true;
    }
    if (command === "unicode") {
      const bytes = Buffer.from(`café🙂\r\n${marker}0\r\n`, "utf8");
      const emoji = bytes.indexOf(Buffer.from("🙂"));
      setImmediate(() => {
        this.emit("data", bytes.subarray(0, emoji + 2));
        setImmediate(() => this.emit("data", bytes.subarray(emoji + 2)));
      });
      return true;
    }
    const output = command.includes("PROMPT_COMMAND") ? "" : `out:${command}\r\n`;
    setImmediate(() => this.emit("data", `${output}\r\n${marker}0\r\n`));
    return true;
  }

  complete(exitCode = 0, output = "done") {
    assert.ok(this.pendingMarker);
    const marker = this.pendingMarker;
    this.pendingMarker = undefined;
    this.emit("data", `${output}\r\n${marker}${exitCode}\r\n`);
  }

  signal(name) { this.signals.push(name); }
  end() { this.emit("close"); }
}

class FakeClient extends EventEmitter {
  constructor() {
    super();
    this.channel = new FakeChannel();
    this.endCalls = 0;
  }

  connect(config) {
    this.config = config;
    setImmediate(() => this.emit("ready"));
  }

  shell(_window, callback) { setImmediate(() => callback(undefined, this.channel)); }
  end() {
    this.endCalls += 1;
    this.emit("close");
  }
  destroy() { this.emit("close"); }
}

const hostKey = Buffer.from("host-key-material");
const fingerprint = hostFingerprint(hostKey);
assert.match(fingerprint, /^SHA256:/);
assert.equal(matchesFingerprint(fingerprint, [fingerprint]), true);
assert.equal(matchesFingerprint(fingerprint, ["SHA256:AAAAAAAAAAAAAAAAAAAAAA"]), false);

function config(overrides = {}) {
  return {
    maxSessions: overrides.maxSessions ?? 2,
    profiles: [{
      name: "ops",
      defaultTarget: "primary",
      targets: [{ name: "primary", host: "host.test", port: 22, username: "deploy", fingerprints: [fingerprint] }],
      auth: { method: "agent", socket: "fake-agent" },
      maxSessions: overrides.profileMax ?? 2,
      idleTimeoutMinutes: 30,
      connectTimeoutMs: 1_000,
      keepaliveIntervalMs: 1_000,
      keepaliveCountMax: 2,
    }],
  };
}

class DoubleErrorClient extends FakeClient {
  connect(config) {
    this.config = config;
    setImmediate(() => this.emit("error", new Error("read ECONNRESET")));
  }

  end() {
    this.endCalls += 1;
    setImmediate(() => {
      this.emit("error", new Error("Connection lost before handshake"));
      this.emit("close");
    });
  }
}

const doubleErrorClients = [];
const doubleErrorManager = new SshSessionManager(() => {
  const client = new DoubleErrorClient();
  doubleErrorClients.push(client);
  return client;
});
doubleErrorManager.configure(config());
await assert.rejects(
  () => doubleErrorManager.connect("ops", undefined, undefined, async () => undefined),
  /read ECONNRESET/,
);
await new Promise((resolve) => setImmediate(() => setImmediate(resolve)));
assert.equal(doubleErrorClients[0].endCalls, 1);
assert.equal(doubleErrorClients[0].listenerCount("error"), 0, "failed clients must release the handshake error guard after close");
doubleErrorManager.dispose();

const clients = [];
const manager = new SshSessionManager(() => {
  const client = new FakeClient();
  clients.push(client);
  return client;
});
manager.configure(config());
const session = await manager.connect("ops", undefined, "primary shell", async () => undefined);
assert.equal(session.summary().state, "connected");
assert.equal(session.summary().label, "primary shell");
assert.equal(clients[0].config.host, "host.test");
assert.equal(clients[0].config.agent, "fake-agent");
assert.equal(clients[0].config.agentForward, false);
assert.equal(clients[0].config.hostVerifier(hostKey), true);
assert.equal(clients[0].config.hostVerifier(Buffer.from("wrong")), false);
assert.equal(clients[0].listenerCount("error"), 1, "the connected session must own the only client error listener");
assert.equal(clients[0].listenerCount("close"), 1, "handshake listeners must be removed after ownership transfer");

let command = await session.command("pwd", 100);
assert.equal(command.state, "completed");
assert.equal(command.exitCode, 0);
assert.match(command.page.text, /out:pwd/);
command = await session.command("split", 100);
assert.equal(command.state, "completed");
assert.match(command.page.text, /split-output/);
assert.doesNotMatch(command.page.text, /__PI_SSH_/, "completion markers must never reach model output");
command = await session.command("unicode", 100);
assert.equal(command.state, "completed");
assert.match(command.page.text, /café🙂/);
assert.doesNotMatch(command.page.text, /�/, "split UTF-8 chunks must decode without replacement characters");
assert.equal(clients[0].channel.writes.filter((value) => value.includes("__PI_SSH_")).length, 4, "bootstrap and commands must reuse one channel");

command = await session.command("hold", 1);
assert.equal(command.state, "running");
assert.equal(session.summary().commandState, "running");
assert.rejects(() => session.command("second", 1), /already has a running foreground command/);
session.input("yes", true);
assert.deepEqual(clients[0].channel.writes.slice(-2), ["yes", "\n"]);
session.interrupt();
assert.deepEqual(clients[0].channel.signals, ["INT"]);
clients[0].channel.complete(7, "finished");
const read = await session.read(command.page.nextCursor, 50);
assert.match(read.page.text, /finished/);
assert.equal(session.summary().commandState, "idle");

clients[0].channel.emit("close");
assert.equal(session.summary().state, "disconnected");
assert.equal(clients[0].endCalls, 1, "a closed shell channel must release its SSH transport");
await assert.rejects(() => session.command("pwd", 1), /disconnected/);
manager.close(session.id);
assert.equal(clients[0].endCalls, 1, "closing a disconnected session must not end its transport twice");
assert.equal(manager.list().length, 0);

const limitedClients = [];
const limited = new SshSessionManager(() => {
  const client = new FakeClient();
  limitedClients.push(client);
  return client;
});
limited.configure(config({ maxSessions: 1, profileMax: 1 }));
const only = await limited.connect("ops", undefined, undefined, async () => undefined);
await assert.rejects(() => limited.connect("ops", undefined, undefined, async () => undefined), /session limit/);
only.lastActivityAt = 0;
assert.deepEqual(limited.sweepIdle(31 * 60_000), [only.id]);
assert.equal(limited.list().length, 0);
limited.dispose();

class SlowShellClient extends FakeClient {
  shell() {}
}
const stalled = new SshSessionManager(() => new SlowShellClient());
stalled.configure(config());
const abortController = new AbortController();
const stalledConnect = stalled.connect("ops", undefined, undefined, async () => undefined, abortController.signal);
setTimeout(() => abortController.abort(), 5);
await assert.rejects(stalledConnect, /cancelled/);
stalled.dispose();
manager.dispose();

console.log("ssh manager tests: OK");
