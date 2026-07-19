import assert from "node:assert/strict";
import jiti from "jiti";

const load = jiti(import.meta.url, { moduleCache: false });
const { createSshToolController } = await load("../../src/ssh/tool.ts");

const profile = {
  name: "ops",
  defaultTarget: "primary",
  targets: [
    { name: "primary", host: "one.test", port: 22, username: "deploy", fingerprints: ["SHA256:AAAAAAAAAAAAAAAAAAAAAA"] },
    { name: "alternate", host: "two.test", port: 2222, username: "ops", fingerprints: ["SHA256:BBBBBBBBBBBBBBBBBBBBBB"] },
  ],
  auth: { method: "agent", socket: "fake" },
  maxSessions: 3,
  idleTimeoutMinutes: 30,
  connectTimeoutMs: 1_000,
  keepaliveIntervalMs: 1_000,
  keepaliveCountMax: 2,
};

class FakeSession {
  constructor(id, target = profile.targets[0]) {
    this.id = id;
    this.profile = profile;
    this.target = target;
    this.isRunning = true;
    this.inputs = [];
    this.interrupts = 0;
    this.listeners = new Set();
    this.commandOutput = undefined;
  }

  summary() {
    return {
      id: this.id,
      profile: profile.name,
      target: this.target.name,
      endpoint: `${this.target.username}@${this.target.host}:${this.target.port}`,
      state: "connected",
      commandState: this.isRunning ? "running" : "idle",
      createdAt: 1,
      lastActivityAt: 2,
      oldestCursor: 0,
      newestCursor: 3,
    };
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async command(command) {
    this.lastCommand = command;
    const text = this.commandOutput ?? "ok\n";
    if (this.commandOutput !== undefined) {
      this.readText = text;
      for (const listener of this.listeners) listener();
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    this.isRunning = false;
    return {
      state: "completed",
      exitCode: 0,
      page: { text, requestedCursor: 3, cursor: 3, nextCursor: 3 + text.length, oldestCursor: 0, newestCursor: 3 + text.length, cursorExpired: false, hasMore: false, droppedChars: 0 },
    };
  }
  async read(cursor = 0) {
    const text = this.readText ?? "";
    return {
      state: this.isRunning ? "running" : "idle",
      page: { text, requestedCursor: cursor, cursor, nextCursor: cursor + text.length, oldestCursor: 0, newestCursor: cursor + text.length, cursorExpired: false, hasMore: false, droppedChars: 0 },
    };
  }
  input(data, newline) { this.inputs.push({ data: Buffer.isBuffer(data) ? Buffer.from(data) : data, newline }); }
  interrupt() { this.interrupts += 1; }
}

class FakeManager {
  constructor() {
    this.sessions = new Map();
    this.connectCalls = [];
  }
  profiles() { return [profile]; }
  list() { return [...this.sessions.values()].map((session) => session.summary()); }
  resolve(profileName, targetName) {
    assert.equal(profileName, "ops");
    return { profile, target: profile.targets.find((target) => target.name === (targetName ?? profile.defaultTarget)) };
  }
  async connect(profileName, targetName, label) {
    this.connectCalls.push({ profileName, targetName, label });
    const session = new FakeSession(`ssh-${this.connectCalls.length}`, profile.targets.find((target) => target.name === targetName));
    this.sessions.set(session.id, session);
    return session;
  }
  get(id) {
    const session = this.sessions.get(id);
    if (!session) throw new Error("missing session");
    return session;
  }
  close(id) {
    const summary = { ...this.get(id).summary(), state: "closed", commandState: "disconnected" };
    this.sessions.delete(id);
    return summary;
  }
}

function parse(result) { return JSON.parse(result.content[0].text); }

const manager = new FakeManager();
const controller = createSshToolController(manager);
const tool = controller.definition;
assert.equal(tool.parameters.type, "object");
assert.equal(tool.parameters.anyOf, undefined);
assert.deepEqual(tool.parameters.required, ["operation"]);
assert.deepEqual(tool.parameters.properties.operation.enum, ["connect", "command", "read", "input", "secret_input", "interrupt", "close", "list"]);
assert.equal(tool.parameters.additionalProperties, false);

let confirmations = [];
const ui = {
  async confirm(title, message) {
    confirmations.push({ title, message });
    return true;
  },
  async custom(factory) {
    let completed;
    const tui = { requestRender() {} };
    const theme = { fg(_color, text) { return text; }, bold(text) { return text; } };
    const keybindings = { matches() { return false; } };
    const component = await factory(tui, theme, keybindings, (value) => { completed = value; });
    component.handleInput("top-secret");
    assert.doesNotMatch(component.render(80).join("\n"), /top-secret/);
    component.handleInput("\n");
    component.dispose?.();
    return completed;
  },
};
const ctx = { hasUI: true, mode: "tui", ui };

let response = await tool.execute("1", { operation: "list" }, undefined, undefined, ctx);
assert.equal(response.isError, undefined);
assert.equal(parse(response).profiles[0].name, "ops");
assert.equal(Object.hasOwn(parse(response).profiles[0], "confirmCommands"), false);
assert.equal(JSON.stringify(parse(response)), JSON.stringify(parse(response)).replace(/SHA256:[^"}]+/g, ""), "list must not expose pinned fingerprints");

response = await tool.execute("2", { operation: "connect", profile: "ops", target: "alternate", label: "deploy" }, undefined, undefined, ctx);
assert.equal(parse(response).code, "CONNECTED");
assert.equal(confirmations.length, 1);
assert.match(confirmations[0].message, /ops@two\.test:2222/);
const sessionId = parse(response).session.id;

await tool.execute("3", { operation: "connect", profile: "ops", target: "alternate" }, undefined, undefined, ctx);
assert.equal(confirmations.length, 1, "an identical alternate endpoint is approved once per parent session");

response = await tool.execute("4", { operation: "command", session: sessionId, command: "pwd" }, undefined, undefined, ctx);
assert.equal(parse(response).code, "COMMAND_COMPLETED");
assert.equal(parse(response).output, "ok\n");
assert.equal(confirmations.length, 1, "remote commands must not request confirmation");

const progressOutput = "progress 0%\r\u001b[2Kprogress 50%\r\u001b[2Kprogress 100%\ncomplete\n";
const streamingSession = manager.get(sessionId);
streamingSession.isRunning = true;
streamingSession.commandOutput = progressOutput;
const updates = [];
response = await tool.execute(
  "4-progress",
  { operation: "command", session: sessionId, command: "install package" },
  undefined,
  (update) => updates.push(parse(update)),
  ctx,
);
assert.equal(parse(response).output, "progress 100%\ncomplete\n");
assert.ok(updates.length > 0, "a running command must publish a throttled update");
assert.equal(updates.at(-1).output, "progress 100%\ncomplete\n", "live and final output must share terminal projection semantics");
streamingSession.commandOutput = undefined;

ui.confirm = async () => { throw new Error("remote commands must bypass confirmation"); };
response = await tool.execute("5", { operation: "command", session: sessionId, command: "rm file" }, undefined, undefined, ctx);
assert.equal(parse(response).code, "COMMAND_COMPLETED");

const session = manager.get(sessionId);
session.isRunning = true;
response = await tool.execute("6", { operation: "secret_input", session: sessionId, prompt: "sudo password" }, undefined, undefined, ctx);
const secretBody = response.content[0].text;
assert.equal(parse(response).code, "SECRET_SENT", secretBody);
assert.doesNotMatch(secretBody, /top-secret/);
assert.equal(session.inputs[0].data.toString("utf8"), "top-secret");
assert.equal(session.inputs[0].newline, true);

session.readText = "safe\u0000\u001b]8;;https://attacker.test\u0007link\u001b]8;;\u0007";
response = await tool.execute("7", { operation: "read", session: sessionId }, undefined, undefined, ctx);
assert.doesNotMatch(response.content[0].text, /attacker\.test|\\u0000/, "remote controls must not survive in model content");
assert.match(parse(response).output, /safelink/);
session.readText = progressOutput;
response = await tool.execute("7-progress", { operation: "read", session: sessionId }, undefined, undefined, ctx);
assert.equal(parse(response).output, "progress 100%\ncomplete\n", "read results must collapse overwritten progress states");
response = await tool.execute("8", { operation: "input", session: sessionId, data: "yes" }, undefined, undefined, ctx);
assert.equal(parse(response).code, "INPUT_SENT");
response = await tool.execute("9", { operation: "interrupt", session: sessionId }, undefined, undefined, ctx);
assert.equal(session.interrupts, 1);
response = await tool.execute("10", { operation: "close", session: sessionId }, undefined, undefined, ctx);
assert.equal(parse(response).code, "CLOSED");

response = await tool.execute("11", { operation: "list", session: "unexpected" }, undefined, undefined, ctx);
assert.equal(response.isError, true);
assert.equal(parse(response).code, "INVALID_ARGUMENT");

const noTuiSession = new FakeSession("ssh-no-tui");
manager.sessions.set(noTuiSession.id, noTuiSession);
response = await tool.execute("12", { operation: "secret_input", session: noTuiSession.id }, undefined, undefined, { hasUI: true, mode: "rpc", ui });
assert.equal(parse(response).code, "SECRET_INPUT_UNAVAILABLE");
controller.resetApprovals();

const concurrentManager = new FakeManager();
const concurrentTool = createSshToolController(concurrentManager).definition;
let resolveConfirmation;
let concurrentConfirmations = 0;
const concurrentCtx = {
  hasUI: true,
  mode: "tui",
  ui: {
    async confirm() {
      concurrentConfirmations += 1;
      return await new Promise((resolve) => { resolveConfirmation = resolve; });
    },
  },
};
const firstConnect = concurrentTool.execute("concurrent-1", { operation: "connect", profile: "ops", target: "alternate" }, undefined, undefined, concurrentCtx);
const secondConnect = concurrentTool.execute("concurrent-2", { operation: "connect", profile: "ops", target: "alternate" }, undefined, undefined, concurrentCtx);
assert.equal(concurrentConfirmations, 1, "only one confirmation may be active");
resolveConfirmation(true);
const connected = await Promise.all([firstConnect, secondConnect]);
assert.deepEqual(connected.map((result) => parse(result).code), ["CONNECTED", "CONNECTED"]);
assert.equal(concurrentConfirmations, 1, "an approved endpoint must be rechecked after leaving the confirmation queue");

concurrentCtx.ui.confirm = async () => { throw new Error("remote commands must bypass confirmation"); };
const commandResults = await Promise.all(connected.map((result, index) => concurrentTool.execute(
  `concurrent-command-${index}`,
  { operation: "command", session: parse(result).session.id, command: `printf ${index}` },
  undefined,
  undefined,
  concurrentCtx,
)));
assert.deepEqual(commandResults.map((result) => parse(result).code), ["COMMAND_COMPLETED", "COMMAND_COMPLETED"]);

const largeProfiles = Array.from({ length: 64 }, (_, profileIndex) => ({
  ...profile,
  name: `profile-${profileIndex}`,
  defaultTarget: "target-0",
  targets: Array.from({ length: 32 }, (_, targetIndex) => ({
    name: `target-${targetIndex}`,
    host: `${"h".repeat(220)}${targetIndex}`,
    port: 22,
    username: "u".repeat(100),
    fingerprints: ["SHA256:AAAAAAAAAAAAAAAAAAAAAA"],
  })),
}));
const largeSessions = Array.from({ length: 80 }, (_, index) => ({
  id: `ssh-large-${index}`,
  profile: "profile-0",
  target: "target-0",
  endpoint: `${"u".repeat(100)}@${"h".repeat(220)}:22`,
  state: index % 2 === 0 ? "connected" : "disconnected",
  commandState: index % 3 === 0 ? "running" : "idle",
  createdAt: index,
  lastActivityAt: index,
  oldestCursor: 0,
  newestCursor: 0,
  disconnectReason: "x".repeat(500),
}));
const boundedTool = createSshToolController({ profiles: () => largeProfiles, list: () => largeSessions }).definition;
response = await boundedTool.execute("13", { operation: "list" }, undefined, undefined, {});
assert.ok(response.content[0].text.length <= 64_000);
assert.ok(parse(response).omissions.profiles + parse(response).omissions.targets + parse(response).omissions.sessions > 0);

console.log("ssh tool tests: OK");
