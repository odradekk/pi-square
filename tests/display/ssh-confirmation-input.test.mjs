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

function makeDef() {
  return {
    name: "ssh", label: "ssh", description: "ssh tool",
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
  state: "connected", commandState: "running", createdAt: Date.now(), lastActivityAt: Date.now(),
  oldestCursor: 0, newestCursor: 500,
};

// ═══════════════════════════════════════════════════════════════════

// ─── 1. Secret input call carries needs-input qualifier ────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef(), () => runtime);
  const args = { operation: "secret_input", session: "ssh-a1b2c3d4", prompt: "Enter deployment password" };
  const call = decorated.renderCall(args, plainTheme, makeCtx(args, {}, { argsComplete: true, executionStarted: true }));
  const comp = call.component;
  assert.ok(comp.description.qualifiers?.includes("needs-input"), "secret_input call has needs-input qualifier");
  // Secret prompt text never rendered
  const callText = stripVTControlCharacters(call.render(100).join("\n"));
  assert.doesNotMatch(callText, /deployment password/, "secret prompt text never rendered");
  assert.match(callText, /secure input requested/, "masked prompt indicator shown");
  runtime.dispose();
}

// ─── 2. Non-secret operations do not carry needs-input ─────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef(), () => runtime);
  for (const [label, args] of [
    ["connect", { operation: "connect", profile: "prod", target: "web1" }],
    ["command", { operation: "command", session: "ssh-a1b2c3d4", command: "ls" }],
    ["read", { operation: "read", session: "ssh-a1b2c3d4", cursor: 0 }],
    ["input", { operation: "input", session: "ssh-a1b2c3d4", data: "yes" }],
    ["interrupt", { operation: "interrupt", session: "ssh-a1b2c3d4" }],
    ["close", { operation: "close", session: "ssh-a1b2c3d4" }],
    ["list", { operation: "list" }],
  ]) {
    const call = decorated.renderCall(args, plainTheme, makeCtx(args, {}, { argsComplete: true, executionStarted: true }));
    const comp = call.component;
    assert.ok(!comp.description.qualifiers?.includes("needs-input"), `${label} call does not have needs-input qualifier`);
  }
  runtime.dispose();
}

// ─── 3. Connect declined renders aborted marker ────────────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef(), () => runtime);
  const args = { operation: "connect", profile: "prod", target: "alt-target" };
  const details = { version: 1, operation: "connect", status: "declined", code: "DECLINED", message: "SSH connection was declined" };
  const result = renderResult(decorated, args, details, "", { expanded: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.match(text, /^●/, "declined connect renders · (aborted marker)");
  assert.match(text, /declined/i, "declined message visible");
  assert.match(text, /sshCode=DECLINED/, "ssh code visible in summary");
  assert.doesNotMatch(text, /password|token|credential/i, "no credentials in declined display");

  runtime.dispose();
}

// ─── 4. Confirmation unavailable renders error ─────────────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef(), () => runtime);
  const args = { operation: "connect", profile: "prod", target: "alt-target" };
  const details = { version: 1, operation: "connect", status: "error", code: "CONFIRMATION_UNAVAILABLE", message: "Non-default SSH targets require interactive confirmation" };
  const result = renderResult(decorated, args, details, "Error: confirmation unavailable", { isError: true, expanded: true });
  const text = stripVTControlCharacters(result.render(80).join("\n"));
  assert.match(text, /^●/, "confirmation unavailable renders × (failed marker)");
  assert.match(text, /confirmation/i, "error message visible");
  assert.match(text, /sshCode=CONFIRMATION_UNAVAILABLE/, "ssh code visible");

  runtime.dispose();
}

// ─── 5. Host verification failure renders error with diagnostic ────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef(), () => runtime);
  const args = { operation: "connect", profile: "prod", target: "web1" };
  const details = { version: 1, operation: "connect", status: "error", code: "HOST_VERIFICATION_FAILED", message: "SSH host key verification failed: no matching fingerprint found" };
  const result = renderResult(decorated, args, details, "Error: host key verification failed", { isError: true, expanded: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.match(text, /^●/, "host verification failure renders ×");
  assert.match(text, /host key verification failed/i, "host verification message visible");
  assert.match(text, /sshCode=HOST_VERIFICATION_FAILED/, "host verification code visible");
  assert.doesNotMatch(text, /sha256:|BEGIN.*KEY|ssh-rsa|ssh-ed25519/i, "no fingerprint hash or key material in display");

  runtime.dispose();
}

// ─── 6. Auth failure renders error without key material ────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef(), () => runtime);
  const args = { operation: "connect", profile: "prod", target: "web1" };
  const details = { version: 1, operation: "connect", status: "error", code: "AUTH_FAILED", message: "All authentication methods failed (publickey)" };
  const result = renderResult(decorated, args, details, "Error: auth failed", { isError: true, expanded: true });
  const text = stripVTControlCharacters(result.render(80).join("\n"));
  assert.match(text, /^●/, "auth failure renders ×");
  assert.match(text, /authentication methods failed/i, "auth failure message visible");
  assert.doesNotMatch(text, /PRIVATE KEY|BEGIN.*KEY|ssh-rsa/i, "no private key material in display");

  runtime.dispose();
}

