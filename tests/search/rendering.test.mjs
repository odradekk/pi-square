import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { fileURLToPath } from "node:url";

import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import jiti from "jiti";

import { run, test } from "./lib/test-helpers.mjs";

initTheme();

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const load = jiti(import.meta.url, { moduleCache: true });
async function loadModule(relativePath) {
  return load(resolve(packageRoot, relativePath));
}

const NOOP = async () => {};
const NO_CONTEXT = { lastComponent: undefined };
const plainTheme = {
  fg(_color, text) {
    return String(text);
  },
  bold(text) {
    return String(text);
  },
};
const ansiTheme = {
  fg(color, text) {
    const codes = { accent: 35, dim: 2, error: 31, muted: 2, success: 32, text: 37, toolOutput: 37, toolTitle: 36, warning: 33 };
    return `\x1b[${codes[color] ?? 37}m${String(text)}\x1b[0m`;
  },
  bold(text) {
    return `\x1b[1m${String(text)}\x1b[22m`;
  },
};

function definition(module, name) {
  return module[name]({ resolveBinary: NOOP, runCommand: NOOP });
}

async function setToolCapabilities(hyperlinks) {
  const tui = await loadModule("node_modules/@earendil-works/pi-tui/dist/index.js");
  tui.setCapabilities({ images: null, trueColor: false, hyperlinks });
}

function rendered(component, width = 100) {
  return component.render(width);
}

function plain(component, width = 100) {
  return rendered(component, width).map((line) => stripVTControlCharacters(line)).join("\n");
}

function assertWidth(component, width) {
  for (const line of rendered(component, width)) {
    assert.ok(visibleWidth(line) <= width, `line width ${visibleWidth(line)} exceeds ${width}: ${JSON.stringify(line)}`);
  }
}

function rgDetails(overrides = {}) {
  return {
    page: { offset: 0, limit: 5, returned: 1, hasMore: true, nextOffset: 1, total: 3 },
    truncation: { lineExcerpts: 1, contextLinesOmitted: 0, contentBudgetReached: false },
    binary: "/bin/rg",
    stderrTruncated: false,
    presentation: { version: 1, executionCwd: "/repo", platform: "linux" },
    files: [{
      path: "src/a b.ts",
      pathEncoding: "text",
      lines: [
        { kind: "match", line: 12, column: 4, text: "let target = 1", textEncoding: "text", display: { text: "let target = 1", highlights: [{ start: 4, end: 10 }], excerpted: false } },
        { kind: "context", line: 13, text: "return target", textEncoding: "text", display: { text: "return target", highlights: [], excerpted: false } },
      ],
      continuation: { omitted: 2, nextOffset: 1 },
    }],
    ...overrides,
  };
}

function fdDetails(overrides = {}) {
  return {
    page: { offset: 0, limit: 5, returned: 2, hasMore: true, nextOffset: 2, total: 8 },
    truncation: { lineExcerpts: 0, contextLinesOmitted: 0, contentBudgetReached: false },
    binary: "/bin/fd",
    stderrTruncated: false,
    presentation: { version: 1, executionCwd: "/repo", platform: "linux" },
    paths: [
      { displayPath: "src/alpha.ts", encoding: "text", path: "src/alpha.ts" },
      { displayPath: "tests/beta.ts", encoding: "text", path: "tests/beta.ts" },
    ],
    ...overrides,
  };
}

test("rg and fd keep the default Pi shell and define native renderers", async () => {
  const rgModule = await loadModule("src/search/tools/rg.ts");
  const fdModule = await loadModule("src/search/tools/fd.ts");
  for (const def of [definition(rgModule, "createRgToolDefinition"), definition(fdModule, "createFdToolDefinition")]) {
    assert.equal(typeof def.renderCall, "function");
    assert.equal(typeof def.renderResult, "function");
    assert.equal(def.renderShell, undefined);
  }
});

