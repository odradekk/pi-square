import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { createReadToolDefinition } from "@earendil-works/pi-coding-agent";
import jiti from "jiti";

const load = jiti(import.meta.url, { moduleCache: false });
const { DEFAULT_CONFIG } = await load("../../src/core/config.ts");
const { DisplayController } = await load("../../src/display/index.ts");
const { default: registerDisplayBuiltins } = await load("../../src/display/builtins.ts");
const { default: registerAnchoredReplace } = await load("../../src/anchored-edit/workspace-replace.ts");
const { default: registerAnchoredRevert } = await load("../../src/anchored-edit/workspace-revert.ts");

const OWN = { path: "/package/src/index.ts", source: "@odradekk/pi-square", scope: "user", origin: "package" };
const BUILTIN = { path: "<builtin>", source: "built-in", scope: "temporary", origin: "top-level" };
const PROBES = ["pdf_search", "codegraph", "delegate", "todo"];
const BUILTINS = ["read", "grep", "find", "ls", "edit", "write", "bash"];

function createHarness(config) {
  const events = new Map();
  const definitions = new Map();
  let active = ["read", "edit", "write"];
  const pi = {
    registerTool(definition) {
      definitions.set(definition.name, definition);
      if (!active.includes(definition.name)) active.push(definition.name);
    },
    on(name, handler) {
      const handlers = events.get(name) ?? [];
      handlers.push(handler);
      events.set(name, handlers);
    },
    getActiveTools() { return [...active]; },
    setActiveTools(names) { active = [...names]; },
    getAllTools() {
      return [
        ...PROBES.map((name) => ({ name, description: "", parameters: {}, sourceInfo: OWN })),
        ...BUILTINS.map((name) => ({ name, description: "", parameters: {}, sourceInfo: definitions.has(name) ? OWN : BUILTIN })),
      ];
    },
  };
  const controller = new DisplayController(config);
  let anchoredReadAvailable = false;
  registerDisplayBuiltins(pi, controller, (available) => { anchoredReadAvailable = available; });
  registerAnchoredReplace(pi, () => controller.config, () => controller.runtime, () => anchoredReadAvailable);
  registerAnchoredRevert(pi, () => controller.config, () => controller.runtime, () => anchoredReadAvailable);
  return { events, definitions, controller, activeTools: () => pi.getActiveTools() };
}

async function start(harness, cwd) {
  for (const handler of harness.events.get("session_start") ?? []) {
    await handler({ type: "session_start", reason: "startup" }, {
      cwd,
      hasUI: false,
      isProjectTrusted() { return false; },
      ui: { setStatus() {} },
    });
  }
}