// ─── 7. Secret input success: no secret in any display surface ─────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef(), () => runtime);
  const args = { operation: "secret_input", session: "ssh-a1b2c3d4", prompt: "Enter password" };
  const details = { version: 1, operation: "secret_input", status: "success", code: "SECRET_SENT", message: "Secret input was sent once and was not included in tool content", session: SESSION };
  const result = renderResult(decorated, args, details, "", { expanded: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.match(text, /^●/, "secret input success renders ✓");
  assert.match(text, /sent once/, "send-once message visible");
  assert.doesNotMatch(text, /Enter password|my.?password|the.?secret|actual.?passphrase/i, "no secret value or prompt echoed in result display");
  // The prompt text from the call metadata should also not appear in the result
  assert.doesNotMatch(text, /Enter password/, "prompt text not echoed in result");

  runtime.dispose();
}

// ─── 8. Secret input declined renders aborted ──────────────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef(), () => runtime);
  const args = { operation: "secret_input", session: "ssh-a1b2c3d4", prompt: "Enter password" };
  const details = { version: 1, operation: "secret_input", status: "declined", code: "DECLINED", message: "Secret input was cancelled" };
  const result = renderResult(decorated, args, details, "", { expanded: true });
  const text = stripVTControlCharacters(result.render(80).join("\n"));
  assert.match(text, /^●/, "secret input declined renders · (aborted marker)");
  assert.match(text, /cancelled/i, "cancelled message visible");

  runtime.dispose();
}

// ─── 9. Secret input unavailable (no TUI) renders error ────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef(), () => runtime);
  const args = { operation: "secret_input", session: "ssh-a1b2c3d4", prompt: "Enter password" };
  const details = { version: 1, operation: "secret_input", status: "error", code: "SECRET_INPUT_UNAVAILABLE", message: "Secret SSH input requires the interactive TUI" };
  const result = renderResult(decorated, args, details, "Error: TUI required", { isError: true });
  const text = stripVTControlCharacters(result.render(80).join("\n"));
  assert.match(text, /^●/, "secret input unavailable renders ×");
  assert.match(text, /TUI/i, "TUI requirement message visible");

  runtime.dispose();
}

// ─── 10. Secret input with no active command renders error ─────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef(), () => runtime);
  const args = { operation: "secret_input", session: "ssh-a1b2c3d4", prompt: "Enter password" };
  const details = { version: 1, operation: "secret_input", status: "error", code: "NO_ACTIVE_COMMAND", message: "Secret SSH input requires a running foreground command" };
  const result = renderResult(decorated, args, details, "Error: no active command", { isError: true, expanded: true });
  const text = stripVTControlCharacters(result.render(80).join("\n"));
  assert.match(text, /^●/, "no active command renders ×");
  assert.match(text, /running foreground command/i, "error message visible");

  runtime.dispose();
}

// ─── 11. Connect success shows endpoint without credentials ────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef(), () => runtime);
  const args = { operation: "connect", profile: "prod", target: "web1" };
  const details = { version: 1, operation: "connect", status: "success", code: "CONNECTED", message: `Connected ssh-a1b2c3d4 to deploy@10.0.0.1:22`, session: { ...SESSION, commandState: "idle" } };
  const result = renderResult(decorated, args, details, "Welcome to Ubuntu\n$", { expanded: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.match(text, /^●/, "connect success renders ✓");
  assert.match(text, /endpoint=deploy@10\.0\.0\.1:22/, "endpoint visible");
  assert.doesNotMatch(text, /password|passphrase|private.key|BEGIN.*KEY/i, "no credentials in connect success");
  assert.doesNotMatch(text, /ghp_|github_pat_|Bearer\s/i, "no tokens in connect success");

  runtime.dispose();
}

// ─── 12. Non-secret input operation ────────────────────────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef(), () => runtime);
  const args = { operation: "input", session: "ssh-a1b2c3d4", data: "yes", newline: true };
  const call = decorated.renderCall(args, plainTheme, makeCtx(args, {}, { argsComplete: true, executionStarted: true }));
  const comp = call.component;
  assert.ok(!comp.description.qualifiers?.includes("needs-input"), "non-secret input does not have needs-input qualifier");

  const details = { version: 1, operation: "input", status: "success", code: "INPUT_SENT", message: "Non-secret input sent to the running remote command", session: SESSION };
  const result = renderResult(decorated, args, details, "", { expanded: true });
  const text = stripVTControlCharacters(result.render(80).join("\n"));
  assert.match(text, /^●/, "input success renders ✓");
  assert.match(text, /sent.*running/, "input sent message visible");

  runtime.dispose();
}