test("rg renderCall shows every explicit argument, including false, zero, and arrays", async () => {
  const rgModule = await loadModule("src/search/tools/rg.ts");
  const def = definition(rgModule, "createRgToolDefinition");
  const args = {
    pattern: "target",
    path: "src",
    case: "smart",
    literal: false,
    word: true,
    hidden: false,
    noIgnore: true,
    offset: 0,
    limit: 10,
    includeGlobs: ["*.ts", "*.tsx"],
    excludeGlobs: ["vendor/**"],
    types: ["ts"],
    beforeContext: 0,
    afterContext: 2,
    maxDepth: 0,
  };
  const component = def.renderCall(args, plainTheme, NO_CONTEXT);
  const output = plain(component, 240);
  for (const expected of [
    "rg target in src", "case=smart", "literal=false", "word=true", "hidden=false", "noIgnore=true",
    "offset=0", "limit=10", "includeGlobs=[*.ts, *.tsx]", "excludeGlobs=[vendor/**]", "types=[ts]",
    "beforeContext=0", "afterContext=2", "maxDepth=0",
  ]) assert.ok(output.includes(expected), `missing ${expected}`);
  assert.equal(def.renderCall({ pattern: "next" }, plainTheme, { lastComponent: component }), component);
});

test("fd renderCall shows every explicit filter and omits unspecified defaults", async () => {
  const fdModule = await loadModule("src/search/tools/fd.ts");
  const def = definition(fdModule, "createFdToolDefinition");
  const args = {
    pattern: "*.ts",
    path: "src",
    case: "insensitive",
    hidden: false,
    noIgnore: true,
    offset: 0,
    limit: 12,
    matchMode: "glob",
    types: ["file", "symlink"],
    extensions: ["ts", ".tsx"],
    excludeGlobs: ["vendor/**"],
    minDepth: 0,
    maxDepth: 4,
  };
  const output = plain(def.renderCall(args, plainTheme, NO_CONTEXT), 240);
  for (const expected of [
    "fd *.ts in src", "case=insensitive", "hidden=false", "noIgnore=true", "offset=0", "limit=12",
    "matchMode=glob", "types=[file, symlink]", "extensions=[ts, .tsx]", "excludeGlobs=[vendor/**]",
    "minDepth=0", "maxDepth=4",
  ]) assert.ok(output.includes(expected), `missing ${expected}`);

  const minimal = plain(def.renderCall({ pattern: "name" }, plainTheme, NO_CONTEXT), 80);
  assert.equal(minimal.includes("limit="), false);
  assert.equal(minimal.includes("case="), false);
});

test("collapsed rg and fd results show summaries without previews", async () => {
  const rgModule = await loadModule("src/search/tools/rg.ts");
  const fdModule = await loadModule("src/search/tools/fd.ts");
  const rg = definition(rgModule, "createRgToolDefinition");
  const fd = definition(fdModule, "createFdToolDefinition");
  const rgOutput = plain(rg.renderResult({ content: [{ type: "text", text: "secret preview" }], details: rgDetails() }, { expanded: false, isPartial: false }, plainTheme));
  assert.ok(rgOutput.includes("1 match in 1 file"));
  assert.ok(rgOutput.includes("3 total"));
  assert.ok(rgOutput.includes("next 1"));
  assert.ok(rgOutput.includes("1 line excerpts"));
  assert.ok(rgOutput.includes("to expand"));
  assert.equal(rgOutput.includes("secret preview"), false);

  const fdOutput = plain(fd.renderResult({ content: [{ type: "text", text: "hidden/path" }], details: fdDetails() }, { expanded: false, isPartial: false }, plainTheme));
  assert.ok(fdOutput.includes("2 paths"));
  assert.ok(fdOutput.includes("8 total"));
  assert.ok(fdOutput.includes("next 2"));
  assert.equal(fdOutput.includes("hidden/path"), false);
});