const root = mkdtempSync(join(tmpdir(), "pi-square-anchored-read-"));
const workspace = join(root, "workspace");
const agentDir = join(root, "agent");
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
mkdirSync(workspace, { recursive: true });
mkdirSync(agentDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;
writeFileSync(join(workspace, "source.txt"), "same\nsame\nthird");
writeFileSync(join(workspace, "pages.txt"), "one\ntwo\nthree\nfour\nfive");
writeFileSync(join(workspace, "empty.txt"), "");
writeFileSync(join(workspace, "binary.pdf"), Buffer.from("%PDF-1.7\n%\u0080\u0081\n1 0 obj\n<<>>\nendobj\n", "binary"));
writeFileSync(join(workspace, "tiff.bin"), Buffer.concat([
  Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00]),
  Buffer.alloc(24),
]));
writeFileSync(join(workspace, "loose-signature.txt"), "BMW is a car company\nsecond line\n");
writeFileSync(join(workspace, "too-many-lines.txt"), "\n".repeat(238329));
writeFileSync(join(workspace, "utf16.txt"), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("one\ntwo", "utf16le")]));
writeFileSync(join(workspace, "long.txt"), `${"x".repeat(201 * 1024)}\nshort`);
writeFileSync(join(workspace, "pixel.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
mkdirSync(join(workspace, "directory"));
mkdirSync(join(root, "external-dir"));
writeFileSync(join(root, ".outside-home.txt"), "from home");

try {
  const args = { path: "source.txt" };
  const factory = createReadToolDefinition(workspace);
  const expected = await factory.execute("factory", args, undefined, undefined, { cwd: workspace });

  const disabledConfig = { ...DEFAULT_CONFIG, anchoredEditing: { enabled: false, autoRead: true } };
  const off = createHarness(disabledConfig);
  await start(off, workspace);
  const offResult = await off.definitions.get("read").execute("off", args, undefined, undefined, { cwd: workspace });
  assert.deepEqual(offResult.content, expected.content, "explicitly disabled read stays byte-identical to Pi");
  assert.equal(existsSync(join(workspace, ".pi", "anchored-edit", "hash-store.sqlite")), false, "explicitly disabled read creates no anchored state");
  assert.equal(off.definitions.get("replace"), undefined, "explicitly disabled anchored editing registers no replace tool");
  assert.equal(off.definitions.get("revert"), undefined, "explicitly disabled anchored editing registers no revert tool");
  assert.ok(off.activeTools().includes("edit"), "explicitly disabled editing keeps Pi edit active");
  assert.deepEqual(off.activeTools(), ["read", "edit", "write"], "explicitly disabled editing preserves the complete active-tool baseline");
  off.controller.dispose();

  const marker = Symbol.for("pi-tool-display.api.v1");
  const previousMarker = Object.getOwnPropertyDescriptor(globalThis, marker);
  Object.defineProperty(globalThis, marker, { configurable: true, value: {} });
  const conflicted = createHarness({ ...DEFAULT_CONFIG, anchoredEditing: { enabled: true } });
  try {
    await start(conflicted, workspace);
    assert.equal(conflicted.definitions.get("replace"), undefined, "replace is unavailable when the anchored read override is blocked");
    assert.equal(conflicted.definitions.get("revert"), undefined, "revert is unavailable when the anchored read override is blocked");
    assert.ok(conflicted.activeTools().includes("edit"), "a blocked anchored read keeps Pi edit active");
  } finally {
    conflicted.controller.dispose();
    if (previousMarker) Object.defineProperty(globalThis, marker, previousMarker);
    else delete globalThis[marker];
  }

  const on = createHarness(DEFAULT_CONFIG);
  await start(on, workspace);
  const replace = on.definitions.get("replace");
  const revert = on.definitions.get("revert");
  assert.ok(replace, "default anchored editing registers replace");
  assert.ok(revert, "default anchored editing registers revert");
  assert.equal(revert.renderShell, "self", "revert uses the shared operational display shell");
  assert.equal(typeof revert.renderCall, "function", "revert renders through the production decoration path");
  assert.equal(typeof revert.renderResult, "function", "revert renders results through the production decoration path");
  assert.equal(replace.renderShell, "self", "replace uses the shared operational display shell");
  assert.equal(typeof replace.renderCall, "function", "replace renders through the production decoration path");
  assert.equal(typeof replace.renderResult, "function", "replace renders results through the production decoration path");
  assert.ok(!on.activeTools().includes("edit"), "default anchored editing removes Pi edit from the active parent tools");
  const read = on.definitions.get("read");
  assert.ok(read.promptGuidelines.some((guideline) => /Do not invent anchors/.test(guideline)));
  assert.ok(read.promptGuidelines.some((guideline) => /same paths as Pi's built-in read/.test(guideline)), "the parent guideline states native path authority");
  const first = await read.execute("first", args, undefined, undefined, { cwd: workspace });
  const second = await read.execute("second", args, undefined, undefined, { cwd: workspace });
  assert.equal(first.content[0].text, second.content[0].text, "unchanged files keep anchors across reads");
  const rows = first.content[0].text.split("\n").slice(0, 3);
  const matches = rows.map((row) => /^([A-Za-z0-9]{3})│/.exec(row));
  assert.ok(matches.every(Boolean), "every returned source row has a three-character anchor");
  assert.notEqual(matches[0][1], matches[1][1], "byte-identical lines have distinct anchors");
  assert.ok(existsSync(join(workspace, ".pi", "anchored-edit", "hash-store.sqlite")), "anchors persist in the project store");

  const firstAnchors = matches.map((match) => match[1]);
  writeFileSync(join(workspace, "source.txt"), "same  \nsame\t\nthird  ");
  const whitespaceOnly = await read.execute("whitespace", args, undefined, undefined, { cwd: workspace });
  const whitespaceAnchors = whitespaceOnly.content[0].text.split("\n").slice(0, 3).map((row) => /^([A-Za-z0-9]{3})│/.exec(row)?.[1]);
  assert.deepEqual(whitespaceAnchors, firstAnchors, "trailing whitespace-only changes preserve anchors");

  const paged = await read.execute("page", { path: "pages.txt", offset: 2, limit: 2 }, undefined, undefined, { cwd: workspace });
  assert.match(paged.content[0].text, /^[A-Za-z0-9]{3}│two\n[A-Za-z0-9]{3}│three\n\n\[Showing lines 2-3 of 5\./);

  const empty = await read.execute("empty", { path: "empty.txt" }, undefined, undefined, { cwd: workspace });
  assert.match(empty.content[0].text, /File is empty/, "empty files give a specific response");

  const directory = await read.execute("directory", { path: "directory" }, undefined, undefined, { cwd: workspace });
  assert.match(directory.content[0].text, /Path is a directory.*Use ls/s, "directories have a usable alternative");

  // ── Native path authority (#185): the parent anchored read accepts the
  // same paths as Pi 0.84.2's native read, with no workspace-containment
  // refusal. External targets keep the initiating workspace's store.
  writeFileSync(join(root, "outside.txt"), "outside\nsecond");
  const outside = await read.execute("outside", { path: "../outside.txt" }, undefined, undefined, { cwd: workspace });
  assert.match(outside.content[0].text, /^[A-Za-z0-9]{3}│outside$/m, "a ../ path outside the workspace reads with anchors");

  const absolute = await read.execute("absolute", { path: join(root, "outside.txt") }, undefined, undefined, { cwd: workspace });
  assert.match(absolute.content[0].text, /^[A-Za-z0-9]{3}│outside$/m, "an absolute path outside the workspace reads with anchors");

  const previousHome = process.env.HOME;
  process.env.HOME = root;
  try {
    const homeRead = await read.execute("home", { path: "~/.outside-home.txt" }, undefined, undefined, { cwd: workspace });
    assert.match(homeRead.content[0].text, /^[A-Za-z0-9]{3}│from home$/m, "a ~ path expands to the home directory and reads with anchors");
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }

  symlinkSync(join(root, "outside.txt"), join(workspace, "linked.txt"));
  const linked = await read.execute("linked", { path: "linked.txt" }, undefined, undefined, { cwd: workspace });
  assert.match(linked.content[0].text, /^[A-Za-z0-9]{3}│outside$/m, "a workspace symlink to an external target reads its canonical content");

  const externalDirectory = await read.execute("external-directory", { path: "../external-dir" }, undefined, undefined, { cwd: workspace });
  assert.match(externalDirectory.content[0].text, /Path is a directory.*Use ls/s, "an external directory keeps the named directory response");

  await assert.rejects(
    () => factory.execute("factory-missing", { path: "../no-such-external.txt" }, undefined, undefined, { cwd: workspace }),
    (error) => error?.code === "ENOENT",
    "Pi's native read throws its own not-found for a missing external path",
  );
  await assert.rejects(
    () => read.execute("anchored-missing", { path: "../no-such-external.txt" }, undefined, undefined, { cwd: workspace }),
    (error) => error?.code === "ENOENT",
    "a missing external path preserves Pi's native not-found failure",
  );

  const binary = await read.execute("binary", { path: "binary.pdf" }, undefined, undefined, { cwd: workspace });
  assert.match(binary.content[0].text, /binary file/, "binary files are refused as text");

  const tiff = await read.execute("tiff", { path: "tiff.bin" }, undefined, undefined, { cwd: workspace });
  assert.match(tiff.content[0].text, /image\/tiff.*built-in read/s, "non-attachable image formats are refused as binary");

  const looseSignature = await read.execute("loose-signature", { path: "loose-signature.txt" }, undefined, undefined, { cwd: workspace });
  assert.match(looseSignature.content[0].text, /^[A-Za-z0-9]{3}│BMW is a car company/m, "text resembling a binary signature remains text");

  const tooManyLines = await read.execute("too-many-lines", { path: "too-many-lines.txt" }, undefined, undefined, { cwd: workspace });
  assert.match(tooManyLines.content[0].text, /E_FILE_TOO_LARGE.*use write/s, "over-limit files name the explicit write path");

  const utf16 = await read.execute("utf16", { path: "utf16.txt" }, undefined, undefined, { cwd: workspace });
  assert.match(utf16.content[0].text, /UTF-16LE encoded text.*built-in read/s, "UTF-16 files have a named alternative");

  const long = await read.execute("long", { path: "long.txt" }, undefined, undefined, { cwd: workspace });
  assert.match(long.content[0].text, /exceeds 200\.0KB/i, "long lines use a bounded response");

  const image = await read.execute("image", { path: "pixel.png" }, undefined, undefined, { cwd: workspace });
  assert.ok(image.content.some((part) => part.type === "image"), "supported images retain Pi attachments");

  const storePath = join(workspace, ".pi", "anchored-edit", "hash-store.sqlite");
  const store = new DatabaseSync(storePath, { timeout: 500 });
  try {
    assert.deepEqual(store.prepare("SELECT DISTINCT owner FROM snapshots").all().map((row) => row.owner), ["parent"], "snapshots retain an owner dimension");
    assert.deepEqual(store.prepare("SELECT DISTINCT owner FROM served").all().map((row) => row.owner), ["parent"], "served rows retain an owner dimension");
    assert.ok(store.prepare("PRAGMA table_info(undo)").all().some((row) => row.name === "owner"), "revert records retain an owner dimension");
    const canonicalOutside = realpathSync(join(root, "outside.txt"));
    assert.ok(
      store.prepare("SELECT COUNT(*) AS count FROM served WHERE path = ?").get(canonicalOutside).count > 0,
      "external reads record served rows in the initiating workspace's store",
    );
    assert.ok(
      store.prepare("SELECT COUNT(*) AS count FROM snapshots WHERE path = ?").get(canonicalOutside).count > 0,
      "external reads record snapshot rows in the initiating workspace's store",
    );
  } finally {
    store.close();
  }

  writeFileSync(join(workspace, "removed.txt"), "removed");
  await read.execute("removed", { path: "removed.txt" }, undefined, undefined, { cwd: workspace });
  rmSync(join(workspace, "removed.txt"));
  const pruning = createHarness({ ...DEFAULT_CONFIG, anchoredEditing: { enabled: true } });
  await start(pruning, workspace);
  const prunedStore = new DatabaseSync(storePath, { timeout: 500 });
  try {
    const served = prunedStore.prepare("SELECT COUNT(*) AS count FROM served WHERE path LIKE ?").get("%/removed.txt");
    assert.equal(served.count, 0, "session start prunes state for removed files");
  } finally {
    prunedStore.close();
  }
  pruning.controller.dispose();

  const storeBytesBeforeDisable = readFileSync(storePath);
  on.controller.startSession(disabledConfig, { mode: "rpc" });
  await start(on, workspace);
  assert.ok(on.activeTools().includes("edit"), "a later disabled session restores Pi edit to the active parent tools");
  assert.ok(!on.activeTools().includes("replace"), "a later disabled session removes replace from the active parent tools");
  assert.ok(!on.activeTools().includes("revert"), "a later disabled session removes revert from the active parent tools");
  assert.deepEqual(on.activeTools(), ["read", "edit", "write"], "a later disabled session restores the complete active-tool baseline");
  assert.deepEqual(readFileSync(storePath), storeBytesBeforeDisable, "disabling anchored editing leaves the existing store untouched");
  on.controller.dispose();

  const corruptWorkspace = join(root, "corrupt-workspace");
  mkdirSync(join(corruptWorkspace, ".pi", "anchored-edit"), { recursive: true });
  writeFileSync(join(corruptWorkspace, "source.txt"), "healthy");
  writeFileSync(join(corruptWorkspace, ".pi", "anchored-edit", "hash-store.sqlite"), "not a database");
  const rebuilt = createHarness({ ...DEFAULT_CONFIG, anchoredEditing: { enabled: true } });
  const originalConsoleError = console.error;
  const healthErrors = [];
  console.error = (...values) => { healthErrors.push(values.join(" ")); };
  try {
    await start(rebuilt, corruptWorkspace);
  } finally {
    console.error = originalConsoleError;
  }
  assert.ok(healthErrors.some((message) => /failed to open, rebuilding/i.test(message)), "a failed health check is reported before rebuilding");
  const rebuiltResult = await rebuilt.definitions.get("read").execute("rebuilt", { path: "source.txt" }, undefined, undefined, { cwd: corruptWorkspace });
  assert.match(rebuiltResult.content[0].text, /^[A-Za-z0-9]{3}│healthy/, "a failed store health check rebuilds the store");
  assert.ok(readdirSync(join(corruptWorkspace, ".pi", "anchored-edit")).some((name) => name.startsWith("hash-store.sqlite.corrupt-")), "a failed store is quarantined");
  rebuilt.controller.dispose();

  console.log("anchored read integration tests: OK");
} finally {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(root, { recursive: true, force: true });
}
