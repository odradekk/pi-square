import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import jiti from "jiti";

const load = jiti(import.meta.url, { moduleCache: false });
const { registerAnchoredAutoRead } = await load("../../src/anchored-edit/auto-read.ts");
const { transformAnchoredReadContent } = await load("../../src/anchored-edit/read-transform.ts");
const { shutdownHashStore } = await load("../../src/anchored-edit/hash-store.ts");

const root = mkdtempSync(join(tmpdir(), "pi-square-anchored-auto-read-"));
const workspace = join(root, "workspace");
mkdirSync(workspace, { recursive: true });

const sessionDir = join(workspace, ".test-session");
const storePath = join(sessionDir, "anchored-edit", "hash-store.sqlite");
const sessionCtx = {
  cwd: workspace,
  sessionManager: {
    getSessionDir: () => sessionDir,
    getSessionId: () => "test-session",
    getSessionFile: () => undefined,
  },
};

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
      sessionCtx,
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
      sessionCtx,
    );
  }
  assert.ok(result, "a changed write returns an augmented result");
  assert.equal(result.content.length, 2, "write summary and anchored block are both present");
  assert.match(result.content[1].text, /--- Auto-read \(hashline anchors\) ---/);
  assert.match(result.content[1].text, /^[A-Za-z0-9]{3}│after$/m);

  for (const handler of events.get("tool_call") ?? []) {
    await handler(
      { toolName: "write", toolCallId: "write-unchanged", input: { path: "source.txt", content: "after\n" } },
      sessionCtx,
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
      sessionCtx,
    );
  }
  assert.equal(unchanged, undefined, "an unchanged write does not append anchors");

  // ── Native path authority (#185): a parent write to an external path
  // clears served state for that canonical file in the initiating workspace
  // and, when the content changed, appends fresh anchors. Failed writes keep
  // native result behavior.
  const external = join(root, "outside-auto.txt");
  writeFileSync(external, "before\n", "utf8");
  const seededExternal = await transformAnchoredReadContent(
    [{ type: "text", text: "factory content" }],
    { path: "../outside-auto.txt" },
    workspace,
    "parent",
    { confineToWorkspace: false, sessionDir },
  );
  {
    const store = new DatabaseSync(storePath, { timeout: 500 });
    try {
      const row = store.prepare("SELECT hashes FROM served WHERE path = ?").get(realpathSync(external));
      assert.ok(row, "the pre-write external read seeds a served row");
      assert.equal(JSON.parse(row.hashes).length, 1, "the seeded row carries the single pre-write anchor");
    } finally {
      store.close();
    }
  }
  for (const handler of events.get("tool_call") ?? []) {
    await handler(
      { toolName: "write", toolCallId: "write-external", input: { path: "../outside-auto.txt", content: "after\n" } },
      sessionCtx,
    );
  }
  writeFileSync(external, "after\n", "utf8");
  let externalResult;
  for (const handler of events.get("tool_result") ?? []) {
    externalResult = await handler(
      {
        toolName: "write",
        toolCallId: "write-external",
        input: { path: "../outside-auto.txt", content: "after\n" },
        content: [{ type: "text", text: "Successfully wrote 6 bytes to ../outside-auto.txt" }],
        details: undefined,
        isError: false,
      },
      sessionCtx,
    );
  }
  assert.ok(externalResult, "a changed external write returns an augmented result");
  assert.match(externalResult.content[1].text, /--- Auto-read \(hashline anchors\) ---/);
  assert.match(externalResult.content[1].text, /^[A-Za-z0-9]{3}│after$/m, "an external write appends fresh anchors");
  {
    // With autoRead on, the write clears the pre-write served row and then
    // records the post-write anchors, so the row reflects the new content:
    // the pre-write anchor is gone and the fresh one is served.
    const store = new DatabaseSync(storePath, { timeout: 500 });
    try {
      const row = store.prepare("SELECT hashes FROM served WHERE path = ?").get(realpathSync(external));
      assert.ok(row, "the external served row exists after the write");
      const servedHashes = new Set(JSON.parse(row.hashes));
      const seededAnchor = /([A-Za-z0-9]{3})│before/.exec(
        seededExternal.map((part) => part.type === "text" ? part.text : "").join(""),
      )?.[1];
      const freshAnchor = /([A-Za-z0-9]{3})│after/.exec(
        externalResult.content[1].text,
      )?.[1];
      assert.ok(seededAnchor && freshAnchor, "both pre-write and post-write anchors are identified");
      assert.equal(servedHashes.has(seededAnchor), false, "a successful external write drops the pre-write served anchor");
      assert.equal(servedHashes.has(freshAnchor), true, "the write's auto-read serves the fresh anchor");
    } finally {
      store.close();
    }
  }

  // AC4 without auto-read re-recording: a write with autoRead disabled clears
  // the served row for the canonical external file and appends nothing.
  {
    const plainEvents = new Map();
    const plainPi = {
      on(name, handler) {
        const handlers = plainEvents.get(name) ?? [];
        handlers.push(handler);
        plainEvents.set(name, handlers);
      },
    };
    registerAnchoredAutoRead(
      plainPi,
      () => ({ anchoredEditing: { enabled: true, autoRead: false } }),
      () => true,
    );
    const clearedExternal = join(root, "outside-cleared.txt");
    writeFileSync(clearedExternal, "before\n", "utf8");
    await transformAnchoredReadContent(
      [{ type: "text", text: "factory content" }],
      { path: "../outside-cleared.txt" },
      workspace,
      "parent",
      { confineToWorkspace: false, sessionDir },
    );
    for (const handler of plainEvents.get("tool_call") ?? []) {
      await handler(
        { toolName: "write", toolCallId: "write-external-cleared", input: { path: "../outside-cleared.txt", content: "after\n" } },
        sessionCtx,
      );
    }
    writeFileSync(clearedExternal, "after\n", "utf8");
    let clearedResult;
    for (const handler of plainEvents.get("tool_result") ?? []) {
      clearedResult = await handler(
        {
          toolName: "write",
          toolCallId: "write-external-cleared",
          input: { path: "../outside-cleared.txt", content: "after\n" },
          content: [{ type: "text", text: "Successfully wrote 6 bytes" }],
          details: undefined,
          isError: false,
        },
        sessionCtx,
      );
    }
    assert.equal(clearedResult, undefined, "disabled auto-read appends nothing");
    const store = new DatabaseSync(storePath, { timeout: 500 });
    try {
      assert.equal(
        store.prepare("SELECT COUNT(*) AS count FROM served WHERE path = ?").get(realpathSync(clearedExternal)).count,
        0,
        "a successful external write clears served state for the canonical file in the initiating workspace",
      );
    } finally {
      store.close();
    }
  }

  // A write that creates a new external file still appends fresh anchors: the
  // pre-execution comparison sees no existing bytes, so the write counts as
  // changed for the bounded UTF-8 content.
  for (const handler of events.get("tool_call") ?? []) {
    await handler(
      { toolName: "write", toolCallId: "write-external-new", input: { path: "../outside-new.txt", content: "fresh\n" } },
      sessionCtx,
    );
  }
  // The Pi write factory has created the file by the time tool_result fires.
  writeFileSync(join(root, "outside-new.txt"), "fresh\n", "utf8");
  let externalNew;
  for (const handler of events.get("tool_result") ?? []) {
    externalNew = await handler(
      {
        toolName: "write",
        toolCallId: "write-external-new",
        input: { path: "../outside-new.txt", content: "fresh\n" },
        content: [{ type: "text", text: "Successfully wrote 6 bytes to ../outside-new.txt" }],
        details: undefined,
        isError: false,
      },
      sessionCtx,
    );
  }
  assert.ok(externalNew, "a new external file write returns an augmented result");
  assert.match(externalNew.content[1].text, /^[A-Za-z0-9]{3}│fresh$/m, "a created external file gets fresh anchors");

  for (const handler of events.get("tool_call") ?? []) {
    await handler(
      { toolName: "write", toolCallId: "write-external-failed", input: { path: "../outside-auto.txt", content: "nope\n" } },
      sessionCtx,
    );
  }
  let failedExternal;
  for (const handler of events.get("tool_result") ?? []) {
    failedExternal = await handler(
      {
        toolName: "write",
        toolCallId: "write-external-failed",
        input: { path: "../outside-auto.txt", content: "nope\n" },
        content: [{ type: "text", text: "Could not write file" }],
        details: undefined,
        isError: true,
      },
      sessionCtx,
    );
  }
  assert.equal(failedExternal, undefined, "a failed external write keeps its native result");

  const disabledEvents = new Map();
  registerAnchoredAutoRead(
    { on(name, handler) { disabledEvents.set(name, [...(disabledEvents.get(name) ?? []), handler]); } },
    () => ({ anchoredEditing: { enabled: true, autoRead: false } }),
    () => true,
  );
  for (const handler of disabledEvents.get("tool_call") ?? []) {
    await handler(
      { toolName: "write", toolCallId: "write-disabled", input: { path: "source.txt", content: "disabled\n" } },
      sessionCtx,
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
      sessionCtx,
    );
  }
  assert.equal(disabled, undefined, "disabled auto-read does not append anchors");

  const manyLines = Array.from({ length: 2_100 }, (_value, index) => `line-${index + 1}`).join("\n") + "\n";
  for (const handler of events.get("tool_call") ?? []) {
    await handler(
      { toolName: "write", toolCallId: "write-bounded", input: { path: "source.txt", content: manyLines } },
      sessionCtx,
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
      sessionCtx,
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
