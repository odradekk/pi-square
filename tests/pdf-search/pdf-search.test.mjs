import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PDFDocument, StandardFonts } from "@cantoo/pdf-lib";
import jiti from "jiti";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const load = jiti(import.meta.url, { moduleCache: false });
const inputModule = load(join(packageRoot, "src", "core", "pdf-input.ts"));
const cacheModule = load(join(packageRoot, "src", "pdf-search", "cache.ts"));
const extractModule = load(join(packageRoot, "src", "pdf-search", "extract.ts"));
const matcherModule = load(join(packageRoot, "src", "pdf-search", "matcher.ts"));
const toolModule = load(join(packageRoot, "src", "pdf-search", "tool.ts"));

const { resolvePdfPath } = inputModule;
const { PdfTextCache } = cacheModule;
const { extractPdfText, PdfSearchError, resolvePdfJsAssetPaths, textContentToPageText } = extractModule;
const { boundedDamerauLevenshtein, fuzzyEditBudget, normalizePdfText, searchPdfPages } = matcherModule;
const { createPdfSearchToolDefinition } = toolModule;

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

async function createPdf(pageTexts, { encrypted = false, reverseDrawOrder = false } = {}) {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (const texts of pageTexts) {
    const page = document.addPage([600, 800]);
    const lines = Array.isArray(texts) ? texts : [texts];
    const ordered = reverseDrawOrder ? [...lines].reverse() : lines;
    for (const text of ordered) {
      const originalIndex = lines.indexOf(text);
      page.drawText(text, { x: 50, y: 740 - originalIndex * 30, font, size: 12 });
    }
  }
  if (encrypted) document.encrypt({ ownerPassword: "owner-secret", userPassword: "user-secret" });
  return document.save();
}

const workspace = mkdtempSync(join(tmpdir(), "pi-square-pdf-search-"));
const outside = mkdtempSync(join(tmpdir(), "pi-square-pdf-search-outside-"));
const samplePath = join(workspace, "sample.pdf");
const blankPath = join(workspace, "blank.pdf");
const encryptedPath = join(workspace, "encrypted.pdf");
const outsidePath = join(outside, "outside.pdf");
writeFileSync(samplePath, await createPdf([["Installation guide", "Run setup now"], "Second page"], { reverseDrawOrder: true }));
writeFileSync(blankPath, await createPdf([""]));
writeFileSync(encryptedPath, await createPdf(["secret"], { encrypted: true }));
writeFileSync(outsidePath, await createPdf(["outside"]));
try { symlinkSync(outsidePath, join(workspace, "escape.pdf")); } catch {}

function extracted(pages) {
  const textUnits = pages.reduce((sum, page) => sum + page.length, 0);
  return { pages, pageCount: pages.length, textUnits, estimatedBytes: textUnits * 2 + pages.length * 64 };
}

function identity(size, version) {
  return { device: "1", inode: String(version), size, modifiedNs: String(version), changedNs: String(version) };
}

// Normalization and fuzzy matching

test("normalization handles compatibility forms, line-end hyphens, whitespace, and CJK spacing", () => {
  assert.equal(normalizePdfText("ＡＢＣ  INFOR-\n  MATION"), "abc information");
  assert.equal(normalizePdfText("中 \n 文　测 试"), "中文测试");
});

test("fuzzy matching is conservative, ranked, and page-oriented", () => {
  const pages = ["installation guide for operators", "unrelated", "installation guide appendix"];
  const fuzzy = searchPdfPages(pages, "instalation guide", 10);
  assert.equal(fuzzy.total, 2);
  assert.deepEqual(fuzzy.matches.map((match) => match.page), [1, 3]);
  assert.ok(fuzzy.matches.every((match) => match.type === "fuzzy" && match.edits === 1));

  const exact = searchPdfPages(pages, "installation guide", 1);
  assert.equal(exact.total, 2);
  assert.equal(exact.matches[0].type, "exact");
  assert.equal(exact.matches[0].score, 1);
  assert.equal(searchPdfPages(["target"], "targt", 10).total, 0, "queries shorter than 6 characters stay exact-only");
});

