import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { realpathSync } from "node:fs";
import { join } from "path";
import { beforeAll, afterAll, vi } from "vitest";
import { Compile } from "typebox/compile";
import { createReadToolDefinition, createWriteToolDefinition } from "@earendil-works/pi-coding-agent";
import { _lineHashesPure, initHasher } from "../../../src/anchored-edit/hashline";
import { anchoredHashStorePath, anchoredStoreDir } from "../../../src/anchored-edit/paths";
import { loadAnchoredHashStore, PARENT_OWNER } from "../../../src/anchored-edit/workspace-support";
import { withAnchoredReadTransform } from "../../../src/anchored-edit/read-tool";
import { transformAnchoredReadContent, guardAnchoredRead } from "../../../src/anchored-edit/read-transform";
import { createAnchoredReplaceToolDefinition } from "../../../src/anchored-edit/workspace-replace";
import { createParentAnchoredWrite, registerAnchoredAutoRead } from "../../../src/anchored-edit/auto-read";
import type { PiSquareConfig } from "../../../src/core/config";
import { loadHashStoreAt, shutdownHashStore, type HashStoreHandle } from "../../../src/anchored-edit/hash-store";
export async function getWritableTempRoot(): Promise<string> {
  const fallback = join(process.cwd(), ".tmp");
  await mkdir(fallback, { recursive: true });
  return fallback;
}
export async function setupTestHome(): Promise<{
  home: string;
  testPath: string;
  cleanup: () => Promise<void>;
}> {
  await initHasher();
  const tmpHome = await mkdtemp(join(await getWritableTempRoot(), "testhome-"));
  vi.stubEnv('HOME', tmpHome);
  vi.stubEnv('XDG_CONFIG_HOME', "");
  const testPath = join(tmpHome, "test.txt");
  return {
    home: tmpHome,
    testPath,
    cleanup: async () => {
      shutdownHashStore();
      vi.unstubAllEnvs();
      await rm(tmpHome, { recursive: true, force: true });
    },
  };
}
export function useTestHome(): { testPath: string } {
  const state: { testPath: string } = { testPath: "" };
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const s = await setupTestHome();
    state.testPath = s.testPath;
    cleanup = s.cleanup;
  });

  afterAll(async () => {
    await cleanup?.();
  });

  return state;
}

export function withHome(home: string | undefined): () => void {
  const previousHome = process.env.HOME;
  const previousXdg = process.env.XDG_CONFIG_HOME;
  if (home === undefined) delete process.env.HOME;
  else process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = "";
  return () => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdg;
  };
}

async function freshCwd(): Promise<{ cwd: string; restoreHome: () => void }> {
  const cwd = await mkdtemp(join(await getWritableTempRoot(), "pi-hashline-test-"));
  return { cwd, restoreHome: withHome(cwd) };
}

export async function withTempFile(
  name: string,
  content: string,
  run: (args: { cwd: string; path: string }) => Promise<void>,
): Promise<void> {
  const { cwd, restoreHome } = await freshCwd();
  const path = join(cwd, name);
  try {
    await writeFile(path, content, "utf-8");
    await run({ cwd, path });
  } finally {
    shutdownHashStore();
    await rm(cwd, { recursive: true, force: true });
    restoreHome();
  }
}

export async function withTempBytes(
  name: string,
  bytes: Uint8Array,
  run: (args: { cwd: string; path: string }) => Promise<void>,
): Promise<void> {
  const { cwd, restoreHome } = await freshCwd();
  const path = join(cwd, name);
  try {
    await writeFile(path, bytes);
    await run({ cwd, path });
  } finally {
    shutdownHashStore();
    await rm(cwd, { recursive: true, force: true });
    restoreHome();
  }
}

export async function withTempSubdir(
  name: string,
  run: (args: { cwd: string; path: string }) => Promise<void>,
): Promise<void> {
  const { cwd, restoreHome } = await freshCwd();
  const path = join(cwd, name);
  try {
    await mkdir(path, { recursive: true });
    await run({ cwd, path });
  } finally {
    shutdownHashStore();
    await rm(cwd, { recursive: true, force: true });
    restoreHome();
  }
}

