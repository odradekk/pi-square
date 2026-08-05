import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

import { PDFDocument } from "@cantoo/pdf-lib";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import jiti from "jiti";

initTheme();

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const load = jiti(import.meta.url, { moduleCache: false });
const pagesModule = load(join(packageRoot, "src", "web", "parse", "pages.ts"));
const pdfModule = load(join(packageRoot, "src", "web", "parse", "pdf.ts"));
const clientModule = load(join(packageRoot, "src", "web", "clients", "firecrawl.ts"));
const toolModule = load(join(packageRoot, "src", "web", "tools", "parse.ts"));

const {
  assertPagesInDocument,
  formatPageSelection,
  PageSelectionError,
  parsePageSelection,
} = pagesModule;
const { extractPdfPages, loadPdf, PdfInputError, resolvePdfInput } = pdfModule;
const { FIRECRAWL_PARSE_URL, FIRECRAWL_RESPONSE_CAP, parsePdfWithFirecrawl } = clientModule;
const { createParseToolDefinition, registerParseTool } = toolModule;

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

function installMockFetch(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return await handler(String(url), init, calls.length - 1);
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function createPdf(pageCount, encrypt = false) {
  const pdf = await PDFDocument.create();
  for (let page = 1; page <= pageCount; page++) pdf.addPage([100 + page, 200 + page]);
  if (encrypt) pdf.encrypt({ ownerPassword: "owner-secret", userPassword: "user-secret" });
  return await pdf.save();
}

const workspace = mkdtempSync(join(tmpdir(), "pi-square-parse-test-"));
const outside = mkdtempSync(join(tmpdir(), "pi-square-parse-outside-"));
const samplePath = join(workspace, "sample.pdf");
const encryptedPath = join(workspace, "encrypted.pdf");
const outsidePath = join(outside, "outside.pdf");
writeFileSync(samplePath, await createPdf(25));
writeFileSync(encryptedPath, await createPdf(1, true));
writeFileSync(outsidePath, await createPdf(1));
writeFileSync(join(workspace, "fake.pdf"), "not a pdf", "utf8");
writeFileSync(join(workspace, "sample.txt"), await createPdf(1));
try {
  symlinkSync(outsidePath, join(workspace, "escape.pdf"));
} catch {
  // Symlink creation can be unavailable on restricted platforms.
}

const plainTheme = {
  fg(_color, text) { return String(text); },
  bold(text) { return String(text); },
  bg(_color, text) { return String(text); },
};
const NO_CONTEXT = { lastComponent: undefined };

function render(component, width = 80) {
  return component.render(width).map((line) => stripVTControlCharacters(line));
}

function interactiveContext(confirm, cwd = workspace) {
  return { cwd, hasUI: true, ui: { confirm } };
}

// Page selection

test("page expressions expand, sort, and de-duplicate all documented forms", () => {
  assert.deepEqual(parsePageSelection("1"), [1]);
  assert.deepEqual(parsePageSelection("1-3"), [1, 2, 3]);
  assert.deepEqual(parsePageSelection("1, 2-4, 10-12"), [1, 2, 3, 4, 10, 11, 12]);
  assert.deepEqual(parsePageSelection("6, 1-4, 3, 20-22"), [1, 2, 3, 4, 6, 20, 21, 22]);
  assert.equal(formatPageSelection([1, 2, 3, 4, 6, 20, 21, 22]), "1-4, 6, 20-22");
});

test("page expressions reject empty, malformed, descending, unsafe, and oversized selections", () => {
  for (const input of ["", "1,,2", "one", "1-", "-2", "0", "4-2", "9007199254740992"]) {
    assert.throws(() => parsePageSelection(input), PageSelectionError, input);
  }
  assert.throws(
    () => parsePageSelection("1-51"),
    (error) => error instanceof PageSelectionError && error.code === "TOO_MANY_PAGES",
  );
});

test("page bounds are checked against the original document", () => {
  assert.doesNotThrow(() => assertPagesInDocument([1, 3], 3));
  assert.throws(
    () => assertPagesInDocument([1, 4], 3),
    (error) => error instanceof PageSelectionError && error.code === "PAGE_OUT_OF_RANGE",
  );
});

// Local PDF boundary and extraction

test("PDF input resolves only regular .pdf files inside the workspace", () => {
  const input = resolvePdfInput(workspace, "sample.pdf");
  assert.equal(input.absolutePath, samplePath);
  assert.equal(input.displayPath, "sample.pdf");
  assert.ok(input.bytes.byteLength > 0);
  assert.throws(
    () => resolvePdfInput(workspace, outsidePath),
    (error) => error instanceof PdfInputError && error.code === "PDF_OUTSIDE_WORKSPACE",
  );
  if (process.platform !== "win32") {
    assert.throws(
      () => resolvePdfInput(workspace, "escape.pdf"),
      (error) => error instanceof PdfInputError && error.code === "PDF_OUTSIDE_WORKSPACE",
    );
  }
  assert.throws(
    () => resolvePdfInput(workspace, "sample.txt"),
    (error) => error instanceof PdfInputError && error.code === "UNSUPPORTED_FILE_TYPE",
  );
  assert.throws(
    () => resolvePdfInput(workspace, "fake.pdf"),
    (error) => error instanceof PdfInputError && error.code === "INVALID_PDF",
  );
});

test("PDF loading rejects encryption and extraction copies selected pages in sorted order", async () => {
  const source = await loadPdf(resolvePdfInput(workspace, "sample.pdf").bytes);
  const selected = await extractPdfPages(source.document, [1, 4, 6]);
  const output = await PDFDocument.load(selected);
  assert.equal(output.getPageCount(), 3);
  assert.deepEqual(output.getPages().map((page) => page.getWidth()), [101, 104, 106]);

  await assert.rejects(
    () => loadPdf(resolvePdfInput(workspace, "encrypted.pdf").bytes),
    (error) => error instanceof PdfInputError && error.code === "ENCRYPTED_PDF",
  );
});

// Firecrawl client

test("Firecrawl client sends one bounded multipart request with fixed parse options", async () => {
  const mock = installMockFetch(async (url, init) => {
    assert.equal(url, FIRECRAWL_PARSE_URL);
    assert.equal(init.method, "POST");
    assert.equal(init.redirect, "error");
    assert.equal(init.headers.Authorization, "Bearer fc-test-key");
    assert.equal(Object.keys(init.headers).some((name) => name.toLowerCase() === "content-type"), false);
    assert.ok(init.body instanceof FormData);
    const file = init.body.get("file");
    assert.ok(file instanceof Blob);
    assert.equal(file.type, "application/pdf");
    const options = JSON.parse(init.body.get("options"));
    assert.deepEqual(options, {
      formats: ["markdown"],
      onlyMainContent: true,
      timeout: 30000,
      parsers: [{ type: "pdf", mode: "auto", maxPages: 2 }],
      zeroDataRetention: false,
    });
    const uploaded = await PDFDocument.load(new Uint8Array(await file.arrayBuffer()));
    assert.equal(uploaded.getPageCount(), 2);
    return jsonResponse(200, {
      success: true,
      data: {
        markdown: "# Parsed",
        metadata: { title: "Report", numPages: 2, totalPages: 2, ignored: "not retained" },
        warning: "bounded warning",
      },
    });
  });
  try {
    const result = await parsePdfWithFirecrawl({
      apiKey: "fc-test-key",
      fileName: "report-selected.pdf",
      pdfBytes: await createPdf(2),
      mode: "auto",
      pageCount: 2,
      timeoutMs: 30000,
    });
    assert.equal(result.markdown, "# Parsed");
    assert.deepEqual(result.metadata, { title: "Report", numPages: 2, totalPages: 2 });
    assert.equal(result.warning, "bounded warning");
    assert.equal(mock.calls.length, 1);
  } finally {
    mock.restore();
  }
});

test("Firecrawl client does not retry HTTP failures and rejects malformed success payloads", async () => {
  const onePagePdf = await createPdf(1);
  const failureMock = installMockFetch(() => jsonResponse(500, { code: "UNKNOWN_ERROR", error: "failed once" }));
  try {
    await assert.rejects(
      () => parsePdfWithFirecrawl({
        apiKey: "fc-test-key",
        fileName: "one.pdf",
        pdfBytes: onePagePdf,
        mode: "fast",
        pageCount: 1,
        timeoutMs: 30000,
      }),
      (error) => error?.status === 500 && error?.body === "UNKNOWN_ERROR: failed once",
    );
    assert.equal(failureMock.calls.length, 1);
  } finally {
    failureMock.restore();
  }

  const malformedMock = installMockFetch(() => jsonResponse(200, { success: true, data: {} }));
  try {
    await assert.rejects(
      () => parsePdfWithFirecrawl({
        apiKey: "fc-test-key",
        fileName: "one.pdf",
        pdfBytes: onePagePdf,
        mode: "fast",
        pageCount: 1,
        timeoutMs: 30000,
      }),
      /data\.markdown/,
    );
  } finally {
    malformedMock.restore();
  }
});

test("Firecrawl client aborts a success body that exceeds the remote response cap", async () => {
  const onePagePdf = await createPdf(1);
  const oversized = "x".repeat(FIRECRAWL_RESPONSE_CAP + 1);
  const mock = installMockFetch(() => new Response(oversized, { status: 200 }));
  try {
    await assert.rejects(
      () => parsePdfWithFirecrawl({
        apiKey: "fc-test-key",
        fileName: "one.pdf",
        pdfBytes: onePagePdf,
        mode: "auto",
        pageCount: 1,
        timeoutMs: 30000,
      }),
      (error) => error?.code === "RESPONSE_TOO_LARGE",
    );
    assert.equal(mock.calls.length, 1);
  } finally {
    mock.restore();
  }
});

// Tool behavior and contract

test("parse registration and schema are strict and parent-only", () => {
  const tools = new Map();
  registerParseTool({ registerTool: (definition) => tools.set(definition.name, definition) });
  const definition = tools.get("parse");
  assert.ok(definition);
  assert.equal(definition.parameters.type, "object");
  assert.equal(definition.parameters.additionalProperties, false);
  assert.equal(definition.parameters.anyOf, undefined);
  assert.deepEqual(definition.parameters.required.sort(), ["pages", "path"]);
  assert.deepEqual(definition.parameters.properties.mode.enum, ["fast", "auto", "ocr"]);
  assert.equal(definition.parameters.properties.timeout.maximum, 300000);
  assert.equal(definition.parameters.properties.max_tokens.maximum, 50000);
  assert.equal(definition.renderShell, undefined);
  assert.equal(definition.renderCall, undefined);
  assert.equal(definition.renderResult, undefined);
});

test("parse fails before file or network access when pre-cancelled, non-interactive, or missing a key", async () => {
  let called = false;
  const controller = new AbortController();
  controller.abort();
  const preCancelled = createParseToolDefinition({
    resolveApiKey: () => "fc-test-key",
    parsePdf: async () => { called = true; throw new Error("unreachable"); },
  });
  const preCancelledResult = await preCancelled.execute(
    "t",
    { path: "missing.pdf", pages: "1" },
    controller.signal,
    undefined,
    { cwd: workspace, hasUI: false },
  );
  assert.equal(preCancelledResult.details.errorCode, "ABORTED");

  const noUi = createParseToolDefinition({
    resolveApiKey: () => "fc-test-key",
    parsePdf: async () => { called = true; throw new Error("unreachable"); },
  });
  const noUiResult = await noUi.execute("t", { path: "missing.pdf", pages: "1" }, undefined, undefined, { cwd: workspace, hasUI: false });
  assert.equal(noUiResult.details.errorCode, "CONFIRMATION_UNAVAILABLE");
  assert.equal(called, false);

  const noKey = createParseToolDefinition({
    resolveApiKey: () => null,
    parsePdf: async () => { called = true; throw new Error("unreachable"); },
  });
  const noKeyResult = await noKey.execute(
    "t",
    { path: "missing.pdf", pages: "1" },
    undefined,
    undefined,
    interactiveContext(async () => true),
  );
  assert.equal(noKeyResult.details.errorCode, "MISSING_FIRECRAWL_API_KEY");
  assert.equal(called, false);
});

test("parse validates the PDF and page bounds before opening confirmation", async () => {
  let confirmations = 0;
  let calls = 0;
  const tool = createParseToolDefinition({
    resolveApiKey: () => "fc-test-key",
    parsePdf: async () => { calls++; return { markdown: "x", metadata: {} }; },
  });
  const encrypted = await tool.execute(
    "t",
    { path: "encrypted.pdf", pages: "1" },
    undefined,
    undefined,
    interactiveContext(async () => { confirmations++; return true; }),
  );
  assert.equal(encrypted.details.errorCode, "ENCRYPTED_PDF");

  const outOfRange = await tool.execute(
    "t",
    { path: "sample.pdf", pages: "26" },
    undefined,
    undefined,
    interactiveContext(async () => { confirmations++; return true; }),
  );
  assert.equal(outOfRange.details.errorCode, "PAGE_OUT_OF_RANGE");
  assert.equal(confirmations, 0);
  assert.equal(calls, 0);
});

test("parse decline stops before extraction upload and explains standard retention", async () => {
  let calls = 0;
  let confirmation;
  const tool = createParseToolDefinition({
    resolveApiKey: () => "fc-test-key",
    parsePdf: async () => { calls++; return { markdown: "x", metadata: {} }; },
  });
  const result = await tool.execute(
    "t",
    { path: "sample.pdf", pages: "6, 1-4, 3, 20-22", mode: "ocr" },
    undefined,
    undefined,
    interactiveContext(async (title, message) => {
      confirmation = { title, message };
      return false;
    }),
  );
  assert.equal(result.details.status, "declined");
  assert.equal(result.isError, undefined);
  assert.equal(calls, 0);
  assert.match(confirmation.title, /Firecrawl/);
  assert.match(confirmation.message, /Pages: 1-4, 6, 20-22 \(8 of 25\)/);
  assert.match(confirmation.message, /Zero Data Retention is disabled/);
  assert.equal(confirmation.message.includes("fc-test-key"), false);
});

test("parse uploads sorted selected pages once, bounds output, and redacts the current key", async () => {
  const updates = [];
  let request;
  const tool = createParseToolDefinition({
    resolveApiKey: () => "fc-current-secret",
    parsePdf: async (options) => {
      request = options;
      const uploaded = await PDFDocument.load(options.pdfBytes);
      assert.deepEqual(uploaded.getPages().map((page) => page.getWidth()), [101, 102, 103, 104, 106, 120, 121, 122]);
      return {
        markdown: `# Result\n\nfc-current-secret\n\n${"long content ".repeat(1000)}`,
        metadata: { title: "fc-current-secret", sourceFile: "fc-current-secret.pdf", numPages: 8, totalPages: 8 },
        warning: "token fc-current-secret was removed",
      };
    },
  });
  const result = await tool.execute(
    "t",
    { path: "sample.pdf", pages: "6, 1-4, 3, 20-22", max_tokens: 500 },
    undefined,
    (value) => updates.push(value),
    interactiveContext(async () => true),
  );
  assert.equal(result.details.status, "success");
  assert.deepEqual(result.details.pages, [1, 2, 3, 4, 6, 20, 21, 22]);
  assert.equal(result.details.normalizedPages, "1-4, 6, 20-22");
  assert.equal(result.details.pageCount, 8);
  assert.equal(result.details.sourceTotalPages, 25);
  assert.equal(result.details.truncated, true);
  assert.equal(result.details.metadata.title, "[REDACTED]");
  assert.equal(result.content[0].text.includes("fc-current-secret"), false);
  assert.match(result.content[0].text, /Output truncated locally/);
  assert.ok(result.content[0].text.length <= 2000);
  assert.equal(request.pageCount, 8);
  assert.equal(request.mode, "auto");
  assert.equal(request.timeoutMs, 30000);
  assert.deepEqual(updates.map((update) => update.details.phase), ["confirming", "extracting", "uploading"]);
});

test("parse cancellation at confirmation prevents Firecrawl upload", async () => {
  const controller = new AbortController();
  let calls = 0;
  const tool = createParseToolDefinition({
    resolveApiKey: () => "fc-test-key",
    parsePdf: async () => { calls++; return { markdown: "unreachable", metadata: {} }; },
  });
  const result = await tool.execute(
    "t",
    { path: "sample.pdf", pages: "1" },
    controller.signal,
    undefined,
    interactiveContext(async () => {
      controller.abort();
      return true;
    }),
  );
  assert.equal(result.details.status, "aborted");
  assert.equal(result.details.errorCode, "ABORTED");
  assert.equal(result.isError, true);
  assert.equal(calls, 0);
});

test("parse redacts Firecrawl errors and returns one stable HTTP error code", async () => {
  const mock = installMockFetch(() => jsonResponse(402, { error: "payment failed for fc-current-secret" }));
  try {
    const tool = createParseToolDefinition({ resolveApiKey: () => "fc-current-secret" });
    const result = await tool.execute(
      "t",
      { path: "sample.pdf", pages: "1" },
      undefined,
      undefined,
      interactiveContext(async () => true),
    );
    assert.equal(result.details.errorCode, "FIRECRAWL_HTTP_402");
    assert.equal(result.content[0].text.includes("fc-current-secret"), false);
    assert.equal(result.isError, true);
    assert.equal(mock.calls.length, 1);
  } finally {
    mock.restore();
  }
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
  console.log(`\n${tests.length} parse tool tests passed`);
} finally {
  rmSync(workspace, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
}
