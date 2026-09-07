import { afterEach } from "vitest";
import { describe, expect, it, vi } from "vitest";
import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import { createReadToolDefinition } from "@earendil-works/pi-coding-agent";
import { createAnchoredReplaceToolDefinition } from "../../../src/anchored-edit/workspace-replace";
import { createChildAnchoredReplaceTool } from "../../../src/anchored-edit/child-edit";
import { PARENT_OWNER } from "../../../src/anchored-edit/workspace-support";
import { withAnchoredReadTransform } from "../../../src/anchored-edit/read-tool";
import { transformAnchoredReadContent } from "../../../src/anchored-edit/read-transform";
import { insertBarrier, replaceBarrier } from "../../../src/anchored-edit/operations";
import { resolveTarget } from "../../../src/anchored-edit/fs-write";
import { toCwd } from "../../../src/anchored-edit/paths";
import { loadTestStore, makeFakePiRegistry, makeTestCtx, setupIntegrationTest, setupParentWrite, testSessionDir, withTempDir, withTempFile } from "../support/fixtures";

type AnyResult = { content: Array<{ type: string; text?: string }>; details?: { diff?: string; status?: string; errorCode?: string; metrics?: { classification?: string }; warnings?: string[] } };

function rowsOf(content: Array<{ type: string; text?: string }>): Array<{ hash: string; text: string }> {
  return content
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n")
    .split("\n")
    .flatMap((line) => {
      const match = /^([A-Za-z0-9]{3})│(.*)$/.exec(line);
      return match ? [{ hash: match[1]!, text: match[2] }] : [];
    });
}

function textOf(content: Array<{ type: string; text?: string }>): string {
  return content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");
}

function diffRows(diff: string): string[] {
  const hashes: string[] = [];
  for (const line of diff.split("\n")) {
    const match = /^[+ ]([A-Za-z0-9]{3})│/.exec(line);
    if (match) hashes.push(match[1]!);
  }
  return hashes;
}

/** Context rows an E_STALE_ANCHOR refusal returns, in `    N: HASH│text` form. */
function contextRows(message: string): Array<{ hash: string; text: string }> {
  return message.split("\n").flatMap((line) => {
    const match = /^ +\d+: ([A-Za-z0-9]{3})│(.*)$/.exec(line);
    return match ? [{ hash: match[1]!, text: match[2] }] : [];
  });
}

async function servedFor(cwd: string, name: string, owner: string = PARENT_OWNER): Promise<Set<string> | undefined> {
  const canonical = await resolveTarget(toCwd(name, cwd));
  const content = await readFile(canonical, "utf-8");
  const store = await loadTestStore(cwd, owner);
  try {
    const lookup = store.getServedState(canonical, content);
    return lookup !== undefined && "served" in lookup ? lookup.served : undefined;
  } finally {
    store.release();
  }
}

type ReadTool = { execute: (id: string, params: unknown, signal?: undefined, onUpdate?: undefined, ctx?: unknown) => Promise<{ content: Array<{ type: string; text?: string }> }> };

/** Anchors of one read, keyed by line text for readable test intent. */
async function readAnchors(readTool: ReadTool, ctx: unknown, name: string): Promise<Map<string, string>> {
  const read = await readTool.execute(`read-${name}`, { path: name }, undefined, undefined, ctx);
  const anchors = new Map<string, string>();
  for (const row of rowsOf(read.content)) anchors.set(row.text, row.hash);
  return anchors;
}

/** The live anchored read under an arbitrary owner partition, exactly as the
 *  child read composition wires it (native factory + shared transform). */
function childReadToolOf(cwd: string, owner: string): ReadTool {
  return withAnchoredReadTransform(
    createReadToolDefinition(cwd),
    cwd,
    (content, value, executionCwd, sessionDir) =>
      transformAnchoredReadContent(content as never, value, executionCwd, owner, { sessionDir }),
  ) as unknown as ReadTool;
}