test("expanded rg groups files, aligns gutters, highlights matches, and reports continuation", async () => {
  await setToolCapabilities(true);
  const rgModule = await loadModule("src/search/tools/rg.ts");
  const def = definition(rgModule, "createRgToolDefinition");
  const component = def.renderResult({ content: [{ type: "text", text: "stable model text" }], details: rgDetails() }, { expanded: true, isPartial: false }, ansiTheme);
  const raw = rendered(component, 80).join("\n");
  const output = stripVTControlCharacters(raw);
  assert.ok(output.includes("src/a b.ts"));
  assert.ok(output.includes("12:4 │ let target = 1"));
  assert.ok(output.includes("13   │ return target"));
  assert.ok(output.includes("2 omitted · continue at offset 1"));
  assert.ok(output.includes("More results available at offset 1"));
  assert.ok(raw.includes("\x1b]8;;file:///repo/src/a%20b.ts"), "valid textual path should be linked");
  assert.ok(raw.includes("\x1b[35m\x1b[1mtarget"), "match segment should be accented and bold");
});

test("expanded fd emphasizes paths and creates safe local links", async () => {
  await setToolCapabilities(true);
  const fdModule = await loadModule("src/search/tools/fd.ts");
  const def = definition(fdModule, "createFdToolDefinition");
  const raw = rendered(def.renderResult({ content: [{ type: "text", text: "stable" }], details: fdDetails() }, { expanded: true, isPartial: false }, ansiTheme), 80).join("\n");
  const output = stripVTControlCharacters(raw);
  assert.ok(output.includes("src/alpha.ts"));
  assert.ok(output.includes("tests/beta.ts"));
  assert.ok(output.includes("More results available at offset 2"));
  assert.ok(raw.includes("\x1b]8;;file:///repo/src/alpha.ts"));
});

test("rg byte displays retain escaped identity and byte-token highlighting", async () => {
  await setToolCapabilities(true);
  const rgModule = await loadModule("src/search/tools/rg.ts");
  const def = definition(rgModule, "createRgToolDefinition");
  const details = rgDetails({
    page: { offset: 0, limit: 5, returned: 1, hasMore: false, nextOffset: null, total: 1 },
    files: [{
      path: "bad/\\xff.ts",
      pathEncoding: "bytes",
      rawPathBase64: "YmFkL/8udHM=",
      lines: [{
        kind: "match",
        line: 1,
        column: 1,
        text: "�A",
        textEncoding: "bytes",
        rawTextBase64: "/0E=",
        display: { text: "\\xffA", highlights: [{ start: 0, end: 4 }], excerpted: false },
      }],
    }],
  });
  const raw = rendered(def.renderResult({ content: [{ type: "text", text: "stable" }], details }, { expanded: true, isPartial: false }, ansiTheme), 80).join("\n");
  assert.ok(stripVTControlCharacters(raw).includes("bad/\\xff.ts"));
  assert.ok(stripVTControlCharacters(raw).includes("\\xffA"));
  assert.ok(raw.includes("\x1b[35m\x1b[1m\\xff"));
  assert.equal(raw.includes("\x1b]8;;"), false);
});

test("valid paths remain plain when terminal hyperlinks are unavailable", async () => {
  await setToolCapabilities(false);
  const fdModule = await loadModule("src/search/tools/fd.ts");
  const def = definition(fdModule, "createFdToolDefinition");
  const raw = rendered(def.renderResult({ content: [{ type: "text", text: "stable" }], details: fdDetails() }, { expanded: true, isPartial: false }, ansiTheme), 80).join("\n");
  assert.equal(raw.includes("\x1b]8;;"), false);
  assert.ok(stripVTControlCharacters(raw).includes("src/alpha.ts"));
});

test("byte paths and UNC paths remain inert while escaped bytes stay visible", async () => {
  await setToolCapabilities(true);
  const fdModule = await loadModule("src/search/tools/fd.ts");
  const def = definition(fdModule, "createFdToolDefinition");
  const details = fdDetails({
    page: { offset: 0, limit: 5, returned: 3, hasMore: false, nextOffset: null, total: 3 },
    paths: [
      { displayPath: "bad/\\xff.ts", encoding: "bytes", rawBase64: "YmFkL/8udHM=" },
      { displayPath: "//server/share/file.ts", encoding: "text", path: "//server/share/file.ts" },
      { displayPath: "safe/control-name.ts", encoding: "text", path: "safe/\x1bname.ts" },
    ],
  });
  const raw = rendered(def.renderResult({ content: [{ type: "text", text: "stable" }], details }, { expanded: true, isPartial: false }, ansiTheme), 100).join("\n");
  const output = stripVTControlCharacters(raw);
  assert.ok(output.includes("bad/\\xff.ts"));
  assert.ok(output.includes("//server/share/file.ts"));
  assert.equal(raw.includes("\x1b]8;;"), false);
});