export async function withTempDir(
  prefix: string,
  run: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(await getWritableTempRoot(), prefix));
  const restoreHome = withHome(dir);
  try {
    await run(dir);
  } finally {
    shutdownHashStore();
    await rm(dir, { recursive: true, force: true });
    restoreHome();
  }
}

export async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(await getWritableTempRoot(), prefix));
  process.env.HOME = dir;
  process.env.XDG_CONFIG_HOME = "";
  return dir;
}

/** Session directory convention for tool-level tests: every store and lock the
 * live surfaces create lands under `<cwd>/.test-session/`, so the existing
 * `rm(cwd, ...)` cleanups remove it with the temp workspace. */
export function testSessionDir(cwd: string): string {
  return join(cwd, ".test-session");
}

/** Fake execution context matching the session-resolved store contract: the
 * read wrapper and the replace definition resolve their session directory from
 * `ctx.sessionManager.getSessionDir()` at execution time. */
export function makeTestCtx(cwd: string) {
  return {
    cwd,
    sessionManager: {
      getSessionDir: () => testSessionDir(cwd),
      getSessionId: () => "test-session",
      getSessionFile: () => undefined,
    },
    ui: { notify() {} },
  } as any;
}

/** Anchor-store directory the live surfaces resolve for `makeTestCtx(cwd)`. */
export function testStoreDir(cwd: string): string {
  return anchoredStoreDir(testSessionDir(cwd), realpathSync(cwd));
}

/** A per-file scratch hash store for tests that exercise pathed
 * `lineHashes` calls (stable mapping), which now require an explicit store.
 * The store persists nothing the tests assert; it only satisfies the contract. */
export function useScratchStore(): { store: () => HashStoreHandle } {
  const state: { handle: HashStoreHandle | undefined } = { handle: undefined };
  let dir: string | undefined;
  beforeAll(async () => {
    dir = await mkdtemp(join(await getWritableTempRoot(), "scratch-store-"));
    state.handle = await loadHashStoreAt(join(dir, "hash-store.sqlite"), "parent");
  });
  afterAll(async () => {
    state.handle?.release();
    shutdownHashStore();
    if (dir) await rm(dir, { recursive: true, force: true });
  });
  return {
    store: () => {
      if (!state.handle) throw new Error("scratch store not initialized");
      return state.handle;
    },
  };
}

/** Hash-store database file the live parent surfaces resolve for `cwd`. */
export function anchoredStoreFile(cwd: string): string {
  return anchoredHashStorePath(testStoreDir(cwd));
}

/** Opens the same anchored hash store the live parent surfaces use for `cwd`
 * under the given owner partition. Callers must `release()` the handle. */
export async function loadTestStore(cwd: string, owner: string = PARENT_OWNER) {
  return loadAnchoredHashStore(testStoreDir(cwd), owner);
}

export function makeFakePiRegistry() {
  const tools = new Map<string, any>();
  return {
    pi: {
      registerTool(tool: any) {
        const originalExecute = tool.execute;
        const validator = Compile(tool.parameters);
        tool.execute = async function(
          toolCallId: string,
          params: unknown,
          signal: AbortSignal | undefined,
          onUpdate: unknown,
          ctx: unknown,
        ) {
          const prepared = tool.prepareArguments
            ? tool.prepareArguments(params)
            : params;
          if (!validator.Check(prepared)) {
            const errors = [...validator.Errors(prepared)]
              .map((e: any) => `  - ${e.message}`)
              .join("\n");
            const msg = "[E_BAD_SHAPE] Schema validation failed for tool \"" + tool.name + "\" after prepareArguments. The prepareArguments return value does not match the registered schema.\n" + errors;
            throw new Error(msg);
          }
          return originalExecute.call(this, toolCallId, prepared, signal, onUpdate, ctx);
        };
        tools.set(tool.name, tool);
      },
      registerCommand() {},
      on() {},
    } as any,
    getTool(name: string) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`Tool not registered: ${name}`);
      return tool;
    },
  };
}

/** The live parent anchored read: Pi's read factory wrapped by the shared
 * anchor transform and guard, exactly as `src/display/builtins.ts` composes it
 * (native path authority, session-resolved store). */