async function expectApplied(result: AnyResult): Promise<AnyResult> {
  expect(result.details?.metrics?.classification, `expected an applied mutation, got: ${textOf(result?.content ?? []).slice(0, 200)}`).toBe("applied");
  expect(result.details?.status).toBeUndefined();
  expect(result.details?.errorCode).toBeUndefined();
  return result;
}

function autoReadOffReplace(cwd: string): ReadTool & { execute: (id: string, params: unknown, signal?: undefined, onUpdate?: undefined, ctx?: unknown) => Promise<AnyResult> } {
  const { pi, getTool } = makeFakePiRegistry();
  pi.registerTool(createAnchoredReplaceToolDefinition(cwd, () => false, PARENT_OWNER, false));
  return getTool("replace") as unknown as ReturnType<typeof autoReadOffReplace>;
}

/** Parks the next replace that enters its commit barrier and resolves once it
 *  is inside the boundary; deterministic ordering for concurrency tests. */
function parkReplaceAtCommit(): { entered: Promise<void>; release: () => void } {
  let releaseFn!: () => void;
  const entered = new Promise<void>((resolveEntered) => {
    replaceBarrier.beforeCommit = () => {
      replaceBarrier.beforeCommit = undefined;
      resolveEntered();
      return new Promise<void>((resolveRelease) => { releaseFn = resolveRelease; });
    };
  });
  return { entered, release: () => releaseFn() };
}

afterEach(() => {
  replaceBarrier.beforeCommit = undefined;
  replaceBarrier.beforePrepare = undefined;
  insertBarrier.beforeCommit = undefined;
  insertBarrier.beforePrepare = undefined;
});

