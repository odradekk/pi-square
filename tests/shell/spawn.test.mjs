import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import jiti from "jiti";

const root = mkdtempSync(join(tmpdir(), "pi-square-pwsh-spawn-"));
const executable = join(root, "fake-pwsh");
const marker = join(root, "descendant-ran");
writeFileSync(executable, `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const encoded = process.argv.at(-1) || "";
const command = Buffer.from(encoded, "base64").toString("utf16le");
if (command.includes("STREAM_TEST")) {
  process.stdout.write("out-one\\n");
  setTimeout(() => process.stderr.write("err-two\\n"), 25);
  setTimeout(() => process.stdout.write("中😀three\\n"), 50);
  setTimeout(() => process.exit(0), 75);
} else if (command.includes("HANG_CHILD")) {
  spawn(process.execPath, ["-e", ${JSON.stringify(`setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran"), 500); setInterval(() => {}, 1000);`)}], { stdio: "ignore" });
  setInterval(() => {}, 1000);
} else if (command.includes("SHOULD_NOT_RUN")) {
  writeFileSync(${JSON.stringify(marker)}, "spawned");
} else {
  process.stdout.write(command.split("\\n").at(-1));
}
`, "utf8");
chmodSync(executable, 0o755);

const load = jiti(import.meta.url, { moduleCache: false });
const { runPwsh } = await load(resolve(import.meta.dirname, "..", "..", "src", "shell", "spawn.ts"));
const binary = { name: executable, flavor: "pwsh", version: "test" };
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

try {
  {
    const chunks = [];
    const result = await runPwsh({
      command: "STREAM_TEST",
      binary,
      timeoutMs: 2000,
      onData(chunk, stream) { chunks.push({ stream, text: chunk.toString("utf8") }); },
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.timedOut, false);
    assert.equal(result.aborted, false);
    assert.deepEqual(chunks.map(({ stream }) => stream), ["stdout", "stderr", "stdout"]);
    assert.equal(chunks.map(({ text }) => text).join(""), "out-one\nerr-two\n中😀three\n");
  }

  {
    const chunks = [];
    await runPwsh({
      command: "Write-Output '编码😀'",
      binary,
      timeoutMs: 2000,
      onData(chunk) { chunks.push(chunk); },
    });
    assert.equal(Buffer.concat(chunks).toString("utf8"), "Write-Output '编码😀'");
  }

  {
    const controller = new AbortController();
    controller.abort();
    const result = await runPwsh({
      command: "SHOULD_NOT_RUN",
      binary,
      timeoutMs: 2000,
      signal: controller.signal,
    });
    assert.equal(result.aborted, true);
    assert.equal(existsSync(marker), false);
  }

  {
    const result = await runPwsh({ command: "HANG_CHILD", binary, timeoutMs: 100 });
    assert.equal(result.timedOut, true);
    assert.equal(result.aborted, false);
    await sleep(650);
    assert.equal(existsSync(marker), false, "timeout must kill descendants in the process group");
  }

  {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const result = await runPwsh({
      command: "HANG_CHILD",
      binary,
      timeoutMs: 2000,
      signal: controller.signal,
    });
    assert.equal(result.aborted, true);
    assert.equal(result.timedOut, false);
    await sleep(650);
    assert.equal(existsSync(marker), false, "abort must kill descendants in the process group");
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("pwsh process runner tests: OK");
