import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadModule, run, test } from "./lib/test-helpers.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, "..", "..");

test("resolveBundledBinary maps linux-x64 to bundled rg", async () => {
  const { resolveBundledBinary } = await loadModule("src/search/binary.ts");
  assert.equal(
    resolveBundledBinary("rg", "linux", "x64", packageRoot),
    join(packageRoot, "bin", "linux-x64", "rg"),
  );
});

test("resolveBundledBinary maps linux-arm64 to bundled fd", async () => {
  const { resolveBundledBinary } = await loadModule("src/search/binary.ts");
  assert.equal(
    resolveBundledBinary("fd", "linux", "arm64", packageRoot),
    join(packageRoot, "bin", "linux-arm64", "fd"),
  );
});

test("resolveBundledBinary maps darwin-x64 to bundled rg", async () => {
  const { resolveBundledBinary } = await loadModule("src/search/binary.ts");
  assert.equal(
    resolveBundledBinary("rg", "darwin", "x64", packageRoot),
    join(packageRoot, "bin", "darwin-x64", "rg"),
  );
});

test("resolveBundledBinary maps darwin-arm64 to bundled fd", async () => {
  const { resolveBundledBinary } = await loadModule("src/search/binary.ts");
  assert.equal(
    resolveBundledBinary("fd", "darwin", "arm64", packageRoot),
    join(packageRoot, "bin", "darwin-arm64", "fd"),
  );
});

test("resolveBundledBinary maps win32-x64 to bundled rg.exe", async () => {
  const { resolveBundledBinary } = await loadModule("src/search/binary.ts");
  assert.equal(
    resolveBundledBinary("rg", "win32", "x64", packageRoot),
    join(packageRoot, "bin", "win32-x64", "rg.exe"),
  );
});

test("resolveBundledBinary maps win32-arm64 to bundled fd.exe", async () => {
  const { resolveBundledBinary } = await loadModule("src/search/binary.ts");
  assert.equal(
    resolveBundledBinary("fd", "win32", "arm64", packageRoot),
    join(packageRoot, "bin", "win32-arm64", "fd.exe"),
  );
});

test("resolveBundledBinary always returns absolute paths", async () => {
  const { resolveBundledBinary } = await loadModule("src/search/binary.ts");
  for (const [plat, arch] of [["linux", "x64"], ["darwin", "arm64"], ["win32", "x64"]]) {
    const p = resolveBundledBinary("rg", plat, arch, packageRoot);
    assert.ok(isAbsolute(p), `path for ${plat}-${arch} must be absolute`);
  }
});

test("resolveBundledBinary adds .exe suffix only for win32 targets", async () => {
  const { resolveBundledBinary } = await loadModule("src/search/binary.ts");
  for (const arch of ["x64", "arm64"]) {
    assert.ok(
      resolveBundledBinary("rg", "win32", arch, packageRoot).endsWith(".exe"),
      `win32-${arch} rg must end with .exe`,
    );
  }
  for (const [plat, arch] of [["linux", "x64"], ["darwin", "arm64"]]) {
    assert.ok(
      !resolveBundledBinary("rg", plat, arch, packageRoot).endsWith(".exe"),
      `${plat}-${arch} rg must not end with .exe`,
    );
  }
});

test("resolveBundledBinary throws for unsupported platform/arch", async () => {
  const { resolveBundledBinary } = await loadModule("src/search/binary.ts");
  assert.throws(
    () => resolveBundledBinary("rg", "solaris", "x64", packageRoot),
    /unsupported|invalid|unknown/i,
  );
});

test("resolveBundledBinary throws when the binary file does not exist", async () => {
  const { resolveBundledBinary } = await loadModule("src/search/binary.ts");
  const tmp = mkdtempSync(join(tmpdir(), "pi-square-bin-test-"));
  try {
    assert.throws(
      () => resolveBundledBinary("rg", "linux", "x64", tmp),
      /not found|missing|ENOENT|does not exist/i,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("resolveBundledBinary never falls back to PATH", async () => {
  const { resolveBundledBinary } = await loadModule("src/search/binary.ts");
  const tmp = mkdtempSync(join(tmpdir(), "pi-square-bin-test-"));
  try {
    assert.throws(
      () => resolveBundledBinary("rg", "linux", "x64", tmp),
      "must throw when bundled binary is absent, not fall back to PATH",
    );
    const real = resolveBundledBinary("rg", "linux", "x64", packageRoot);
    assert.ok(real.includes("bin"), "must resolve into bin/, not a bare command");
    assert.notEqual(real, "rg");
    assert.notEqual(real, "fd");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

await run();
