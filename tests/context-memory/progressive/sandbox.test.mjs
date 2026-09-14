import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSandbox, SandboxError } from "./sandbox.mjs";

const root = mkdtempSync(join(tmpdir(), "progressive-sandbox-"));
const workspace = join(root, "arm-a");
const otherArm = join(root, "arm-b");
const hidden = join(root, "hidden-tests");
mkdirSync(workspace);
mkdirSync(otherArm);
mkdirSync(hidden);
writeFileSync(join(otherArm, "future-flag"), "OTHER-ARM-SECRET\n");
writeFileSync(join(hidden, "expected"), "HIDDEN-EXPECTED-SECRET\n");
writeFileSync(join(root, "host-secret"), "HOST-SESSION-SECRET\n");
symlinkSync(join(root, "host-secret"), join(workspace, "escape"));
writeFileSync(join(workspace, "malicious.mjs"), `
  import { readFileSync, writeFileSync } from "node:fs";
  const targets = ${JSON.stringify([join(root, "host-secret"), join(otherArm, "future-flag"), join(hidden, "expected"), "/workspace/escape"])};
  for (const target of targets) {
    try { console.log(readFileSync(target, "utf8")); } catch { console.log("DENIED"); }
  }
  writeFileSync("project-output", "tested project ran inside sandbox\\n");
`);

const previousSecret = process.env.PROGRESSIVE_COORDINATOR_SECRET;
process.env.PROGRESSIVE_COORDINATOR_SECRET = "ENVIRONMENT-SECRET";
try {
  const sandbox = createSandbox({ workspace, maxOutputBytes: 64 * 1024 });

  const basic = await sandbox.run("node --version; pwd; printf '%s' \"$PROGRESSIVE_COORDINATOR_SECRET\"; cat /proc/1/environ | tr '\\0' '\\n'; printf 'fds='; ls /proc/self/fd | wc -l", { input: "unused" });
  assert.equal(basic.exitCode, 0);
  assert.match(basic.stdout, /^v24\./);
  assert.match(basic.stdout, /\/workspace/);
  assert.doesNotMatch(basic.stdout, /ENVIRONMENT-SECRET|PROGRESSIVE_COORDINATOR_SECRET/);
  assert.match(basic.stdout, /fds=[0-4]\n$/, "only standard streams and the directory scan descriptor are visible");

  const denied = await sandbox.run(`for p in ${JSON.stringify(join(root, "host-secret"))} ${JSON.stringify(join(otherArm, "future-flag"))} ${JSON.stringify(join(hidden, "expected"))}; do cat "$p" 2>/dev/null || printf 'DENIED\\n'; done; cat escape 2>/dev/null || printf 'DENIED\\n'`);
  assert.equal(denied.stdout, "DENIED\nDENIED\nDENIED\nDENIED\n");
  assert.doesNotMatch(denied.stdout + denied.stderr, /SECRET/);
  const hiddenWrite = await sandbox.run(`printf forged > ${JSON.stringify(join(hidden, "replacement"))}`);
  assert.notEqual(hiddenWrite.exitCode, 0, "model code cannot modify hidden verification files");

  const network = await sandbox.run("node -e 'const n=require(\"node:net\").connect(80,\"1.1.1.1\"); n.on(\"connect\",()=>process.exit(0)); n.on(\"error\",()=>process.exit(9))'");
  assert.equal(network.exitCode, 9, "the network namespace has no external route");

  const project = await sandbox.run("node malicious.mjs");
  assert.equal(project.exitCode, 0);
  assert.equal(project.stdout, "DENIED\nDENIED\nDENIED\nDENIED\n");
  assert.equal(readFileSync(join(workspace, "project-output"), "utf8"), "tested project ran inside sandbox\n");

  const forged = await sandbox.run("printf 'PASS\\n'; exit 23");
  assert.equal(forged.stdout, "PASS\n", "sandbox transports arbitrary output without treating it as verification");
  assert.equal(forged.exitCode, 23, "trusted callers retain the real process status");

  const controller = new AbortController();
  const pending = sandbox.run("(sleep 1; printf escaped > late-marker) & wait", { signal: controller.signal });
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(pending, (error) => error?.name === "AbortError");
  await new Promise((resolve) => setTimeout(resolve, 1_150));
  assert.throws(() => readFileSync(join(workspace, "late-marker")), /ENOENT/, "abort kills sandbox descendants");

  await assert.rejects(sandbox.run("yes X"), (error) => error instanceof SandboxError && error.code === "OUTPUT_LIMIT");
  sandbox.dispose();
  await assert.rejects(sandbox.run("true"), (error) => error instanceof SandboxError && error.code === "SANDBOX_DISPOSED");

  console.log("context-memory progressive sandbox: all assertions passed");
} finally {
  if (previousSecret === undefined) delete process.env.PROGRESSIVE_COORDINATOR_SECRET;
  else process.env.PROGRESSIVE_COORDINATOR_SECRET = previousSecret;
  rmSync(root, { recursive: true, force: true });
}