test("legacy details fall back to complete sanitized content", async () => {
  const rgModule = await loadModule("src/search/tools/rg.ts");
  const def = definition(rgModule, "createRgToolDefinition");
  const details = rgDetails();
  delete details.presentation;
  const legacyText = "rg returned=1\nfile: old.ts\n> 1:1 | before\x1b]8;;https://evil.example\x07owned\x1b]8;;\x07after";
  const output = plain(def.renderResult({ content: [{ type: "text", text: legacyText }], details }, { expanded: true, isPartial: false }, plainTheme), 100);
  assert.ok(output.includes("rg returned=1"));
  assert.ok(output.includes("beforeownedafter"));
  assert.equal(output.includes("evil.example"), false);
});

test("partial and empty results are concise and not expandable", async () => {
  const rgModule = await loadModule("src/search/tools/rg.ts");
  const fdModule = await loadModule("src/search/tools/fd.ts");
  const rg = definition(rgModule, "createRgToolDefinition");
  const fd = definition(fdModule, "createFdToolDefinition");
  assert.ok(plain(rg.renderResult({}, { expanded: false, isPartial: true }, plainTheme)).includes("Searching"));
  assert.ok(plain(fd.renderResult({}, { expanded: false, isPartial: true }, plainTheme)).includes("Finding paths"));

  const emptyRg = rgDetails({ page: { offset: 0, limit: 5, returned: 0, hasMore: false, nextOffset: null, total: 0 }, files: [] });
  const emptyFd = fdDetails({ page: { offset: 0, limit: 5, returned: 0, hasMore: false, nextOffset: null, total: 0 }, paths: [] });
  const rgOutput = plain(rg.renderResult({ content: [{ type: "text", text: "No matches found" }], details: emptyRg }, { expanded: false, isPartial: false }, plainTheme));
  const fdOutput = plain(fd.renderResult({ content: [{ type: "text", text: "No paths found" }], details: emptyFd }, { expanded: false, isPartial: false }, plainTheme));
  assert.ok(rgOutput.includes("No matches"));
  assert.ok(fdOutput.includes("No paths"));
  assert.equal(rgOutput.includes("to expand"), false);
  assert.equal(fdOutput.includes("to expand"), false);
});

test("rendering escapes terminal controls before applying trusted styles", async () => {
  const renderModule = await loadModule("src/search/render.ts");
  assert.equal(renderModule.sanitizeSearchLine("a\x1b]0;owned\x07b\x00\x85\nc"), "ab\\x00\\x85\\nc");
  assert.equal(renderModule.sanitizeSearchMultiline("a\x1b]0;owned\x07b\x00\n c"), "ab\\x00\n c");
});

test("rg and fd render within 40, 80, and 120 columns", async () => {
  await setToolCapabilities(false);
  const rgModule = await loadModule("src/search/tools/rg.ts");
  const fdModule = await loadModule("src/search/tools/fd.ts");
  const rg = definition(rgModule, "createRgToolDefinition");
  const fd = definition(fdModule, "createFdToolDefinition");
  const longLine = "long readable source segment ".repeat(15);
  const details = rgDetails({
    files: [{
      path: "very/long/directory/name/source-file.ts",
      pathEncoding: "text",
      lines: [{ kind: "match", line: 12345, column: 120, text: longLine, textEncoding: "text", display: { text: longLine, highlights: [{ start: 5, end: 13 }], excerpted: true } }],
    }],
  });
  for (const width of [40, 80, 120]) {
    assertWidth(rg.renderResult({ content: [{ type: "text", text: "stable" }], details }, { expanded: true, isPartial: false }, ansiTheme), width);
    assertWidth(fd.renderResult({ content: [{ type: "text", text: "stable" }], details: fdDetails() }, { expanded: true, isPartial: false }, ansiTheme), width);
  }
});

await run();