test("bounded edit distance supports transposition, budgets, and synchronous deadlines", () => {
  assert.equal(boundedDamerauLevenshtein(Array.from("search"), Array.from("seacrh"), 1), 1);
  assert.equal(boundedDamerauLevenshtein(Array.from("search"), Array.from("missing"), 1), 2);
  assert.equal(fuzzyEditBudget(5), 0);
  assert.equal(fuzzyEditBudget(6), 1);
  assert.equal(fuzzyEditBudget(30), 4);
  assert.throws(
    () => searchPdfPages(["searchable page"], "searchable", 10, () => { throw new Error("deadline"); }),
    /deadline/,
  );
});

test("text items are ordered by coordinates and produce searchable context", () => {
  const text = textContentToPageText([
    { str: "second", transform: [1, 0, 0, 1, 50, 500], width: 40, height: 12, hasEOL: false },
    { str: "first", transform: [1, 0, 0, 1, 50, 700], width: 30, height: 12, hasEOL: false },
    { str: "line", transform: [1, 0, 0, 1, 90, 700], width: 20, height: 12, hasEOL: true },
  ]);
  assert.equal(text, "first line second");
});

// PDF.js extraction

test("PDF.js assets resolve locally and real extraction preserves page boundaries", async () => {
  const assets = resolvePdfJsAssetPaths();
  assert.ok(assets.cMapUrl.endsWith(join("pdfjs-dist", "cmaps") + "/") || assets.cMapUrl.endsWith(join("pdfjs-dist", "cmaps") + "\\"));
  const result = await extractPdfText(new Uint8Array(await import("node:fs/promises").then((fs) => fs.readFile(samplePath))));
  assert.equal(result.pageCount, 2);
  assert.equal(result.pages[0], "installation guide run setup now");
  assert.equal(result.pages[1], "second page");
});

test("real extraction rejects encrypted and textless PDFs distinctly", async () => {
  const fs = await import("node:fs/promises");
  const encryptedBytes = new Uint8Array(await fs.readFile(encryptedPath));
  const blankBytes = new Uint8Array(await fs.readFile(blankPath));
  await assert.rejects(
    () => extractPdfText(encryptedBytes),
    (error) => error instanceof PdfSearchError && error.code === "ENCRYPTED_PDF",
  );
  await assert.rejects(
    () => extractPdfText(blankBytes),
    (error) => error instanceof PdfSearchError && error.code === "NO_EXTRACTABLE_TEXT",
  );
});

// Cache and tool contract

test("cache validates file identity, refreshes LRU order, and enforces byte budgets", () => {
  const cache = new PdfTextCache(100, 150);
  const a = { absolutePath: "/a.pdf", displayPath: "a.pdf", identity: identity(10, 1) };
  const b = { absolutePath: "/b.pdf", displayPath: "b.pdf", identity: identity(10, 2) };
  const value = { pages: ["x"], pageCount: 1, textUnits: 1, estimatedBytes: 80 };
  assert.equal(cache.set(a, value), true);
  assert.equal(cache.get(a), value);
  assert.equal(cache.set(b, value), true);
  assert.equal(cache.get(a), undefined, "oldest entry is evicted");
  assert.equal(cache.get({ ...b, identity: identity(11, 3) }), undefined, "changed identity invalidates entry");
  assert.equal(cache.bytes, 0);
});

test("tool schema is strict and child-safe before parent decoration", () => {
  const tool = createPdfSearchToolDefinition();
  assert.equal(tool.name, "pdf_search");
  assert.equal(tool.parameters.type, "object");
  assert.equal(tool.parameters.additionalProperties, false);
  assert.equal(tool.parameters.anyOf, undefined);
  assert.deepEqual(tool.parameters.required.sort(), ["path", "query"]);
  assert.equal(tool.parameters.properties.path.maxLength, 4096);
  assert.equal(tool.parameters.properties.query.maxLength, 500);
  assert.equal(tool.parameters.properties.limit.maximum, 20);
  assert.equal(tool.renderCall, undefined);
  assert.equal(tool.renderResult, undefined);
  assert.equal(tool.renderShell, undefined);
});