describe("anchored authorization carry — sequential non-conflicting mutations from one read (#299)", () => {
  it("insert followed by insert applies both without an intervening read", async () => {
    await withTempFile("sample.txt", "a\nb\nc\n", async ({ cwd, path }) => {
      const { ctx, readTool, insertTool } = setupIntegrationTest(cwd);
      const anchors = await readAnchors(readTool, ctx, "sample.txt");

      const first = await expectApplied(await insertTool.execute("i1", { path: "sample.txt", anchor: anchors.get("a")!, direction: "after", lines: ["one"] }, undefined, undefined, ctx) as AnyResult);
      expect(first.details?.diff).toBeTruthy();
      const second = await expectApplied(await insertTool.execute("i2", { path: "sample.txt", anchor: anchors.get("c")!, direction: "before", lines: ["two"] }, undefined, undefined, ctx) as AnyResult);
      expect(second.details?.diff).toBeTruthy();
      expect(await readFile(path, "utf-8")).toBe("a\none\nb\ntwo\nc\n");
      expect(textOf(second.content)).not.toMatch(/E_RANGE_STALE|E_STALE_ANCHOR/);
    });
  });

  it("replace followed by replace applies both without an intervening read", async () => {
    await withTempFile("sample.txt", "a\nb\nc\nd\ne\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const anchors = await readAnchors(readTool, ctx, "sample.txt");

      await expectApplied(await editTool.execute("e1", { path: "sample.txt", remove_from: anchors.get("b")!, remove_to: anchors.get("b")!, replacement_text: "B" }, undefined, undefined, ctx) as AnyResult);
      await expectApplied(await editTool.execute("e2", { path: "sample.txt", remove_from: anchors.get("d")!, remove_to: anchors.get("e")!, replacement_text: "D\nE2" }, undefined, undefined, ctx) as AnyResult);
      expect(await readFile(path, "utf-8")).toBe("a\nB\nc\nD\nE2\n");
    });
  });

  it("insert followed by replace applies both without an intervening read", async () => {
    await withTempFile("sample.txt", "a\nb\nc\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool, insertTool } = setupIntegrationTest(cwd);
      const anchors = await readAnchors(readTool, ctx, "sample.txt");

      await expectApplied(await insertTool.execute("i1", { path: "sample.txt", anchor: anchors.get("b")!, direction: "after", lines: ["inserted"] }, undefined, undefined, ctx) as AnyResult);
      await expectApplied(await editTool.execute("e1", { path: "sample.txt", remove_from: anchors.get("c")!, remove_to: anchors.get("c")!, replacement_text: "C" }, undefined, undefined, ctx) as AnyResult);
      expect(await readFile(path, "utf-8")).toBe("a\nb\ninserted\nC\n");
    });
  });

  it("replace followed by insert applies both without an intervening read", async () => {
    await withTempFile("sample.txt", "a\nb\nc\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool, insertTool } = setupIntegrationTest(cwd);
      const anchors = await readAnchors(readTool, ctx, "sample.txt");

      await expectApplied(await editTool.execute("e1", { path: "sample.txt", remove_from: anchors.get("b")!, remove_to: anchors.get("b")!, replacement_text: "B" }, undefined, undefined, ctx) as AnyResult);
      await expectApplied(await insertTool.execute("i1", { path: "sample.txt", anchor: anchors.get("c")!, direction: "before", lines: ["inserted"] }, undefined, undefined, ctx) as AnyResult);
      expect(await readFile(path, "utf-8")).toBe("a\nB\ninserted\nc\n");
    });
  });

  it("keeps the anchor authorized for before and after insertions around the same observed row", async () => {
    await withTempFile("sample.txt", "a\nb\nc\n", async ({ cwd, path }) => {
      const { ctx, readTool, insertTool } = setupIntegrationTest(cwd);
      const anchors = await readAnchors(readTool, ctx, "sample.txt");

      await expectApplied(await insertTool.execute("i1", { path: "sample.txt", anchor: anchors.get("b")!, direction: "after", lines: ["after-b"] }, undefined, undefined, ctx) as AnyResult);
      await expectApplied(await insertTool.execute("i2", { path: "sample.txt", anchor: anchors.get("b")!, direction: "before", lines: ["before-b"] }, undefined, undefined, ctx) as AnyResult);
      expect(await readFile(path, "utf-8")).toBe("a\nbefore-b\nb\nafter-b\nc\n");
    });
  });

  it("reproduces the observed same-file batch: one read, seven non-conflicting mutations, zero stale refusals", async () => {
    await withTempFile("sample.txt", "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool, insertTool } = setupIntegrationTest(cwd);
      const anchors = await readAnchors(readTool, ctx, "sample.txt");

      const calls = [
        () => editTool.execute("b1", { path: "sample.txt", remove_from: anchors.get("l2")!, remove_to: anchors.get("l2")!, replacement_text: "L2" }, undefined, undefined, ctx),
        () => insertTool.execute("b2", { path: "sample.txt", anchor: anchors.get("l3")!, direction: "after", lines: ["ins-a"] }, undefined, undefined, ctx),
        () => editTool.execute("b3", { path: "sample.txt", remove_from: anchors.get("l5")!, remove_to: anchors.get("l5")!, replacement_text: "L5" }, undefined, undefined, ctx),
        () => insertTool.execute("b4", { path: "sample.txt", anchor: anchors.get("l6")!, direction: "before", lines: ["ins-b"] }, undefined, undefined, ctx),
        () => insertTool.execute("b5", { path: "sample.txt", anchor: anchors.get("l7")!, direction: "after", lines: ["ins-c"] }, undefined, undefined, ctx),
        () => editTool.execute("b6", { path: "sample.txt", remove_from: anchors.get("l8")!, remove_to: anchors.get("l8")!, replacement_text: "L8" }, undefined, undefined, ctx),
        () => insertTool.execute("b7", { path: "sample.txt", anchor: anchors.get("l1")!, direction: "after", lines: ["ins-d"] }, undefined, undefined, ctx),
      ] as Array<() => Promise<AnyResult>>;

      const results: AnyResult[] = [];
      for (const call of calls) results.push(await call() as AnyResult);
      for (const result of results) await expectApplied(result);
      expect(await readFile(path, "utf-8")).toBe("l1\nins-d\nL2\nl3\nins-a\nl4\nL5\nins-b\nl6\nl7\nins-c\nL8\n");
    });
  });
});

