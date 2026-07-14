import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadModule, run, test } from "./lib/test-helpers.mjs";

// Helper: build a node -e snippet that writes to stdout.
function nodeOut(code) {
  return ["node", ["-e", code]];
}

test("runCommand captures normal stdout and reports ok status", async () => {
  const { runCommand } = await loadModule("src/search/runner.ts");
  const [cmd, args] = nodeOut("process.stdout.write('hello world')");
  const result = await runCommand(cmd, args, {});
  assert.equal(result.status, "ok");
  assert.equal(result.stdout.toString(), "hello world");
});

test("runCommand applies cwd and can stream without retaining stdout", async () => {
  const { runCommand } = await loadModule("src/search/runner.ts");
  const chunks = [];
  const result = await runCommand("node", ["-e", "process.stdout.write(process.cwd())"], {
    cwd: tmpdir(),
    captureStdout: false,
    onChunk: (chunk) => chunks.push(chunk),
  });
  assert.equal(result.status, "ok");
  assert.equal(result.stdout.length, 0);
  assert.equal(Buffer.concat(chunks).toString(), tmpdir());
});

test("runCommand applies an explicit environment and streams stderr", async () => {
  const { runCommand } = await loadModule("src/search/runner.ts");
  const stderr = [];
  const result = await runCommand(process.execPath, ["-e", "process.stdout.write(process.env.PI_RUNNER_TEST || '');process.stderr.write('progress')"], {
    env: { ...process.env, PI_RUNNER_TEST: "isolated" },
    onStderrChunk: (chunk) => stderr.push(chunk),
  });
  assert.equal(result.stdout.toString(), "isolated");
  assert.equal(Buffer.concat(stderr).toString(), "progress");
});

test("runCommand reports non-zero exit code", async () => {
  const { runCommand } = await loadModule("src/search/runner.ts");
  const [cmd, args] = nodeOut("process.exit(3)");
  const result = await runCommand(cmd, args, {});
  assert.equal(result.status, "non-zero");
  assert.equal(result.exitCode, 3);
});

test("runCommand detects abort via AbortSignal", async () => {
  const { runCommand } = await loadModule("src/search/runner.ts");
  const controller = new AbortController();
  const promise = runCommand("node", ["-e", "setInterval(()=>{},500)"], {
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 50);
  const result = await promise;
  assert.equal(result.status, "aborted");
});

test("runCommand abort kills a spawned process tree", async () => {
  const { runCommand } = await loadModule("src/search/runner.ts");
  const root = mkdtempSync(join(tmpdir(), "pi-process-tree-"));
  const pidFile = join(root, "child.pid");
  const parentCode = `const {spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid));setInterval(()=>{},1000);`;
  const controller = new AbortController();
  try {
    const promise = runCommand(process.execPath, ["-e", parentCode], {
      signal: controller.signal,
      killTree: true,
      timeout: 5000,
    });
    const deadline = Date.now() + 3000;
    while (!existsSync(pidFile) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(existsSync(pidFile), "grandchild pid must be recorded");
    const grandchildPid = Number(readFileSync(pidFile, "utf8"));
    controller.abort();
    const result = await promise;
    assert.equal(result.status, "aborted");
    await new Promise((resolve) => setTimeout(resolve, process.platform === "win32" ? 500 : 100));
    assert.throws(() => process.kill(grandchildPid, 0), "grandchild must not survive process-tree cancellation");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runCommand enforces injected timeout", async () => {
  const { runCommand } = await loadModule("src/search/runner.ts");
  const result = await runCommand("node", ["-e", "setInterval(()=>{},500)"], {
    timeout: 80,
  });
  assert.equal(result.status, "timeout");
});

test("runCommand intentional stop via onChunk return true", async () => {
  const { runCommand } = await loadModule("src/search/runner.ts");
  let calls = 0;
  const result = await runCommand(
    "node",
    ["-e", "let i=0;setInterval(()=>{process.stdout.write('line '+(++i)+'\\n');},10)"],
    {
      onChunk: () => {
        calls += 1;
        return true;
      },
    },
  );
  assert.equal(result.status, "stopped");
  assert.ok(calls >= 1, "onChunk must fire at least once before stop");
});

test("runCommand truncates stderr to injected 8 KiB cap", async () => {
  const { runCommand } = await loadModule("src/search/runner.ts");
  const long = "x".repeat(20 * 1024);
  const result = await runCommand(
    "node",
    ["-e", `process.stderr.write('${long}')`],
    { stderrCap: 8 * 1024 },
  );
  assert.ok(result.stderr.length <= 8 * 1024, "stderr must be at most 8 KiB");
  assert.equal(result.stderrTruncated, true);
});

test("runCommand rejects stdout exceeding injected small cap", async () => {
  const { runCommand } = await loadModule("src/search/runner.ts");
  const result = await runCommand(
    "node",
    ["-e", "process.stdout.write(Buffer.alloc(500, 97))"],
    { stdoutCap: 100 },
  );
  assert.equal(result.status, "stdout-cap");
});

test("runCommand detects cap on a single oversized unterminated chunk", async () => {
  const { runCommand } = await loadModule("src/search/runner.ts");
  const result = await runCommand(
    "node",
    ["-e", "process.stdout.write(Buffer.alloc(300, 120))"],
    { stdoutCap: 100 },
  );
  assert.equal(result.status, "stdout-cap");
});

test("runCommand does not leak listeners across repeated calls", async () => {
  const { runCommand } = await loadModule("src/search/runner.ts");
  let leaked = false;
  const onWarning = (w) => {
    if (w?.name === "MaxListenersExceededWarning") leaked = true;
  };
  process.on("warning", onWarning);
  try {
    for (let i = 0; i < 25; i++) {
      await runCommand("node", ["-e", "process.stdout.write('x')"], { timeout: 5000 });
    }
  } finally {
    process.off("warning", onWarning);
  }
  assert.equal(leaked, false, "no MaxListenersExceededWarning after 25 sequential calls");
});

test("runCommand rejects with onChunk callback error and kills the child", async () => {
  const { runCommand } = await loadModule("src/search/runner.ts");
  let calls = 0;
  const sentinel = new Error("sentinel-callback-error");
  const promise = runCommand(
    "node",
    ["-e", "let i=0;setInterval(()=>{process.stdout.write('x'.repeat(100)+(++i)+'\\n');},5)"],
    {
      onChunk: () => {
        calls += 1;
        throw sentinel;
      },
    },
  );
  await assert.rejects(
    promise,
    (err) => err === sentinel,
    "runCommand must reject with the exact sentinel error",
  );
  assert.equal(calls, 1, "onChunk must fire exactly once before the child is killed");
});

await run();
