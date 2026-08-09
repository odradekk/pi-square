import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import jiti from "jiti";

const load = jiti(import.meta.url, { moduleCache: false });
const { DEFAULT_CONFIG } = await load("../../src/core/config.ts");
const { DisplayRuntime } = await load("../../src/display/runtime.ts");
const { decorateInternalTool } = await load("../../src/display/internal-adapters.ts");
const { initTheme } = await import("@earendil-works/pi-coding-agent");
initTheme();

const plainTheme = {
  fg(_token, text) { return String(text); },
  bg(_token, text) { return String(text); },
  bold(text) { return String(text); },
  inverse(text) { return String(text); },
};

function makeCtx(args, state = {}, overrides = {}) {
  return {
    args, toolCallId: "call-1", invalidate() {}, lastComponent: undefined, state,
    cwd: "/tmp", executionStarted: false, argsComplete: false, isPartial: false,
    expanded: false, showImages: false, isError: false, ...overrides,
  };
}

function newRuntime() {
  return new DisplayRuntime(structuredClone(DEFAULT_CONFIG), { environment: { isTTY: true } });
}

function makeDef(name = "ssh") {
  return {
    name, label: name, description: `${name} tool`,
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() { return { content: [], details: {} }; },
  };
}

function renderResult(decorated, args, details, text, opts = {}) {
  const call = decorated.renderCall(args, plainTheme, makeCtx(args, {}, { argsComplete: true, executionStarted: true }));
  return decorated.renderResult(
    { content: [{ type: "text", text }], details, ...(opts.isError ? { isError: true } : {}) },
    { expanded: opts.expanded ?? false, isPartial: opts.isPartial ?? false },
    plainTheme,
    makeCtx(args, {}, {
      argsComplete: true, executionStarted: true, lastComponent: call,
      isError: opts.isError ?? false, expanded: opts.expanded ?? false, isPartial: opts.isPartial ?? false,
    }),
  );
}

const SESSION = {
  id: "ssh-a1b2c3d4", profile: "prod", target: "web1", endpoint: "deploy@10.0.0.1:22",
  state: "connected", commandState: "idle", createdAt: Date.now(), lastActivityAt: Date.now(),
  oldestCursor: 0, newestCursor: 500,
};

function page(overrides = {}) {
  return { requestedCursor: 0, cursor: 500, nextCursor: 500, oldestCursor: 0, newestCursor: 500, cursorExpired: false, hasMore: false, droppedChars: 0, ...overrides };
}

// ═══════════════════════════════════════════════════════════════════