describe("anchored authorization carry — concurrent same-target calls (#299)", () => {
  it("later same-target operations cannot validate or mutate until the first publication completes: replace first, then replace and insert", async () => {
    await withTempDir("carry-concurrent-a-", async (cwd) => {
      const path = join(cwd, "sample.txt");
      await writeFile(path, "l1\nl2\nl3\nl4\nl5\nl6\n", "utf-8");
      const ctx = makeTestCtx(cwd);
      const { readTool, editTool, insertTool } = setupIntegrationTest(cwd);
      const anchors = await readAnchors(readTool, ctx, "sample.txt");

      const park = parkReplaceAtCommit();
      const first = editTool.execute("c1", { path: "sample.txt", remove_from: anchors.get("l2")!, remove_to: anchors.get("l2")!, replacement_text: "L2" }, undefined, undefined, ctx);
      await park.entered;

      // Queued behind the first operation's queue slot: neither can validate
      // or mutate while the first publication is still pending.
      const second = editTool.execute("c2", { path: "sample.txt", remove_from: anchors.get("l5")!, remove_to: anchors.get("l5")!, replacement_text: "L5" }, undefined, undefined, ctx);
      const third = insertTool.execute("c3", { path: "sample.txt", anchor: anchors.get("l3")!, direction: "after", lines: ["inserted"] }, undefined, undefined, ctx);
      await new Promise((resolveTick) => setImmediate(resolveTick));
      await new Promise((resolveTick) => setImmediate(resolveTick));
      expect(await readFile(path, "utf-8"), "no queued operation ran before the first publication").toBe("l1\nl2\nl3\nl4\nl5\nl6\n");

      park.release();
      await expectApplied((await first) as AnyResult);
      await expectApplied((await second) as AnyResult);
      await expectApplied((await third) as AnyResult);
      expect(await readFile(path, "utf-8")).toBe("l1\nL2\nl3\ninserted\nl4\nL5\nl6\n");
    });
  });

  it("completes disjoint effects under the other permissible launch order: insert queued first, then a replace", async () => {
    await withTempDir("carry-concurrent-b-", async (cwd) => {
      const path = join(cwd, "sample.txt");
      await writeFile(path, "l1\nl2\nl3\nl4\nl5\n", "utf-8");
      const ctx = makeTestCtx(cwd);
      const { readTool, editTool, insertTool } = setupIntegrationTest(cwd);
      const anchors = await readAnchors(readTool, ctx, "sample.txt");

      const park = parkReplaceAtCommit();
      const first = editTool.execute("c1", { path: "sample.txt", remove_from: anchors.get("l2")!, remove_to: anchors.get("l2")!, replacement_text: "L2" }, undefined, undefined, ctx);
      await park.entered;

      const second = insertTool.execute("c2", { path: "sample.txt", anchor: anchors.get("l4")!, direction: "before", lines: ["inserted"] }, undefined, undefined, ctx);
      const third = editTool.execute("c3", { path: "sample.txt", remove_from: anchors.get("l5")!, remove_to: anchors.get("l5")!, replacement_text: "L5" }, undefined, undefined, ctx);
      await new Promise((resolveTick) => setImmediate(resolveTick));
      expect(await readFile(path, "utf-8")).toBe("l1\nl2\nl3\nl4\nl5\n");

      park.release();
      await expectApplied((await first) as AnyResult);
      await expectApplied((await second) as AnyResult);
      await expectApplied((await third) as AnyResult);
      expect(await readFile(path, "utf-8")).toBe("l1\nL2\nl3\ninserted\nl4\nL5\n");
    });
  });

  it("two inserts launched concurrently at disjoint anchors both apply in queue order", async () => {
    await withTempDir("carry-concurrent-c-", async (cwd) => {
      const path = join(cwd, "sample.txt");
      await writeFile(path, "a\nb\nc\n", "utf-8");
      const ctx = makeTestCtx(cwd);
      const { readTool, insertTool } = setupIntegrationTest(cwd);
      const anchors = await readAnchors(readTool, ctx, "sample.txt");

      const first = insertTool.execute("c1", { path: "sample.txt", anchor: anchors.get("a")!, direction: "after", lines: ["one"] }, undefined, undefined, ctx);
      const second = insertTool.execute("c2", { path: "sample.txt", anchor: anchors.get("c")!, direction: "before", lines: ["two"] }, undefined, undefined, ctx);
      await expectApplied((await first) as AnyResult);
      await expectApplied((await second) as AnyResult);
      expect(await readFile(path, "utf-8")).toBe("a\none\nb\ntwo\nc\n");
    });
  });
});

