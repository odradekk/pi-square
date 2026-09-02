import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import jiti from "jiti";

const load = jiti(import.meta.url, { moduleCache: false });
const { createParentAnchoredWrite, registerAnchoredAutoRead } = await load("../../src/anchored-edit/auto-read.ts");
const { createWriteToolDefinition } = await load("@earendil-works/pi-coding-agent");
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
  // The production parent write composition (#264): the write factory with
  // the anchored operation injected, plus the appendix presentation handlers.
  const events = new Map();
  const pi = {
    on(name, handler) {
      const handlers = events.get(name) ?? [];
      handlers.push(handler);
      events.set(name, handlers);
    },
  };
  const config = () => ({ anchoredEditing: { enabled: true, autoRead: true } });
  const parentWrite = createParentAnchoredWrite(config);
  registerAnchoredAutoRead(pi, config, () => true, parentWrite);
  const writeDefinition = createWriteToolDefinition(workspace, {
    operations: parentWrite.attachSession(workspace, sessionDir, () => true).operations,
  });

  const runWrite = async (toolCallId, input) => {
    for (const handler of events.get("tool_call") ?? []) {
      await handler({ toolName: "write", toolCallId, input }, sessionCtx);
    }
    const factoryResult = await writeDefinition.execute(toolCallId, input, undefined, undefined, sessionCtx);
    let patched;
    for (const handler of events.get("tool_result") ?? []) {
      patched = await handler(
        {
          toolName: "write",
          toolCallId,
          input,
          content: factoryResult.content,
          details: factoryResult.details,
          isError: false,
        },
        sessionCtx,
      );
    }
    return patched ?? factoryResult;
  };

  const result = await runWrite("write-1", { path: "source.txt", content: "after\n" });
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
    { sessionDir },
  );
  {
    const store = new DatabaseSync(storePath, { timeout: 500 });
    try {
      const rows = store.prepare("SELECT hash FROM served WHERE owner = 'parent' AND path = ?").all(realpathSync(external));
      assert.equal(rows.length, 1, "the pre-write external read seeds one served row");
    } finally {
      store.close();
    }
  }
  const externalResult = await runWrite("write-external", { path: "../outside-auto.txt", content: "after\n" });
  assert.ok(externalResult, "a changed external write returns an augmented result");
  assert.match(externalResult.content[1].text, /--- Auto-read \(hashline anchors\) ---/);
  assert.match(externalResult.content[1].text, /^[A-Za-z0-9]{3}│after$/m, "an external write appends fresh anchors");
  {
    // With autoRead on, the write clears the pre-write served row and then
    // records the post-write anchors, so the row reflects the new content:
    // the pre-write anchor is gone and the fresh one is served.
    const store = new DatabaseSync(storePath, { timeout: 500 });
    try {
      const rows = store.prepare("SELECT hash FROM served WHERE owner = 'parent' AND path = ?").all(realpathSync(external));
      assert.ok(rows.length > 0, "the external served rows exist after the write");
      const servedHashes = new Set(rows.map((row) => row.hash));
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
    const plainConfig = () => ({ anchoredEditing: { enabled: true, autoRead: false } });
    const plainParentWrite = createParentAnchoredWrite(plainConfig);
    registerAnchoredAutoRead(plainPi, plainConfig, () => true, plainParentWrite);
    const plainWrite = createWriteToolDefinition(workspace, {
      operations: plainParentWrite.attachSession(workspace, sessionDir, () => true).operations,
    });

    const clearedExternal = join(root, "outside-cleared.txt");
    writeFileSync(clearedExternal, "before\n", "utf8");
    await transformAnchoredReadContent(
      [{ type: "text", text: "factory content" }],
      { path: "../outside-cleared.txt" },
      workspace,
      "parent",
      { sessionDir },
    );
    for (const handler of plainEvents.get("tool_call") ?? []) {
      await handler(
        { toolName: "write", toolCallId: "write-external-cleared", input: { path: "../outside-cleared.txt", content: "after\n" } },
        sessionCtx,
      );
    }
    const clearedFactoryResult = await plainWrite.execute(
      "write-external-cleared",
      { path: "../outside-cleared.txt", content: "after\n" },
      undefined,
      undefined,
      sessionCtx,
    );
    let clearedResult;
    for (const handler of plainEvents.get("tool_result") ?? []) {
      clearedResult = await handler(
        {
          toolName: "write",
          toolCallId: "write-external-cleared",
          input: { path: "../outside-cleared.txt", content: "after\n" },
          content: clearedFactoryResult.content,
          details: clearedFactoryResult.details,
          isError: false,
        },
        sessionCtx,
      );
    }
    assert.equal(clearedResult, undefined, "disabled auto-read appends nothing");
    const store = new DatabaseSync(storePath, { timeout: 500 });
    try {
      // autoRead=false appends no anchors, but the successful write still
      // clears the served rows in its single post-commit transaction (#264).
      assert.equal(
        store.prepare("SELECT COUNT(*) AS count FROM served WHERE owner = 'parent' AND path = ?").get(realpathSync(clearedExternal)).count,
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
  const externalNew = await runWrite("write-external-new", { path: "../outside-new.txt", content: "fresh\n" });
  assert.ok(externalNew, "a new external file write returns an augmented result");
  assert.match(externalNew.content[1].text, /^[A-Za-z0-9]{3}│fresh$/m, "a created external file gets fresh anchors");

  for (const handler of events.get("tool_call") ?? []) {
    await handler(
      { toolName: "write", toolCallId: "write-external-failed", input: { path: "../outside-auto.txt/child", content: "nope\n" } },
      sessionCtx,
    );
  }
  await assert.rejects(
    writeDefinition.execute(
      "write-external-failed",
      { path: "../outside-auto.txt/child", content: "nope\n" },
      undefined,
      undefined,
      sessionCtx,
    ),
    /EEXIST|ENOTDIR/,
    "a failed external write keeps its native failure",
  );
  let failedExternal;
  for (const handler of events.get("tool_result") ?? []) {
    failedExternal = await handler(
      {
        toolName: "write",
        toolCallId: "write-external-failed",
        input: { path: "../outside-auto.txt/child", content: "nope\n" },
        content: [{ type: "text", text: "Could not write file" }],
        details: undefined,
        isError: true,
      },
      sessionCtx,
    );
  }
  assert.equal(failedExternal, undefined, "a failed external write appends nothing");

  {
    const plainEvents2 = new Map();
    const plainPi2 = {
      on(name, handler) {
        const handlers = plainEvents2.get(name) ?? [];
        handlers.push(handler);
        plainEvents2.set(name, handlers);
      },
    };
    const offConfig = () => ({ anchoredEditing: { enabled: true, autoRead: false } });
    const offParentWrite = createParentAnchoredWrite(offConfig);
    registerAnchoredAutoRead(plainPi2, offConfig, () => true, offParentWrite);
    const offWrite = createWriteToolDefinition(workspace, {
      operations: offParentWrite.attachSession(workspace, sessionDir, () => true).operations,
    });
    for (const handler of plainEvents2.get("tool_call") ?? []) {
      await handler({ toolName: "write", toolCallId: "write-disabled", input: { path: "source.txt", content: "disabled\n" } }, sessionCtx);
    }
    const offFactoryResult = await offWrite.execute("write-disabled", { path: "source.txt", content: "disabled\n" }, undefined, undefined, sessionCtx);
    let disabled;
    for (const handler of plainEvents2.get("tool_result") ?? []) {
      disabled = await handler(
        {
          toolName: "write",
          toolCallId: "write-disabled",
          input: { path: "source.txt", content: "disabled\n" },
          content: offFactoryResult.content,
          details: offFactoryResult.details,
          isError: false,
        },
        sessionCtx,
      );
    }
    const disabledResult = disabled ?? offFactoryResult;
    assert.equal(disabledResult.content.length, 1, "an auto-read-disabled write appends nothing");
    assert.ok(disabledResult.content[0].text.startsWith("Successfully wrote"), "the factory result is preserved");
  }

  const manyLines = Array.from({ length: 2_100 }, (_value, index) => `line-${index + 1}`).join("\n") + "\n";
  const bounded = await runWrite("write-bounded", { path: "source.txt", content: manyLines });
  const boundedText = bounded.content[1].text;
  assert.match(boundedText, /skipped/i, "bounded auto-read output shows skipped rows");
  assert.ok(boundedText.split("\n").length <= 2_010, "bounded auto-read output remains within its row budget");

  console.log("anchored auto-read integration tests: OK");
} finally {
  shutdownHashStore();
  rmSync(root, { recursive: true, force: true });
}