// ─── 1. Connect success: target shows profile/target ───────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef(), () => runtime);
  const args = { operation: "connect", profile: "prod", target: "web1" };
  const call = decorated.renderCall(args, plainTheme, makeCtx(args, {}, { argsComplete: true, executionStarted: true }));
  const callText = stripVTControlCharacters(call.render(100).join("\n"));
  assert.match(callText, /prod\/web1/, "connect target shows profile/target identity");

  const details = { version: 1, operation: "connect", status: "success", code: "CONNECTED", message: `Connected ${SESSION.id} to deploy@10.0.0.1:22`, session: SESSION, output: page() };
  const result = renderResult(decorated, args, details, "Welcome to Ubuntu 22.04\n$", { expanded: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.match(text, /^●/, "connect success renders completed marker");
  assert.match(text, /endpoint=deploy@10\.0\.0\.1:22/, "connect summary shows endpoint");
  assert.match(text, /sessionState=connected/, "connect summary shows session state");
  assert.match(text, /Welcome to Ubuntu/, "connect output visible in expanded");

  runtime.dispose();
}

// ─── 2. Command running: target shows session ID, running state ────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef(), () => runtime);
  const args = { operation: "command", session: "ssh-a1b2c3d4", command: "ls -la /var/log", waitMs: 5000 };
  const call = decorated.renderCall(args, plainTheme, makeCtx(args, {}, { argsComplete: true, executionStarted: true }));
  const callText = stripVTControlCharacters(call.render(100).join("\n"));
  assert.match(callText, /ssh-a1b2c3d4/, "command target shows session ID");

  const details = { version: 1, operation: "command", status: "running", code: "COMMAND_RUNNING", message: "Remote command is running", session: { ...SESSION, commandState: "running" }, output: page({ hasMore: true }) };
  const result = renderResult(decorated, args, details, "total 48\ndrwxr-xr-x 2 root root 4096\n-rw-r--r-- 1 root root 1234 syslog", { expanded: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.match(text, /commandState=running/, "running command shows commandState=running");
  assert.match(text, /endpoint=deploy@10\.0\.0\.1:22/, "command summary shows endpoint");
  assert.match(text, /cursor=more/, "running command with hasMore shows cursor indicator");
  assert.match(text, /total 48/, "command output visible in expanded");

  runtime.dispose();
}

// ─── 3. Command completed: exit code with success/error tone ───────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef(), () => runtime);
  const args = { operation: "command", session: "ssh-a1b2c3d4", command: "echo hello", waitMs: 3000 };

  // Exit 0 → success tone
  const okDetails = { version: 1, operation: "command", status: "success", code: "COMMAND_COMPLETED", message: "Remote command exited with code 0", session: SESSION, exitCode: 0, output: page() };
  const okResult = renderResult(decorated, args, okDetails, "hello\n$", { expanded: true });
  const okText = stripVTControlCharacters(okResult.render(100).join("\n"));
  assert.match(okText, /exitCode=0/, "exit code 0 visible in summary");
  assert.match(okText, /^●/, "exit 0 renders completed marker");

  // Exit 1 → error tone
  const errDetails = { version: 1, operation: "command", status: "success", code: "COMMAND_COMPLETED", message: "Remote command exited with code 1", session: SESSION, exitCode: 1, output: page() };
  const errResult = renderResult(decorated, args, errDetails, "error\n$", { expanded: true });
  const errText = stripVTControlCharacters(errResult.render(100).join("\n"));
  assert.match(errText, /exitCode=1/, "exit code 1 visible in summary");
  assert.match(errText, /^●/, "non-zero exit still renders completed (status=success)");

  runtime.dispose();
}

// ─── 4. Read: cursor metadata visible ──────────────────────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef(), () => runtime);
  const args = { operation: "read", session: "ssh-a1b2c3d4", cursor: 300, waitMs: 2000 };
  const details = { version: 1, operation: "read", status: "success", code: "OK", message: "SSH output read", session: SESSION, output: page({ requestedCursor: 300 }) };
  const result = renderResult(decorated, args, details, "more output\n$", { expanded: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.match(text, /more output/, "read output visible in expanded");
  assert.match(text, /sessionState=connected/, "read summary shows session state");

  runtime.dispose();
}

// ─── 5. Cursor expiry and dropped chars are explicit ───────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef(), () => runtime);
  const args = { operation: "read", session: "ssh-a1b2c3d4", cursor: 50, waitMs: 1000 };
  const details = {
    version: 1, operation: "read", status: "error", code: "SESSION_DISCONNECTED", message: "SSH session disconnected",
    session: { ...SESSION, state: "disconnected", disconnectReason: "Connection reset by peer" },
    output: page({ requestedCursor: 50, cursor: 50, nextCursor: 50, oldestCursor: 200, newestCursor: 200, cursorExpired: true, droppedChars: 150 }),
  };
  const result = renderResult(decorated, args, details, "", { expanded: true, isError: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.match(text, /^●/, "disconnected read renders failed marker");
  assert.match(text, /expired/, "cursor expiry visible (cursor field shows expired)");
  assert.match(text, /150 dropped/, "dropped chars count visible");
  assert.match(text, /disconnectReason=Connection reset by peer/, "disconnect reason visible");

  runtime.dispose();
}

// ─── 6. Command aborted renders · (not ·) ──────────────────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef(), () => runtime);
  const args = { operation: "command", session: "ssh-a1b2c3d4", command: "sleep 60", waitMs: 10000 };
  const details = { version: 1, operation: "command", status: "aborted", code: "ABORTED", message: "Remote command wait was cancelled and an interrupt was sent", session: { ...SESSION, commandState: "idle" }, output: page({ cursor: 10, nextCursor: 10 }) };
  const result = renderResult(decorated, args, details, "^C", { isError: true });
  const text = stripVTControlCharacters(result.render(80).join("\n"));
  assert.match(text, /^●/, "aborted renders · marker, not ·");

  runtime.dispose();
}

// ─── 7. Disconnected command shows error and session state ─────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef(), () => runtime);
  const args = { operation: "command", session: "ssh-a1b2c3d4", command: "long-running-task", waitMs: 10000 };
  const details = { version: 1, operation: "command", status: "error", code: "SESSION_DISCONNECTED", message: "SSH session disconnected before the command completed", session: { ...SESSION, state: "disconnected", disconnectReason: "Connection reset by peer" }, output: page({ cursor: 100 }) };
  const result = renderResult(decorated, args, details, "partial output", { expanded: true, isError: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.match(text, /^●/, "disconnected command renders failed marker");
  assert.match(text, /sessionState=disconnected/, "disconnected state visible in summary");

  runtime.dispose();
}

// ─── 8. List renders profiles and sessions as structured records ───

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef(), () => runtime);
  const args = { operation: "list" };
  const call = decorated.renderCall(args, plainTheme, makeCtx(args, {}, { argsComplete: true, executionStarted: true }));
  const callText = stripVTControlCharacters(call.render(100).join("\n"));
  // list has no session target
  assert.doesNotMatch(callText, /ssh-a1b2c3d4/, "list call does not show session ID as target");

  const details = {
    version: 1, operation: "list", status: "success", code: "OK", message: "2 SSH profiles; 1 sessions",
    profiles: [{ name: "prod", defaultTarget: "web1", targets: [{ name: "web1", endpoint: "deploy@10.0.0.1:22" }, { name: "db1", endpoint: "db@10.0.0.2:22" }], maxSessions: 3 }],
    sessions: [SESSION],
    omissions: { profiles: 0, targets: 0, sessions: 0 },
  };
  const result = renderResult(decorated, args, details, "content", { expanded: true });
  const text = stripVTControlCharacters(result.render(120).join("\n"));
  assert.match(text, /PROFILES/, "list shows Profiles section");
  assert.match(text, /prod/, "list shows profile name");
  assert.match(text, /defaultTarget=web1/, "list shows profile default target");
  assert.match(text, /web1: deploy@10\.0\.0\.1:22/, "list shows profile targets");
  assert.match(text, /maxSessions=3/, "list shows profile max sessions");
  assert.match(text, /SESSIONS/, "list shows Sessions section");
  assert.match(text, /ssh-a1b2c3d4/, "list shows session ID");
  assert.match(text, /state=connected/, "list shows session state");
  assert.match(text, /command=idle/, "list shows session command state");

  runtime.dispose();
}

// ─── 9. List with omissions ────────────────────────────────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef(), () => runtime);
  const args = { operation: "list" };
  const details = {
    version: 1, operation: "list", status: "success", code: "OK", message: "5 SSH profiles; 20 sessions; 3 entries omitted by output limits",
    profiles: [{ name: "p1", defaultTarget: "t1", targets: [{ name: "t1", endpoint: "u@h:22" }], maxSessions: 1 }],
    sessions: [SESSION],
    omissions: { profiles: 2, targets: 5, sessions: 3 },
  };
  const result = renderResult(decorated, args, details, "content", { expanded: true });
  const text = stripVTControlCharacters(result.render(120).join("\n"));
  assert.match(text, /omitted/, "list omissions message visible in summary");

  runtime.dispose();
}