test("tool caches extraction, returns ranked pages, and invalidates after file change", async () => {
  const cache = new PdfTextCache();
  let extractions = 0;
  const tool = createPdfSearchToolDefinition({
    cache,
    async extract() {
      extractions++;
      return extracted(["installation guide", "other", "installation appendix"]);
    },
  });
  const context = { cwd: workspace };
  const first = await tool.execute("t1", { path: "sample.pdf", query: "instalation", limit: 1 }, undefined, undefined, context);
  assert.equal(first.details.status, "success");
  assert.equal(first.details.cacheHit, false);
  assert.equal(first.details.totalMatches, 2);
  assert.equal(first.details.hasMore, true);
  assert.equal(first.details.matches[0].page, 1);
  assert.equal(extractions, 1);

  const second = await tool.execute("t2", { path: "sample.pdf", query: "appendix" }, undefined, undefined, context);
  assert.equal(second.details.cacheHit, true);
  assert.equal(second.details.matches[0].page, 3);
  assert.equal(extractions, 1);

  writeFileSync(samplePath, await createPdf(["changed source"]));
  const third = await tool.execute("t3", { path: "sample.pdf", query: "installation" }, undefined, undefined, context);
  assert.equal(third.details.cacheHit, false);
  assert.equal(extractions, 2);
});

test("tool rejects invalid arguments and paths outside the workspace before extraction", async () => {
  let calls = 0;
  const tool = createPdfSearchToolDefinition({ async extract() { calls++; return extracted(["x"]); } });
  const invalidLimit = await tool.execute("t", { path: "sample.pdf", query: "outside", limit: "10" }, undefined, undefined, { cwd: workspace });
  assert.equal(invalidLimit.details.errorCode, "INVALID_ARGUMENT");
  const longPath = await tool.execute("t", { path: "x".repeat(4097), query: "outside" }, undefined, undefined, { cwd: workspace });
  assert.equal(longPath.details.errorCode, "INVALID_ARGUMENT");
  assert.equal(longPath.details.path.length, 4096);
  const outsideResult = await tool.execute("t", { path: outsidePath, query: "outside" }, undefined, undefined, { cwd: workspace });
  assert.equal(outsideResult.details.errorCode, "PDF_OUTSIDE_WORKSPACE");
  if (process.platform !== "win32") {
    const symlinkResult = await tool.execute("t", { path: "escape.pdf", query: "outside" }, undefined, undefined, { cwd: workspace });
    assert.equal(symlinkResult.details.errorCode, "PDF_OUTSIDE_WORKSPACE");
  }
  assert.equal(calls, 0);
});

test("tool reports cancellation, extraction errors, no matches, and matching context", async () => {
  const controller = new AbortController();
  controller.abort();
  const preCancelled = createPdfSearchToolDefinition({ async extract() { throw new Error("unreachable"); } });
  const cancelled = await preCancelled.execute("t", { path: "sample.pdf", query: "x" }, controller.signal, undefined, { cwd: workspace });
  assert.equal(cancelled.details.errorCode, "ABORTED");
  // Cancellation and a genuine hard failure are distinct outcomes at the
  // tool level (status "aborted" vs. "error") and neither ever carries a
  // partial match list — the display layer's aborted-vs-failed marker
  // distinction relies on this invariant holding at the source.
  assert.equal(cancelled.details.status, "aborted");
  assert.equal(cancelled.isError, true);
  assert.deepEqual(cancelled.details.matches, [], "cancellation carries no partial matches");

  const failing = createPdfSearchToolDefinition({
    async extract() { throw new PdfSearchError("NO_EXTRACTABLE_TEXT", "scanned PDF"); },
  });
  const failed = await failing.execute("t", { path: "sample.pdf", query: "x" }, undefined, undefined, { cwd: workspace });
  assert.equal(failed.details.errorCode, "NO_EXTRACTABLE_TEXT");
  assert.equal(failed.details.status, "error", "a genuine failure never reports the aborted status");
  assert.equal(failed.isError, true);
  assert.deepEqual(failed.details.matches, [], "a hard failure carries no partial matches");

  const successful = createPdfSearchToolDefinition({ async extract() { return extracted(["needle context"]); } });
  const found = await successful.execute("t", { path: "sample.pdf", query: "needle" }, undefined, undefined, { cwd: workspace });
  assert.equal(found.details.matches[0].page, 1);
  assert.match(found.details.matches[0].context, /needle context/);

  const empty = await successful.execute("t", { path: "sample.pdf", query: "absent" }, undefined, undefined, { cwd: workspace });
  assert.equal(empty.details.totalMatches, 0);
});

try {
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`ok - ${name}`);
    } catch (error) {
      console.error(`not ok - ${name}`);
      throw error;
    }
  }
  console.log(`\n${tests.length} pdf_search tests passed`);
} finally {
  rmSync(workspace, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
}
