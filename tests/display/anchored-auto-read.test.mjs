import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jiti from "jiti";

const load = jiti(import.meta.url, { moduleCache: false });
const { registerAnchoredAutoRead } = await load("../../src/anchored-edit/auto-read.ts");
const { shutdownHashStore } = await load("../../src/anchored-edit/hash-store.ts");

const root = mkdtempSync(join(tmpdir(), "pi-square-anchored-auto-read-"));
const workspace = join(root, "workspace");
mkdirSync(workspace, { recursive: true });

try {
  const source = join(workspace, "source.txt");
  writeFileSync(source, "before\n", "utf8");
  const events = new Map();
  const pi = {
    on(name, handler) {
      const handlers = events.get(name) ?? [];
      handlers.push(handler);
      events.set(name, handlers);
    },
  };
  registerAnchoredAutoRead(
    pi,
    () => ({ anchoredEditing: { enabled: true, autoRead: true } }),
    () => true,
  );

  for (const handler of events.get("tool_call") ?? []) {
    await handler(
      { toolName: "write", toolCallId: "write-1", input: { path: "source.txt", content: "after\n" } },
      { cwd: workspace },
    );
  }
  writeFileSync(source, "after\n", "utf8");
  let result;
  for (const handler of events.get("tool_result") ?? []) {
    result = await handler(
      {
        toolName: "write",
        toolCallId: "write-1",
        input: { path: "source.txt", content: "after\n" },
        content: [{ type: "text", text: "Successfully wrote 6 bytes to source.txt" }],
        details: undefined,
        isError: false,
      },
      { cwd: workspace },
    );
  }
  assert.ok(result, "a changed write returns an augmented result");
  assert.equal(result.content.length, 2, "write summary and anchored block are both present");
  assert.match(result.content[1].text, /--- Auto-read \(hashline anchors\) ---/);
  assert.match(result.content[1].text, /^[A-Za-z0-9]{3}│after$/m);

  for (const handler of events.get("tool_call") ?? []) {
    await handler(
      { toolName: "write", toolCallId: "write-unchanged", input: { path: "source.txt", content: "after\n" } },
      { cwd: workspace },
    );
  }
  let unchanged;
  for (const handler of events.get("tool_result") ?? []) {
    unchanged = await handler(
      {
        toolName: "write",
        toolCallId: "write-unchanged",
        input: { path: "source.txt", content: "after\n" },
        content: [{ type: "text", text: "Successfully wrote 6 bytes to source.txt" }],
        details: undefined,
        isError: false,
      },
      { cwd: workspace },
    );
  }
  assert.equal(unchanged, undefined, "an unchanged write does not append anchors");

  const disabledEvents = new Map();
  registerAnchoredAutoRead(
    { on(name, handler) { disabledEvents.set(name, [...(disabledEvents.get(name) ?? []), handler]); } },
    () => ({ anchoredEditing: { enabled: true, autoRead: false } }),
    () => true,
  );
  for (const handler of disabledEvents.get("tool_call") ?? []) {
    await handler(
      { toolName: "write", toolCallId: "write-disabled", input: { path: "source.txt", content: "disabled\n" } },
      { cwd: workspace },
    );
  }
  writeFileSync(source, "disabled\n", "utf8");
  let disabled;
  for (const handler of disabledEvents.get("tool_result") ?? []) {
    disabled = await handler(
      {
        toolName: "write",
        toolCallId: "write-disabled",
        input: { path: "source.txt", content: "disabled\n" },
        content: [{ type: "text", text: "Successfully wrote 9 bytes to source.txt" }],
        details: undefined,
        isError: false,
      },
      { cwd: workspace },
    );
  }
  assert.equal(disabled, undefined, "disabled auto-read does not append anchors");

  const manyLines = Array.from({ length: 2_100 }, (_value, index) => `line-${index + 1}`).join("\n") + "\n";
  for (const handler of events.get("tool_call") ?? []) {
    await handler(
      { toolName: "write", toolCallId: "write-bounded", input: { path: "source.txt", content: manyLines } },
      { cwd: workspace },
    );
  }
  writeFileSync(source, manyLines, "utf8");
  let bounded;
  for (const handler of events.get("tool_result") ?? []) {
    bounded = await handler(
      {
        toolName: "write",
        toolCallId: "write-bounded",
        input: { path: "source.txt", content: manyLines },
        content: [{ type: "text", text: "Successfully wrote many bytes to source.txt" }],
        details: undefined,
        isError: false,
      },
      { cwd: workspace },
    );
  }
  const boundedText = bounded.content[1].text;
  assert.match(boundedText, /skipped/i, "bounded auto-read output shows skipped rows");
  assert.ok(boundedText.split("\n").length <= 2_010, "bounded auto-read output remains within its row budget");

  console.log("anchored auto-read integration tests: OK");
} finally {
  shutdownHashStore();
  rmSync(root, { recursive: true, force: true });
}