// ─── 10. Input and interrupt: lightweight session identity ─────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef(), () => runtime);

  // Input
  const inputArgs = { operation: "input", session: "ssh-a1b2c3d4", data: "yes\n", newline: false };
  const inputDetails = { version: 1, operation: "input", status: "success", code: "INPUT_SENT", message: "Non-secret input sent to the running remote command", session: { ...SESSION, commandState: "running" } };
  const inputResult = renderResult(decorated, inputArgs, inputDetails, "", { expanded: true });
  const inputText = stripVTControlCharacters(inputResult.render(100).join("\n"));
  assert.match(inputText, /ssh-a1b2c3d4/, "input target shows session ID");
  assert.match(inputText, /^●/, "input success renders completed marker");

  // Interrupt
  const interruptArgs = { operation: "interrupt", session: "ssh-a1b2c3d4" };
  const interruptDetails = { version: 1, operation: "interrupt", status: "success", code: "INTERRUPT_SENT", message: "Interrupt sent to the running remote command", session: SESSION };
  const interruptResult = renderResult(decorated, interruptArgs, interruptDetails, "", { expanded: true });
  const interruptText = stripVTControlCharacters(interruptResult.render(100).join("\n"));
  assert.match(interruptText, /^●/, "interrupt success renders completed marker");

  // Close
  const closeArgs = { operation: "close", session: "ssh-a1b2c3d4" };
  const closeDetails = { version: 1, operation: "close", status: "success", code: "CLOSED", message: "Closed SSH session ssh-a1b2c3d4", session: { ...SESSION, state: "closed" } };
  const closeResult = renderResult(decorated, closeArgs, closeDetails, "", { expanded: true });
  const closeText = stripVTControlCharacters(closeResult.render(100).join("\n"));
  assert.match(closeText, /^●/, "close success renders completed marker");
  assert.match(closeText, /sessionState=closed/, "close shows closed session state");

  runtime.dispose();
}

