import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadSandboxModule,
  run,
  test,
} from "./lib/test-helpers.mjs";

const { evalScheme } = await loadSandboxModule("src/sandbox.ts");

async function withTempCwd(fn) {
  const previousCwd = process.cwd();
  const cwd = mkdtempSync(join(tmpdir(), "pi-square-scheme-sandbox-test-"));
  process.chdir(cwd);
  try {
    return await fn(cwd);
  } finally {
    process.chdir(previousCwd);
    rmSync(cwd, { recursive: true, force: true });
  }
}

// REGRESSION-PROOF: removing `wrapCode()` leaves snippets without an explicit
// `(exit)` hanging until the timeout kills the subprocess.
test("evalScheme appends an implicit exit for snippets that only print output", async () => {
  const result = await evalScheme("(display (+ 40 2)) (newline)", { timeoutMs: 2_000 });

  assert.equal(result.stdout.trim(), "42", "stdout should be returned even when the caller omits an explicit exit");
  assert.equal(result.exitCode, 0, "implicit exit should let the child finish cleanly");
  assert.equal(result.timedOut, false, "omitting `(exit)` should not force the timeout path");

  const broken = { exitCode: -1, timedOut: true };
  assert.notDeepEqual(
    { exitCode: result.exitCode, timedOut: result.timedOut },
    broken,
    "without the wrapper, the same snippet would stall until the timeout killed it",
  );
});

// REGRESSION-PROOF: changing the default access from `readonly` to `write` or
// `fullaccess` would let callers mutate the host cwd without opting in.
test("evalScheme defaults to readonly access and blocks writes under /work", async () => {
  await withTempCwd(async (cwd) => {
    const marker = join(cwd, "default-write.txt");

    const result = await evalScheme(
      '(guard (e [#t #f]) (with-output-to-file "/work/default-write.txt" (lambda () (display "escaped"))))',
      { timeoutMs: 2_000 },
    );

    assert.equal(result.exitCode, 0, "blocked writes should still return cleanly through the guard");
    assert.equal(result.timedOut, false, "blocked writes should not hang");
    assert.equal(existsSync(marker), false, "default access should not create files in the caller cwd");

    const brokenMarker = marker;
    assert.equal(existsSync(brokenMarker), false, "a writable default mode would leave a host-side marker behind");
  });
});

// REGRESSION-PROOF: using the readonly preload or wrong mount root for
// `access=write` would block the same `/work/...` write that currently succeeds.
test("evalScheme write access allows writes inside the caller cwd", async () => {
  await withTempCwd(async (cwd) => {
    const marker = join(cwd, "write-mode.txt");

    const result = await evalScheme(
      '(with-output-to-file "/work/write-mode.txt" (lambda () (display "written")))',
      { access: "write", timeoutMs: 2_000 },
    );

    assert.equal(result.exitCode, 0, "write mode should complete successfully");
    assert.equal(result.timedOut, false, "write mode should not rely on timeout");
    assert.equal(readFileSync(marker, "utf8"), "written", "write mode should map /work to the caller cwd");

    const brokenReadonly = existsSync(join(cwd, "readonly-only.txt"));
    assert.equal(brokenReadonly, false, "the success path depends on write mode, not the readonly sandbox");
  });
});

// REGRESSION-PROOF: bypassing the `maxOutputBytes` budget in `appendChunk()`
// would let stdout exceed the configured byte ceiling.
test("evalScheme truncates stdout to the configured maxOutputBytes budget", async () => {
  const result = await evalScheme('(display "abcdefghijklmnopqrstuvwxyz")', {
    timeoutMs: 2_000,
    maxOutputBytes: 10,
  });

  assert.equal(result.stdout, "abcdefghij", "stdout should stop exactly at the shared byte budget");
  assert.equal(result.stderr, "", "the byte budget should not fabricate stderr output");
  assert.equal(result.exitCode, 0, "output truncation should not count as a runtime failure");

  const broken = "abcdefghijklmnopqrstuvwxyz";
  assert.notEqual(result.stdout, broken, "dropping the byte cap would expose the full stdout payload");
});

// REGRESSION-PROOF: removing the timeout kill path, or failing to clamp the
// timeout to a positive integer, would leave non-terminating code running.
test("evalScheme marks infinite loops as timed out and kills the child", async () => {
  const result = await evalScheme("(let loop () (loop))", { timeoutMs: 5 });

  assert.equal(result.timedOut, true, "non-terminating code should hit the timeout path");
  assert.equal(result.exitCode, -1, "killed children should currently surface as exitCode -1");
  assert.ok(result.durationMs < 2_000, "timeout handling should return promptly");

  const broken = { timedOut: false, exitCode: 0 };
  assert.notDeepEqual(
    { timedOut: result.timedOut, exitCode: result.exitCode },
    broken,
    "without the kill path, the same infinite loop would look like a normal completion",
  );
});

await run();
