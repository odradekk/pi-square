import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import jiti from "jiti";

const packageRoot = resolve(import.meta.dirname, "..", "..");
const load = jiti(import.meta.url, { moduleCache: false });
const { createCodeGraphDefinition } = await load(join(packageRoot, "src", "codegraph", "index.ts"));
const root = mkdtempSync(join(tmpdir(), "pi-codegraph-eval-"));
const src = join(root, "src");
mkdirSync(src);

const files = {
  "src/api.ts": "import { getOrder } from './service.js';\nexport function handleOrder(id: string) { return getOrder(id); }\n",
  "src/service.ts": "import { loadOrder } from './repository.js';\nexport function getOrder(id: string) { return loadOrder(id); }\n",
  "src/repository.ts": "export function loadOrder(id: string) { return { id, status: 'open' }; }\n",
};
for (const [path, content] of Object.entries(files)) writeFileSync(join(root, path), content);
writeFileSync(join(root, "package.json"), JSON.stringify({ name: "codegraph-eval", private: true, type: "module" }));

const ctx = { cwd: root, hasUI: true, ui: { confirm: async () => true } };
const expectedPaths = Object.keys(files);
const expectedSymbols = ["handleOrder", "getOrder", "loadOrder"];

function accuracy(text) {
  const checks = [...expectedPaths, ...expectedSymbols];
  return {
    matched: checks.filter((value) => text.includes(value)).length,
    total: checks.length,
  };
}

try {
  const codegraph = createCodeGraphDefinition(true);
  const initialized = await codegraph.execute("eval:init", { operation: "init" }, undefined, undefined, ctx);
  if (initialized.details.phase !== "done") throw new Error(initialized.content[0].text);

  const codegraphStart = performance.now();
  const graphResult = await codegraph.execute(
    "eval:explore",
    { operation: "explore", query: "How does handleOrder reach the repository?", maxFiles: 5 },
    undefined,
    undefined,
    ctx,
  );
  const codegraphElapsedMs = performance.now() - codegraphStart;
  if (graphResult.details.phase !== "done") throw new Error(graphResult.content[0].text);

  console.log(JSON.stringify({
    version: 1,
    note: "Non-blocking deterministic retrieval comparison; this is not a model-quality benchmark.",
    question: "How does handleOrder reach the repository?",
    codegraph: {
      toolCalls: 1,
      elapsedMs: Math.round(codegraphElapsedMs),
      referenceAccuracy: accuracy(graphResult.content[0].text),
      outputChars: graphResult.content[0].text.length,
    },
  }, null, 2));
} finally {
  rmSync(root, { recursive: true, force: true });
}