describe("anchored authorization carry — conflict and fail-closed controls (#299)", () => {
  it("refuses a later replace whose range was consumed by an earlier replace, and its feedback authorizes the retry", async () => {
    await withTempFile("sample.txt", "a\nb\nc\nd\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const anchors = await readAnchors(readTool, ctx, "sample.txt");

      await expectApplied(await editTool.execute("e1", { path: "sample.txt", remove_from: anchors.get("b")!, remove_to: anchors.get("c")!, replacement_text: "X" }, undefined, undefined, ctx) as AnyResult);
      const refused = await editTool.execute("e2", { path: "sample.txt", remove_from: anchors.get("b")!, remove_to: anchors.get("d")!, replacement_text: "Y" }, undefined, undefined, ctx) as AnyResult;
      expect(refused.details?.status).toBe("warning");
      expect(refused.details?.errorCode).toBe("E_STALE_ANCHOR");
      expect(textOf(refused.content)).toContain("Current context around resolved anchor");
      expect(await readFile(path, "utf-8")).toBe("a\nX\nd\n");

      // The refusal's context rows are served for the current version, so
      // the immediate retry with one of them applies.
      const feedback = contextRows(textOf(refused.content));
      expect(feedback.length).toBeGreaterThan(0);
      const retry = await editTool.execute("e3", { path: "sample.txt", remove_from: feedback[0]!.hash, remove_to: feedback[0]!.hash, replacement_text: `${feedback[0]!.text}-edited` }, undefined, undefined, ctx) as AnyResult;
      await expectApplied(retry);
      expect(await readFile(path, "utf-8")).toBe("a\nX-edited\nd\n");
    });
  });

  it("does not carry a consumed row merely because identical replacement text reuses its hash identity", async () => {
    await withTempFile("sample.txt", "a\nb\nc\n", async ({ cwd, path }) => {
      const { ctx, readTool } = setupIntegrationTest(cwd);
      const anchors = await readAnchors(readTool, ctx, "sample.txt");
      const replaceTool = autoReadOffReplace(cwd);

      // The consumed rows b and c partially reappear: the replacement keeps
      // "b" verbatim, so the stable hash mapping reuses b's old hash on the
      // new line. With no diff rows served, the consumed row's identity must
      // not be treated as a survivor.
      await expectApplied(await replaceTool.execute("e1", { path: "sample.txt", remove_from: anchors.get("b")!, remove_to: anchors.get("c")!, replacement_text: "b\nc2" }, undefined, undefined, ctx) as AnyResult);
      expect(await readFile(path, "utf-8")).toBe("a\nb\nc2\n");
      const served = await servedFor(cwd, "sample.txt");
      expect(served?.has(anchors.get("a")!), "the untouched observed row carried").toBe(true);
      expect(served?.has(anchors.get("b")!), "the consumed row's reused identity did not carry").toBe(false);

      const refused = await replaceTool.execute("e2", { path: "sample.txt", remove_from: anchors.get("b")!, remove_to: anchors.get("b")!, replacement_text: "B" }, undefined, undefined, ctx) as AnyResult;
      expect(refused.details?.errorCode).toBe("E_RANGE_STALE");
      expect(textOf(refused.content)).toContain("Nothing was modified");
      expect(await readFile(path, "utf-8")).toBe("a\nb\nc2\n");
    });
  });

  it("expires the synthetic empty-file anchor after initialization", async () => {
    await withTempFile("sample.txt", "", async ({ cwd, path }) => {
      const { ctx, readTool, insertTool } = setupIntegrationTest(cwd);
      const read = await readTool.execute("r1", { path: "sample.txt" }, undefined, undefined, ctx);
      const synthetic = rowsOf(read.content);
      expect(synthetic).toHaveLength(1);

      await expectApplied(await insertTool.execute("i1", { path: "sample.txt", anchor: synthetic[0]!.hash, direction: "after", lines: ["x"] }, undefined, undefined, ctx) as AnyResult);
      expect(await readFile(path, "utf-8")).toBe("x\n");

      const served = await servedFor(cwd, "sample.txt");
      expect(served?.has(synthetic[0]!.hash), "the synthetic anchor did not migrate").toBe(false);
      const refused = await insertTool.execute("i2", { path: "sample.txt", anchor: synthetic[0]!.hash, direction: "after", lines: ["y"] }, undefined, undefined, ctx) as AnyResult;
      expect(refused.details?.status).toBe("warning");
      expect(["E_RANGE_STALE", "E_STALE_ANCHOR"]).toContain(refused.details?.errorCode);
      expect(await readFile(path, "utf-8")).toBe("x\n");
    });
  });

  it("serves the union of fresh diff rows and eligible previously observed rows for the new version with auto-read on", async () => {
    await withTempFile("sample.txt", "l1\nl2\nl3\nl4\nl5\nl6\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const anchors = await readAnchors(readTool, ctx, "sample.txt");

      const applied = await expectApplied(await editTool.execute("e1", { path: "sample.txt", remove_from: anchors.get("l2")!, remove_to: anchors.get("l2")!, replacement_text: "L2" }, undefined, undefined, ctx) as AnyResult);
      expect(await readFile(path, "utf-8")).toBe("l1\nL2\nl3\nl4\nl5\nl6\n");
      const fresh = new Set(diffRows(applied.details?.diff ?? ""));

      const served = await servedFor(cwd, "sample.txt");
      expect(served).toBeDefined();
      for (const line of ["l1", "l3", "l4", "l5", "l6"]) {
        expect(served!.has(anchors.get(line)!), `${line}'s observed row is authorized for the new version`).toBe(true);
      }
      const freshHash = [...fresh].find((hash) => hash !== anchors.get("l1") && hash !== anchors.get("l3"));
      expect(freshHash, "the diff exposes the replaced row's fresh anchor").toBeDefined();
      expect(served!.has(freshHash!), "the diff row is newly served").toBe(true);
      expect(served!.has(anchors.get("l2")!), "the consumed row's old identity is not served").toBe(false);
    });
  });

  it("clears prior anchored authorization on a whole-file write even when output lines are identical", async () => {
    await withTempFile("sample.txt", "a\nb\nc\n", async ({ cwd, path }) => {
      const { ctx, readTool, insertTool } = setupIntegrationTest(cwd);
      const anchors = await readAnchors(readTool, ctx, "sample.txt");

      const writeSession = setupParentWrite(cwd, { autoRead: false });
      await writeSession.runWrite("w1", { path: "sample.txt", content: "A\nb\nc\n" });
      expect(await readFile(path, "utf-8")).toBe("A\nb\nc\n");

      const served = await servedFor(cwd, "sample.txt");
      expect(served, "a write supplies no survival proof, so identical output lines stay unauthorized").toBeUndefined();
      // Insert's authorization is mandatory for every owner: with no served
      // rows for the written version, the old anchor must be refused even
      // though its content-derived hash still resolves.
      const refused = await insertTool.execute("i1", { path: "sample.txt", anchor: anchors.get("b")!, direction: "after", lines: ["x"] }, undefined, undefined, ctx) as AnyResult;
      expect(refused.details?.status).toBe("warning");
      expect(["E_RANGE_STALE", "E_STALE_ANCHOR"]).toContain(refused.details?.errorCode);
      expect(await readFile(path, "utf-8")).toBe("A\nb\nc\n");
    });
  });

  it("leaves an external out-of-range modification stale for an untouched observed anchor", async () => {
    await withTempFile("sample.txt", "a\nb\nc\nd\n", async ({ cwd, path }) => {
      const { ctx, readTool, editTool } = setupIntegrationTest(cwd);
      const anchors = await readAnchors(readTool, ctx, "sample.txt");

      await writeFile(path, "A\nb\nc\nd\n", "utf-8");
      const refused = await editTool.execute("e1", { path: "sample.txt", remove_from: anchors.get("b")!, remove_to: anchors.get("c")!, replacement_text: "X" }, undefined, undefined, ctx) as AnyResult;
      expect(refused.details?.errorCode).toBe("E_RANGE_STALE");
      expect(await readFile(path, "utf-8")).toBe("A\nb\nc\nd\n");
    });
  });
});