function anchoredReadDefinition(cwd: string) {
  return withAnchoredReadTransform(
    createReadToolDefinition(cwd),
    cwd,
    (content, value, executionCwd, sessionDir) =>
      transformAnchoredReadContent(content, value, executionCwd, PARENT_OWNER, { sessionDir }),
    (params, executionCwd) =>
      guardAnchoredRead(params, executionCwd),
  );
}

export function setupIntegrationTest(cwd: string) {
  const { pi, getTool } = makeFakePiRegistry();
  pi.registerTool(anchoredReadDefinition(cwd));
  pi.registerTool(createAnchoredReplaceToolDefinition(cwd, () => true, PARENT_OWNER, false));
  const ctx = makeTestCtx(cwd);
  return { pi, getTool, ctx, readTool: getTool("read"), editTool: getTool("replace") };
}

export function setupReadTest(cwd: string) {
  const { pi, getTool } = makeFakePiRegistry();
  pi.registerTool(anchoredReadDefinition(cwd));
  return { readTool: getTool("read"), ctx: makeTestCtx(cwd) };
}

export function getText(result: { content: Array<{ text?: string }> }): string {
  return result.content[0]?.text ?? "";
}

export function extractHash(line: string): string {
  return line.split("│")[0]!
}

export function expectedEditContent(
  lines: string[],
  s: number,
  e: number,
  repl: string[],
  trailingNewline: boolean,
): string {
  const expected = [...lines.slice(0, s - 1), ...repl, ...lines.slice(e)].join("\n");
  if (trailingNewline) return expected + "\n";
  if (e === lines.length && repl.length === 0 && s >= 2 && lines[s - 2]!.length === 0) {
    return expected + "\n";
  }
  return expected;
}

/** Deterministic hash for one line of content. Pure hashing: callers tag
 * content that was never persisted, so no store is involved. */
export async function makeTag(content: string, line: number): Promise<{ hash: string }> {
  const hashes = _lineHashesPure(content);
  return { hash: hashes[line - 1]! };
}

/** Composes the parent anchored write exactly as `src/index.ts` and
 * `src/display/builtins.ts` wire it (#264): Pi's public write factory with the
 * anchored write operation injected, plus the tool_call/tool_result appendix
 * presentation handlers. `runWrite` fires the full production flow. */
export function setupParentWrite(
  cwd: string,
  options: { autoRead?: boolean; enabled?: boolean; anchoredReadAvailable?: boolean } = {},
) {
  const autoRead = options.autoRead ?? true;
  const enabled = options.enabled ?? true;
  const available = options.anchoredReadAvailable ?? true;
  const config = () => ({ anchoredEditing: { enabled, autoRead } }) as PiSquareConfig;
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  const pi = {
    registerTool() {},
    registerCommand() {},
    on(event: string, handler: (...args: unknown[]) => Promise<unknown>) {
      handlers.set(event, handler);
    },
  } as any;
  const parentWrite = createParentAnchoredWrite(config);
  registerAnchoredAutoRead(pi, config, () => available, parentWrite);
  const sessionDir = testSessionDir(cwd);
  // The production parent write composition (#264): Pi's public write
  // factory with the anchored operation injected through its filesystem seam,
  // with the availability gate living inside the injected operation.
  const definition = createWriteToolDefinition(cwd, {
    operations: parentWrite.attachSession(cwd, sessionDir, () => available).operations,
  });
  const ctx = makeTestCtx(cwd);
  async function runWrite(
    toolCallId: string,
    params: { path: string; content: string },
    signal?: AbortSignal,
  ): Promise<{ content: Array<{ type: string; text: string }> } & Record<string, unknown>> {
    await handlers.get("tool_call")!(
      { toolName: "write", toolCallId, input: params },
      ctx,
    );
    const result = await definition.execute(toolCallId, params, signal, undefined, ctx);
    const patched = await handlers.get("tool_result")!(
      {
        toolName: "write",
        toolCallId,
        input: params,
        content: result.content,
        details: result.details,
        isError: false,
      },
      ctx,
    );
    return (patched ?? result) as { content: Array<{ type: string; text: string }> } & Record<string, unknown>;
  }
  return { pi, handlers, definition, runWrite };
}
