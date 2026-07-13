import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import jiti from "jiti";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, "..", "..", "..");

const load = jiti(import.meta.url, { moduleCache: false });
const tests = [];

export async function loadModule(relativePath) {
  return load(join(packageRoot, relativePath));
}

export function test(name, fn) {
  tests.push({ name, fn });
}

export async function run() {
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`PASS: ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`FAIL: ${name} — ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  console.log(`\n${tests.length} tests, ${failed} failed`);
  if (failed > 0) process.exit(1);
}