describe("anchored authorization carry — owner isolation (#299)", () => {
  it("a parent mutation leaves a child owner's rows stale; a child mutation leaves the parent's stale; only the acting owner's survivors migrate", async () => {
    await withTempDir("carry-owner-", async (cwd) => {
      const path = join(cwd, "sample.txt");
      await writeFile(path, "a\nb\nc\n", "utf-8");
      const ctx = makeTestCtx(cwd);
      const { readTool, editTool } = setupIntegrationTest(cwd);
      const anchors = await readAnchors(readTool, ctx, "sample.txt");

      const childRead = childReadToolOf(cwd, "subagent-carry");
      const childAnchors = await readAnchors(childRead, ctx, "sample.txt");
      const childReplace = createChildAnchoredReplaceTool(cwd, "subagent-carry", testSessionDir(cwd));

      // Parent mutates; its own later mutation stays authorized…
      await expectApplied(await editTool.execute("p1", { path: "sample.txt", remove_from: anchors.get("b")!, remove_to: anchors.get("b")!, replacement_text: "B" }, undefined, undefined, ctx) as AnyResult);
      await expectApplied(await editTool.execute("p2", { path: "sample.txt", remove_from: anchors.get("c")!, remove_to: anchors.get("c")!, replacement_text: "C" }, undefined, undefined, ctx) as AnyResult);
      // …while the child's untouched observed row went stale.
      const childRefused = await childReplace.execute("c1", { path: "sample.txt", remove_from: childAnchors.get("a")!, remove_to: childAnchors.get("a")!, replacement_text: "A" }, undefined, undefined, ctx) as AnyResult;
      expect(childRefused.details?.status).toBe("warning");
      expect(["E_RANGE_STALE", "E_STALE_ANCHOR"]).toContain(childRefused.details?.errorCode);
      expect(await readFile(path, "utf-8")).toBe("a\nB\nC\n");

      // A fresh child read repairs its partition, and the child's own
      // follow-up mutation stays authorized…
      const freshChild = await readAnchors(childRead, ctx, "sample.txt");
      await expectApplied(await childReplace.execute("c2", { path: "sample.txt", remove_from: freshChild.get("a")!, remove_to: freshChild.get("a")!, replacement_text: "A" }, undefined, undefined, ctx) as AnyResult);
      expect(await readFile(path, "utf-8")).toBe("A\nB\nC\n");
      // …while the parent's previously observed row went stale.
      const parentRefused = await editTool.execute("p3", { path: "sample.txt", remove_from: anchors.get("a")!, remove_to: anchors.get("a")!, replacement_text: "X" }, undefined, undefined, ctx) as AnyResult;
      expect(parentRefused.details?.status).toBe("warning");
      expect(["E_RANGE_STALE", "E_STALE_ANCHOR"]).toContain(parentRefused.details?.errorCode);
      expect(await readFile(path, "utf-8")).toBe("A\nB\nC\n");
    });
  });

  it("sibling child owners do not inherit each other's transitions", async () => {
    await withTempDir("carry-siblings-", async (cwd) => {
      const path = join(cwd, "sample.txt");
      await writeFile(path, "a\nb\nc\n", "utf-8");
      const ctx = makeTestCtx(cwd);
      const one = createChildAnchoredReplaceTool(cwd, "subagent-one", testSessionDir(cwd));
      const two = createChildAnchoredReplaceTool(cwd, "subagent-two", testSessionDir(cwd));
      const oneAnchors = await readAnchors(childReadToolOf(cwd, "subagent-one"), ctx, "sample.txt");
      const twoAnchors = await readAnchors(childReadToolOf(cwd, "subagent-two"), ctx, "sample.txt");

      await expectApplied(await one.execute("o1", { path: "sample.txt", remove_from: oneAnchors.get("b")!, remove_to: oneAnchors.get("b")!, replacement_text: "B" }, undefined, undefined, ctx) as AnyResult);
      // The acting child's own follow-up stays authorized.
      await expectApplied(await one.execute("o2", { path: "sample.txt", remove_from: oneAnchors.get("c")!, remove_to: oneAnchors.get("c")!, replacement_text: "C" }, undefined, undefined, ctx) as AnyResult);
      // The sibling's untouched observed row went stale.
      const refused = await two.execute("t1", { path: "sample.txt", remove_from: twoAnchors.get("a")!, remove_to: twoAnchors.get("a")!, replacement_text: "A" }, undefined, undefined, ctx) as AnyResult;
      expect(refused.details?.status).toBe("warning");
      expect(["E_RANGE_STALE", "E_STALE_ANCHOR"]).toContain(refused.details?.errorCode);
      expect(await readFile(path, "utf-8")).toBe("a\nB\nC\n");
    });
  });
});