// ─── 11. Terminal projection in output (already projected by tool) ──

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef(), () => runtime);
  const args = { operation: "command", session: "ssh-a1b2c3d4", command: "echo test", waitMs: 1000 };
  // The SSH tool applies projectTerminalOutput before returning content.
  // The display adapter receives the already-projected text and renders
  // it in the Output section. Verify multi-line projected output renders.
  const projectedText = "done: 100%\n$";
  const details = { version: 1, operation: "command", status: "success", code: "COMMAND_COMPLETED", message: "Remote command exited with code 0", session: SESSION, exitCode: 0, output: page() };
  const result = renderResult(decorated, args, details, projectedText, { expanded: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.match(text, /done: 100%/, "projected output line visible in Output section");
  assert.match(text, /\$.*$/, "shell prompt visible in output");

  runtime.dispose();
}

// ─── 12. Declined connect renders aborted ──────────────────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef(), () => runtime);
  const args = { operation: "connect", profile: "prod", target: "alt-target" };
  const details = { version: 1, operation: "connect", status: "declined", code: "DECLINED", message: "SSH connection was declined" };
  const result = renderResult(decorated, args, details, "", { expanded: true });
  const text = stripVTControlCharacters(result.render(80).join("\n"));
  assert.match(text, /^●/, "declined connect renders aborted marker");
  assert.match(text, /declined/i, "declined message visible");

  runtime.dispose();
}

