import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createReadToolDefinition } from "@earendil-works/pi-coding-agent";
import jiti from "jiti";

const load = jiti(import.meta.url, { moduleCache: false });
const { DEFAULT_CONFIG } = await load("../../src/core/config.ts");
const { DisplayRuntime } = await load("../../src/display/runtime.ts");
const { decorateBuiltinDefinition } = await load("../../src/display/builtins.ts");

const workspace = mkdtempSync(join(tmpdir(), "pi-square-read-transform-"));
const sourcePath = join(workspace, "source.txt");
writeFileSync(sourcePath, "first\nsecond\nthird\nfourth");

try {
  const runtime = new DisplayRuntime(DEFAULT_CONFIG, { environment: { isTTY: false, test: true } });
  const factory = createReadToolDefinition(workspace);
  const args = { path: "source.txt", limit: 2 };
  const expectedText = "first\nsecond\n\n[2 more lines in file. Use offset=3 to continue.]";

  const original = await factory.execute("original", args, undefined, undefined, undefined);
  const identity = decorateBuiltinDefinition(factory, workspace, runtime, (content) => content);
  const identityResult = await identity.execute("identity", args, undefined, undefined, undefined);
  assert.deepEqual(identityResult.content, original.content, "identity transform preserves model content");
  assert.equal(identityResult.content[0].text, expectedText, "factory paging text remains byte-identical");

  const transformed = decorateBuiltinDefinition(factory, workspace, runtime, (content) => content.map((part) => (
    part.type === "text" ? { ...part, text: `${part.text}\n[owner transform]` } : part
  )));
  const transformedResult = await transformed.execute("transformed", args, undefined, undefined, undefined);
  assert.equal(
    transformedResult.content[0].text,
    `${expectedText}\n[owner transform]`,
    "read model content transforms exactly once after factory execution",
  );

  runtime.dispose();
  console.log("display read content transform tests: OK");
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