describe("anchored authorization carry — post-commit publication failure (#299)", () => {
  it("a failed publication leaves no survivor or fresh authorization usable while the mutation reports truthful success", async () => {
    await withTempDir("carry-postcommit-", async (cwd) => {
      const path = join(cwd, "sample.txt");
      await writeFile(path, "l1\nl2\nl3\nl4\nl5\n", "utf-8");
      const ctx = makeTestCtx(cwd);
      const { readTool, editTool } = setupIntegrationTest(cwd);
      const anchors = await readAnchors(readTool, ctx, "sample.txt");

      const hashStoreModule = await import("../../../src/anchored-edit/hash-store");
      const spy = vi.spyOn(hashStoreModule.__testables.HashStoreHandleImpl.prototype, "publishMutation")
        .mockImplementation(() => {
          throw new Error("store down");
        });
      const applied = await editTool.execute("e1", { path: "sample.txt", remove_from: anchors.get("l2")!, remove_to: anchors.get("l2")!, replacement_text: "L2" }, undefined, undefined, ctx) as AnyResult;
      spy.mockRestore();

      expect(textOf(applied.content)).toContain("Successfully replaced");
      expect(applied.details?.warnings?.some((w) => w.includes("[E_STATE_UNAVAILABLE]"))).toBe(true);
      expect(applied.details?.diff).toBe("");
      expect(await readFile(path, "utf-8")).toBe("l1\nL2\nl3\nl4\nl5\n");

      // A row that would have survived carries nothing after the rollback…
      const survivorRefused = await editTool.execute("e2", { path: "sample.txt", remove_from: anchors.get("l4")!, remove_to: anchors.get("l4")!, replacement_text: "L4" }, undefined, undefined, ctx) as AnyResult;
      expect(survivorRefused.details?.errorCode).toBe("E_RANGE_STALE");
      expect(textOf(survivorRefused.content)).toContain("Nothing was modified");
      // …and a fresh read repairs the state.
      const freshAnchors = await readAnchors(readTool, ctx, "sample.txt");
      await expectApplied(await editTool.execute("e3", { path: "sample.txt", remove_from: freshAnchors.get("l4")!, remove_to: freshAnchors.get("l4")!, replacement_text: "L4" }, undefined, undefined, ctx) as AnyResult);
      expect(await readFile(path, "utf-8")).toBe("l1\nL2\nl3\nL4\nl5\n");
    });
  });
});