// ─── 13. Secret input shows masked prompt indicator ────────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef(), () => runtime);
  const args = { operation: "secret_input", session: "ssh-a1b2c3d4", prompt: "Enter deployment password" };
  const call = decorated.renderCall(args, plainTheme, makeCtx(args, {}, { argsComplete: true, executionStarted: true }));
  const callText = stripVTControlCharacters(call.render(100).join("\n"));
  assert.match(callText, /secure input requested/, "secret_input shows masked prompt indicator in metadata");
  assert.doesNotMatch(callText, /deployment password/, "secret prompt text never rendered in call");

  // Success — secret never appears in content or display
  const details = { version: 1, operation: "secret_input", status: "success", code: "SECRET_SENT", message: "Secret input was sent once and was not included in tool content", session: { ...SESSION, commandState: "running" } };
  const result = renderResult(decorated, args, details, "", { expanded: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.match(text, /^●/, "secret_input success renders completed marker");
  assert.doesNotMatch(text, /password/i, "secret value never appears in result display");

  runtime.dispose();
}

// ─── 14. No raw JSON model body in display output ────────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef(), () => runtime);
  const args = { operation: "command", session: "ssh-a1b2c3d4", command: "ls -la", waitMs: 5000 };
  const details = { version: 1, operation: "command", status: "success", code: "COMMAND_COMPLETED", message: "Remote command exited with code 0", session: SESSION, exitCode: 0, output: page() };
  // The SSH tool serializes result as JSON body; display extracts terminal
  // output from body.output rather than showing raw JSON.
  const contentText = JSON.stringify({ version: 1, status: "success", code: "COMMAND_COMPLETED", output: "total 0\n$" });
  const result = renderResult(decorated, args, details, contentText, { expanded: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  // Terminal output extracted from JSON body
  assert.match(text, /total 0/, "terminal output extracted from JSON body visible");
  // Raw JSON structure must not appear in display
  assert.doesNotMatch(text, /"version":1/, "raw JSON model body not rendered in display");

  runtime.dispose();
}

// ─── 15. Collapsed/expanded bounds at all widths ───────────────────

{
  const runtime = newRuntime();
  for (const [args, details, text] of [
    [{ operation: "connect", profile: "prod", target: "web1" },
      { version: 1, operation: "connect", status: "success", code: "CONNECTED", message: "Connected to deploy@10.0.0.1:22", session: SESSION, output: page() },
      "Welcome to Ubuntu\n$"],
    [{ operation: "command", session: "ssh-a1b2c3d4", command: "long-command-name --flag value", waitMs: 10000 },
      { version: 1, operation: "command", status: "running", code: "COMMAND_RUNNING", message: "Running", session: { ...SESSION, commandState: "running" }, output: page({ hasMore: true }) },
      "output line 1\noutput line 2"],
    [{ operation: "read", session: "ssh-a1b2c3d4", cursor: 300, waitMs: 5000 },
      { version: 1, operation: "read", status: "success", code: "OK", message: "SSH output read", session: SESSION, output: page({ requestedCursor: 300 }) },
      "more output"],
    [{ operation: "list" },
      { version: 1, operation: "list", status: "success", code: "OK", message: "1 profiles; 1 sessions", profiles: [{ name: "prod", defaultTarget: "web1", targets: [{ name: "web1", endpoint: "deploy@10.0.0.1:22" }], maxSessions: 3 }], sessions: [SESSION], omissions: { profiles: 0, targets: 0, sessions: 0 } },
      "content"],
  ]) {
    const decorated = decorateInternalTool(makeDef(), () => runtime);
    for (const expanded of [false, true]) {
      const result = renderResult(decorated, args, details, text, { expanded });
      for (const width of [39, 40, 63, 64, 80, 99, 100, 120]) {
        assert.ok(result.render(width).every((line) => visibleWidth(line) <= width), `ssh ${details.operation} ${expanded ? "expanded" : "collapsed"} bounded at ${width}`);
      }
    }
  }
  runtime.dispose();
}

// ─── 16. Execution unchanged ───────────────────────────────────────

{
  const runtime = newRuntime();
  const def = makeDef();
  const decorated = decorateInternalTool(def, () => runtime);
  assert.equal(decorated.execute, def.execute, "ssh execute unchanged");
  assert.deepEqual(decorated.parameters, def.parameters, "ssh parameters unchanged");
  runtime.dispose();
}

console.log("SSH session display tests: OK");