// ─── 13. Command aborted (interrupt sent) renders · ────────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef(), () => runtime);
  const args = { operation: "command", session: "ssh-a1b2c3d4", command: "sleep 60", waitMs: 10000 };
  const details = { version: 1, operation: "command", status: "aborted", code: "ABORTED", message: "Remote command wait was cancelled and an interrupt was sent", session: { ...SESSION, commandState: "idle" } };
  const result = renderResult(decorated, args, details, "^C", { isError: true, expanded: true });
  const text = stripVTControlCharacters(result.render(80).join("\n"));
  assert.match(text, /^●/, "aborted command renders · (not ·)");
  assert.match(text, /interrupt was sent/i, "abort message visible");

  runtime.dispose();
}

// ─── 14. Command disconnected renders × ───────────────────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef(), () => runtime);
  const args = { operation: "command", session: "ssh-a1b2c3d4", command: "long-task", waitMs: 10000 };
  const details = { version: 1, operation: "command", status: "error", code: "SESSION_DISCONNECTED", message: "SSH session disconnected before the command completed", session: { ...SESSION, state: "disconnected", disconnectReason: "Connection reset by peer" } };
  const result = renderResult(decorated, args, details, "partial output", { isError: true, expanded: true });
  const text = stripVTControlCharacters(result.render(100).join("\n"));
  assert.match(text, /^●/, "disconnected command renders × (not ×)");
  assert.match(text, /disconnectReason=Connection reset by peer/, "disconnect reason visible");

  runtime.dispose();
}

// ─── 15. No secret material leaks across all states ────────────────

{
  const runtime = newRuntime();
  const decorated = decorateInternalTool(makeDef(), () => runtime);
  const SECRET_PATTERNS = [
    /BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY/,
    /ssh-rsa\s+AAAA/,
    /ghp_[A-Za-z0-9_]+/,
    /github_pat_[A-Za-z0-9_]+/,
    /passphrase/i,
    /-----BEGIN PGP/,
  ];

  const states = [
    { args: { operation: "connect", profile: "prod", target: "web1" },
      details: { version: 1, operation: "connect", status: "success", code: "CONNECTED", message: "Connected", session: { ...SESSION, commandState: "idle" } },
      text: '{"output":"Welcome\\n$"}', expanded: true },
    { args: { operation: "connect", profile: "prod", target: "alt" },
      details: { version: 1, operation: "connect", status: "declined", code: "DECLINED", message: "Declined" },
      text: "", expanded: true },
    { args: { operation: "secret_input", session: "ssh-a1b2c3d4", prompt: "Enter password" },
      details: { version: 1, operation: "secret_input", status: "success", code: "SECRET_SENT", message: "Secret input was sent once", session: SESSION },
      text: "", expanded: true },
    { args: { operation: "connect", profile: "prod", target: "web1" },
      details: { version: 1, operation: "connect", status: "error", code: "HOST_VERIFICATION_FAILED", message: "Host key verification failed" },
      text: "", expanded: true, isError: true },
  ];

  for (const [index, state] of states.entries()) {
    const result = renderResult(decorated, state.args, state.details, state.text, { expanded: state.expanded, isError: state.isError ?? false });
    for (const width of [40, 80, 100]) {
      const text = stripVTControlCharacters(result.render(width).join("\n"));
      for (const pattern of SECRET_PATTERNS) {
        assert.doesNotMatch(text, pattern, `state ${index} at width ${width}: no secret material pattern ${pattern}`);
      }
    }
  }
  runtime.dispose();
}

// ─── 16. Collapsed/expanded bounds at all widths ───────────────────

{
  const runtime = newRuntime();
  for (const [args, details, text] of [
    [{ operation: "connect", profile: "prod", target: "alt-target-name" },
      { version: 1, operation: "connect", status: "declined", code: "DECLINED", message: "SSH connection was declined" },
      ""],
    [{ operation: "secret_input", session: "ssh-a1b2c3d4", prompt: "Enter deployment password for production database" },
      { version: 1, operation: "secret_input", status: "success", code: "SECRET_SENT", message: "Secret input was sent once and was not included in tool content", session: SESSION },
      ""],
    [{ operation: "connect", profile: "prod", target: "web1" },
      { version: 1, operation: "connect", status: "error", code: "HOST_VERIFICATION_FAILED", message: "SSH host key verification failed: no matching fingerprint found for host" },
      "Error: host verification failed"],
  ]) {
    const decorated = decorateInternalTool(makeDef(), () => runtime);
    for (const expanded of [false, true]) {
      const result = renderResult(decorated, args, details, text, { expanded, isError: details.status === "error" });
      for (const width of [39, 40, 63, 64, 80, 99, 100, 120]) {
        assert.ok(result.render(width).every((line) => visibleWidth(line) <= width), `ssh ${details.operation} ${expanded ? "expanded" : "collapsed"} bounded at ${width}`);
      }
    }
  }
  runtime.dispose();
}

// ─── 17. Execution unchanged ───────────────────────────────────────

{
  const runtime = newRuntime();
  const def = makeDef();
  const decorated = decorateInternalTool(def, () => runtime);
  assert.equal(decorated.execute, def.execute, "ssh execute unchanged");
  assert.deepEqual(decorated.parameters, def.parameters, "ssh parameters unchanged");
  runtime.dispose();
}

console.log("SSH confirmation and masked input display tests: OK");
