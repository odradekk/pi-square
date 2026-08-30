import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import jiti from "jiti";

const load = jiti(import.meta.url, { moduleCache: false });
const { DISPLAY_CATALOG } = await load("../../src/display/catalog.ts");
const { OperationalDisplayComponent } = await load("../../src/display/components.ts");
const { DEFAULT_DISPLAY_POLICY } = await load("../../src/display/types.ts");
const { elidePathMiddle, fitHeaderRow } = await load("../../src/display/layout.ts");
const { formatDisplayPath } = await load("../../src/display/adapter-utils.ts");
const { DEFAULT_CONFIG } = await load("../../src/core/config.ts");
const { DisplayRuntime } = await load("../../src/display/runtime.ts");
const { decorateInternalTool } = await load("../../src/display/internal-adapters.ts");
const { decorateBuiltinDefinition } = await load("../../src/display/builtins.ts");
const { decorateSubagentTool } = await load("../../src/subagents/display-adapter.ts");

const root = join(import.meta.dirname, "..", "..");
const themeModulePath = pathToFileURL(join(
  root,
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "dist",
  "modes",
  "interactive",
  "theme",
  "theme.js",
)).href;
const { loadThemeFromPath } = await import(themeModulePath);

const plainTheme = {
  fg(_token, text) { return String(text); },
  bg(_token, text) { return String(text); },
  bold(text) { return String(text); },
  inverse(text) { return String(text); },
};
const themes = [
  ["plain", plainTheme],
  ["dark", loadThemeFromPath(join(root, "themes", "pi-square-theme-dark.json"))],
  ["light", loadThemeFromPath(join(root, "themes", "pi-square-theme-light.json"))],
];
const widths = [39, 40, 63, 64, 80, 99, 100, 120];

const TMP = mkdtempSync(join(tmpdir(), "pi-square-header-grammar-"));
mkdirSync(join(TMP, "src", "display"), { recursive: true });
writeFileSync(join(TMP, "src", "display", "components.ts"), "export {}");

function newRuntime() {
  return new DisplayRuntime(structuredClone(DEFAULT_CONFIG), {
    environment: { isTTY: false, test: true },
  });
}

function makeCtx(args, state = {}, overrides = {}) {
  return {
    args,
    toolCallId: "call-1",
    invalidate() {},
    lastComponent: undefined,
    state,
    cwd: TMP,
    executionStarted: false,
    argsComplete: true,
    isPartial: false,
    expanded: false,
    showImages: false,
    isError: false,
    ...overrides,
  };
}

const BUILTIN_FACTORIES = {
  read: createReadToolDefinition,
  ls: createLsToolDefinition,
  edit: createEditToolDefinition,
  write: createWriteToolDefinition,
  find: createFindToolDefinition,
  grep: createGrepToolDefinition,
  bash: createBashToolDefinition,
};

/** Expected sentence-case title for every catalog tool (C1). */
const EXPECTED_TITLES = {
  read: "Read",
  ls: "List",
  edit: "Edit",
  replace: "Replace",
  write: "Write",
  find: "Find",
  grep: "Grep",
  codegraph: "CodeGraph",
  pdf_search: "PDF search",
  bash: "Bash",
  pwsh: "PowerShell",
  search: "Web search",
  fetch: "Web fetch",
  libs: "Library search",
  docs: "Documentation",
  parse: "PDF parse",
  github: "GitHub",
  ssh: "SSH",
  todo: "Tasks",
  ask: "Questions",
  submit_memory: "Memory submit",
  read_memory_source: "Memory source",
  delegate: "Subagent",
  resume: "Resume",
};

// ─── C1: every catalog tool renders a sentence-case title ───────────

{
  const runtime = newRuntime();
  const titlesByFamily = new Map();
  for (const entry of DISPLAY_CATALOG) {
    const expected = EXPECTED_TITLES[entry.name];
    assert.ok(expected, `expected title recorded for ${entry.name}`);
    const definition = BUILTIN_FACTORIES[entry.name]
      ? BUILTIN_FACTORIES[entry.name](TMP)
      : {
        name: entry.name,
        description: entry.description,
        parameters: { type: "object", properties: {}, additionalProperties: false },
        execute() { return { content: [] }; },
      };
    const decorated = BUILTIN_FACTORIES[entry.name]
      ? decorateBuiltinDefinition(definition, TMP, () => runtime)
      : entry.name.startsWith("subagent_")
        ? decorateSubagentTool(definition, () => runtime)
        : decorateInternalTool(definition, () => runtime);
    // Complete arguments, execution not started → a quiet fallback marker.
    const call = decorated.renderCall({}, plainTheme, makeCtx({}, {}, { executionStarted: false }));
    const header = stripVTControlCharacters(call.render(120)[0] ?? "");
    const marker = header.slice(0, 1);
    assert.ok(
      ["–", "○"].includes(marker),
      `${entry.name} pending/queued marker must be – or ○, got '${marker}'`,
    );
    const rest = header.slice(2);
    assert.ok(
      rest === expected || rest.startsWith(`${expected} `),
      `${entry.name} header must carry the title '${expected}', got '${rest}'`,
    );
    assert.ok(!/[❯λ]/.test(header), `${entry.name} header must not carry a prompt glyph`);
    const familyTitles = titlesByFamily.get(entry.family) ?? [];
    assert.ok(
      !familyTitles.includes(expected),
      `family '${entry.family}' must not share the title '${expected}' (${entry.name})`,
    );
    familyTitles.push(expected);
    titlesByFamily.set(entry.family, familyTitles);
  }
  runtime.dispose();
}

// ─── C2: path presentation helpers ──────────────────────────────────

{
  // Paths inside the working directory render relative to it.
  assert.equal(formatDisplayPath(join(TMP, "src", "display", "components.ts"), TMP), "src/display/components.ts");
  assert.equal(formatDisplayPath("src/display/components.ts", TMP), "src/display/components.ts");
  assert.equal(formatDisplayPath(TMP, TMP), ".");
  // Paths under the home directory use ~.
  assert.equal(formatDisplayPath(join(homedir(), "other", "repo", "index.ts"), TMP), "~/other/repo/index.ts");
  assert.equal(formatDisplayPath(homedir(), TMP), "~");
  assert.equal(formatDisplayPath("~/other/repo/index.ts", TMP), "~/other/repo/index.ts");
  // Anything else stays absolute.
  assert.equal(formatDisplayPath("/etc/hostname", TMP), "/etc/hostname");
}

{
  // A path that fits is unchanged.
  assert.equal(elidePathMiddle("src/display/components.ts", 40), "src/display/components.ts");
  // The middle is elided; the first segment and the file name are kept.
  assert.equal(elidePathMiddle("src/display/components.ts", 20), "src/…/components.ts");
  assert.equal(elidePathMiddle("src/display/deep/nested/components.ts", 22), "src/…/components.ts");
  // When the first segment does not fit, the file name is still kept.
  assert.equal(elidePathMiddle("src/display/components.ts", 18), "…/components.ts");
  assert.equal(elidePathMiddle("src/display/components.ts", 14), "components.ts");
  // Degenerate widths stay bounded even when the file name alone is too long.
  for (const width of [1, 5, 10]) {
    const elided = elidePathMiddle("src/display/components.ts", width);
    assert.ok(visibleWidth(elided) <= width, `elided path bounded at ${width}`);
  }
  const bare = elidePathMiddle("a-very-long-file-name.ts", 10);
  assert.ok(visibleWidth(bare) <= 10);
  assert.match(bare, /…$/);
}

// ─── C2: production path targets are workspace-relative ─────────────

{
  const runtime = newRuntime();
  const decorated = decorateBuiltinDefinition(createReadToolDefinition(TMP), TMP, () => runtime);
  const absolute = join(TMP, "src", "display", "components.ts");
  const call = decorated.renderCall({ path: absolute }, plainTheme, makeCtx({ path: absolute }));
  const header = stripVTControlCharacters(call.render(120)[0] ?? "");
  // The title keeps its natural width, separated from the target by one
  // space at every tier.
  assert.ok(
    header.startsWith("○ Read src/display/components.ts"),
    `read target is workspace-relative after the natural title: '${header}'`,
  );
  assert.ok(!header.includes(TMP), "read header must not show the absolute workspace root");

  const homePath = join(homedir(), "other", "repo", "index.ts");
  const homeCall = decorated.renderCall({ path: homePath }, plainTheme, makeCtx({ path: homePath }));
  const homeHeader = stripVTControlCharacters(homeCall.render(120)[0] ?? "");
  assert.ok(
    homeHeader.startsWith("○ Read ~/other/repo/index.ts"),
    `home path uses ~ after the natural title: '${homeHeader}'`,
  );
  runtime.dispose();
}

// ─── C1: the title keeps natural single-space spacing at every tier ─

{
  // No tier pads or truncates the title into an identity column; the target
  // follows after exactly one space.
  for (const width of [40, 64, 80, 99, 100, 120]) {
    const fitted = fitHeaderRow(
      { marker: "●", title: "Grep", target: "TODO" },
      width,
    );
    assert.equal(fitted.title, "Grep", `natural title at ${width}`);
    assert.equal(fitted.target, "TODO", `target survives at ${width}`);
  }

  // Through the component: exactly one space separates the title and target
  // at every tier, whatever the title length.
  const headerAt = (width, title) => stripVTControlCharacters(
    new OperationalDisplayComponent(
      { version: 1, tool: "grep", family: "search", lifecycle: "running", title, target: "TODO" },
      DEFAULT_DISPLAY_POLICY,
      plainTheme,
      { expanded: false },
    ).render(width)[0],
  );
  for (const width of [39, 64, 80, 99, 100, 120]) {
    for (const title of ["Grep", "Text search", "Structural search"]) {
      const header = headerAt(width, title);
      assert.ok(
        header.startsWith(`● ${title} TODO`),
        `${title} target follows after one space at ${width}: '${header}'`,
      );
    }
  }
}

// ─── C5: fitHeaderRow keeps one row and drops duration first ────────

{
  // Everything fits: pieces are unchanged with natural title spacing.
  const full = fitHeaderRow(
    { marker: "●", title: "Read", target: "src/a.ts", right: "5ms" },
    120,
  );
  assert.deepEqual(full, { title: "Read", target: "src/a.ts", right: "5ms" });

  // A long target is truncated with …; the duration stays.
  const longTarget = fitHeaderRow(
    { marker: "●", title: "Bash", target: `find . ${"-name '*.ts' ".repeat(30)}`, right: "5ms" },
    80,
  );
  assert.equal(longTarget.right, "5ms", "duration stays on the header row");
  assert.match(longTarget.target, /…$/, "text target is end-truncated");
  assert.ok(visibleWidth(`● Bash ${longTarget.target}`) + 3 + visibleWidth("5ms") <= 80);

  // Titles are never padded or column-truncated: an over-long title keeps
  // its natural width and the duration is the first element dropped.
  const roomy = fitHeaderRow(
    { marker: "●", title: "T".repeat(50), target: "some-target", right: "5ms" },
    64,
  );
  assert.equal(roomy.title, "T".repeat(50), "an over-long title keeps its natural width");
  assert.equal(roomy.right, undefined, "the duration drops before the title truncates");
  assert.equal(roomy.target, "some-target", "the target survives when the duration drops");

  // The inline summary elides in place before the duration drops.
  const summaryCramped = fitHeaderRow(
    { marker: "●", title: "T".repeat(30), target: "some-target", right: "5ms", inlineSummary: "8 results · 2 not shown" },
    64,
  );
  assert.equal(summaryCramped.right, "5ms", "the summary elides before the duration drops");
  assert.ok(summaryCramped.inlineSummary && summaryCramped.inlineSummary.includes("…"), "the inline summary elides in place");
  assert.equal(summaryCramped.target, "some-tar…", "the target truncates only as the final resort");

  // When the summary cannot fit at all, it drops; the target survives.
  const summaryDropped = fitHeaderRow(
    {
      marker: "●",
      title: "T".repeat(56),
      target: "t",
      inlineSummary: "a very long inline outcome summary that cannot fit",
    },
    64,
  );
  assert.equal(summaryDropped.inlineSummary, undefined, "the inline summary drops when it cannot fit");
  assert.equal(summaryDropped.target, "t", "the minimal target survives the summary drop");

  // Compact tier drops the duration by default.
  const compact = fitHeaderRow(
    { marker: "●", title: "Subagent", target: "explorer", right: "4.0s" },
    63,
  );
  assert.equal(compact.right, undefined, "compact drops the duration");
  assert.equal(compact.target, "explorer", "compact keeps the natural title and target");

  // A path target is elided in the middle and keeps its file name.
  const pathTarget = fitHeaderRow(
    { marker: "●", title: "Read", target: "src/display/components.ts", targetKind: "path" },
    26,
  );
  assert.equal(pathTarget.target, "src/…/components.ts");

  // Every candidate stays bounded, even at degenerate widths.
  for (const width of widths) {
    const fitted = fitHeaderRow(
      { marker: "●", title: "Structural search", target: "src/display/components.ts", targetKind: "path", right: "1.3s" },
      width,
    );
    const left = `● ${fitted.title}${fitted.target ? ` ${fitted.target}` : ""}`;
    const total = visibleWidth(left) + (fitted.right ? 3 + visibleWidth(fitted.right) : 0);
    assert.ok(total <= width || width < 30, `fitted header bounded at ${width} (got ${total})`);
  }
}

// ─── C5: the header is always exactly one row ───────────────────────

{
  const longCommand = `find . -type f -name '*.ts' -not -path './node_modules/*' ${"| sort ".repeat(20)}`;
  const description = {
    version: 1,
    tool: "bash",
    family: "execution",
    lifecycle: "completed",
    title: "Bash",
    target: longCommand,
    durationMs: 1500,
  };
  for (const [themeName, theme] of themes) {
    for (const width of widths) {
      const lines = new OperationalDisplayComponent(description, DEFAULT_DISPLAY_POLICY, theme, { expanded: false }).render(width);
      assert.equal(lines.length, 1, `header is one row at ${width} in ${themeName}`);
      const header = stripVTControlCharacters(lines[0]);
      assert.match(header, /Bash/, `title on the header row at ${width} in ${themeName}`);
      assert.match(header, /…/, `long target truncated with … at ${width} in ${themeName}`);
      const trimmed = header.trimEnd();
      if (width >= 64) {
        assert.match(trimmed, /1\.5s$/, `duration stays on the header row at ${width} in ${themeName}`);
      } else {
        assert.doesNotMatch(trimmed, /1\.5s/, `compact width ${width} drops the duration in ${themeName}`);
      }
    }
  }
}

{
  // Production path: a long bash command never wraps the header.
  const runtime = newRuntime();
  const decorated = decorateBuiltinDefinition(createBashToolDefinition(TMP), TMP, () => runtime);
  const args = { command: `find . -type f -name '*.ts' -not -path './node_modules/*' ${"| sort ".repeat(20)}` };
  const call = decorated.renderCall(args, plainTheme, makeCtx(args, {}, { executionStarted: true }));
  const lines = call.render(80).map((line) => stripVTControlCharacters(line));
  assert.match(lines[0], /^● Bash /, "bash header carries the sentence-case title");
  assert.match(lines[0], /…/, "long command is truncated on the header row");
  assert.equal(lines.length, 1, "a running non-mutation call keeps exactly one row");
  for (const line of lines.slice(1)) {
    assert.match(line, /^ {2}/, "every line after the header carries the quiet two-cell body indent");
    assert.doesNotMatch(line, /^[│└├]/, "no tree rails remain on body lines");
  }
  const result = decorated.renderResult(
    { content: [{ type: "text", text: "done" }], details: {} },
    { expanded: false, isPartial: false },
    plainTheme,
    makeCtx(args, {}, { executionStarted: true, isError: false }),
  );
  const resultLines = result.render(80).map((line) => stripVTControlCharacters(line));
  assert.match(resultLines[0].trimEnd(), /ms$|s$/, "result duration stays on the header row");
  assert.match(resultLines[0], /…/, "result target stays truncated");
  runtime.dispose();
}

// ─── C5: path targets are elided in the middle through the component ─

{
  // Widths at or below 63 are the compact tier and drop the duration, so
  // elision with a visible duration is exercised at a regular width with a
  // path that is too long for 64 columns.
  const description = {
    version: 1,
    tool: "read",
    family: "filesystem",
    lifecycle: "completed",
    title: "Read",
    target: "src/display/components/deep/nested/very-long-file-name.ts",
    targetKind: "path",
    durationMs: 12,
  };
  const header = stripVTControlCharacters(
    new OperationalDisplayComponent(description, DEFAULT_DISPLAY_POLICY, plainTheme, { expanded: false }).render(64)[0],
  );
  assert.match(header, /src\/…\/very-long-file-name\.ts/, "path target is elided in the middle");
  assert.match(header.trimEnd(), /12ms$/, "duration stays on the row");
  const compact = stripVTControlCharacters(
    new OperationalDisplayComponent(description, DEFAULT_DISPLAY_POLICY, plainTheme, { expanded: false }).render(40)[0],
  );
  assert.match(compact, /…/, "compact path target is elided");
  assert.match(compact, /very-long-file-name\.ts/, "the file name is never elided");
  assert.doesNotMatch(compact, /12ms/, "compact drops the duration");
}

// ─── C7: qualifiers never render header badges or body notices ──────

{
  const description = {
    version: 1,
    tool: "pdf_search",
    family: "search",
    lifecycle: "completed",
    title: "PDF search",
    target: "needle",
    rows: [{ text: "3 matches" }],
    truncated: true,
  };
  const lines = new OperationalDisplayComponent(description, DEFAULT_DISPLAY_POLICY, plainTheme, { expanded: false }).render(80);
  const header = stripVTControlCharacters(lines[0]);
  assert.doesNotMatch(header, /\[/, `the header stays badge-free: '${header}'`);
  assert.doesNotMatch(
    stripVTControlCharacters(lines.join("\n")),
    /\[(truncated|partial|bounded|cancelling|retrying|projected|needs input)\]/,
    "no qualifier badge renders anywhere",
  );
  assert.doesNotMatch(
    stripVTControlCharacters(lines.join("\n")),
    /output truncated by display budget/,
    "no truncation notice renders as a body row",
  );

  // A qualifier set by the adapter renders no badge either.
  const qualified = stripVTControlCharacters(new OperationalDisplayComponent(
    { ...description, qualifiers: ["truncated"] },
    DEFAULT_DISPLAY_POLICY,
    plainTheme,
    { expanded: false },
  ).render(120).join("\n"));
  assert.doesNotMatch(qualified, /\[truncated\]/, "an adapter-set qualifier renders no badge");

  // Production path: a bounded Pi read result stays badge-free.
  const runtime = newRuntime();
  const decorated = decorateBuiltinDefinition(createReadToolDefinition(TMP), TMP, () => runtime);
  const args = { path: "src/display/components.ts" };
  const call = decorated.renderCall(args, plainTheme, makeCtx(args, {}, { executionStarted: true }));
  const result = decorated.renderResult(
    { content: [{ type: "text", text: "1 export {}" }], details: { truncation: { truncated: true } } },
    { expanded: false, isPartial: false },
    plainTheme,
    makeCtx(args, {}, { executionStarted: true, lastComponent: call, isError: false }),
  );
  const resultHeader = stripVTControlCharacters(result.render(80)[0]);
  assert.doesNotMatch(resultHeader, /\[truncated\]/, "a bounded read result renders no truncated badge");
  runtime.dispose();

  // The search-family boundedness signals stay badge-free too: paged
  // pdf_search results with more matches available, and the codegraph
  // output budget.
  const stub = (name) => ({
    name,
    description: name,
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute() { return { content: [] }; },
  });
  const pdfRuntime = newRuntime();
  const pdf = decorateInternalTool(stub("pdf_search"), () => pdfRuntime);
  const pdfResult = pdf.renderResult(
    {
      content: [{ type: "text", text: "pdf_search returned=5" }],
      details: {
        status: "success",
        totalMatches: 24,
        returned: 5,
        hasMore: true,
        matches: [{ page: 3, type: "exact", context: "needle found here", matchedText: "needle" }],
      },
    },
    { expanded: false, isPartial: false },
    plainTheme,
    makeCtx({ path: "reports/q3.pdf", query: "needle" }, {}, { executionStarted: true, isError: false }),
  );
  assert.doesNotMatch(
    stripVTControlCharacters(pdfResult.render(80)[0]),
    /\[truncated\]/,
    "a paged pdf_search result renders no truncated badge",
  );
  pdfRuntime.dispose();
  const codegraphRuntime = newRuntime();
  const codegraph = decorateInternalTool(stub("codegraph"), () => codegraphRuntime);
  const codegraphResult = codegraph.renderResult(
    {
      content: [{ type: "text", text: "{}" }],
      details: { operation: "explore", phase: "done", outputTruncated: true },
    },
    { expanded: false, isPartial: false },
    plainTheme,
    makeCtx({ operation: "explore", query: "auth" }, {}, { executionStarted: true, isError: false }),
  );
  assert.doesNotMatch(
    stripVTControlCharacters(codegraphResult.render(80)[0]),
    /\[truncated\]/,
    "a codegraph result bounded by the output budget renders no badge",
  );
  codegraphRuntime.dispose();
}

// ─── Boundedness: every new header shape at every width and theme ───

{
  const scenarios = [
    {
      version: 1, tool: "bash", family: "execution", lifecycle: "completed",
      title: "Bash", target: `echo ${"x".repeat(200)}`, durationMs: 42,
      rows: [{ text: "done" }],
    },
    {
      version: 1, tool: "read", family: "filesystem", lifecycle: "completed",
      title: "Read", target: "src/display/deep/nested/components.ts", targetKind: "path",
      qualifiers: ["truncated"], durationMs: 1250, rows: [{ text: "60 lines" }], truncated: true,
    },
    {
      version: 1, tool: "delegate", family: "agent", lifecycle: "running",
      title: "Subagent", target: "explorer", qualifiers: ["cancelling", "partial"], durationMs: 4000,
    },
  ];
  for (const description of scenarios) {
    for (const [themeName, theme] of themes) {
      for (const width of widths) {
        const lines = new OperationalDisplayComponent(description, DEFAULT_DISPLAY_POLICY, theme, { expanded: false }).render(width);
        assert.ok(lines.length > 0, `${description.tool}/${themeName}/${width} rendered empty`);
        assert.ok(
          lines.every((line) => visibleWidth(line) <= width),
          `${description.tool}/${themeName}/${width} exceeded ${width}`,
        );
        // Collapsed non-mutation entries are exactly one row; any body line
        // carries the quiet two-cell indent instead of tree rails.
        for (const line of lines.slice(1)) {
          const plain = stripVTControlCharacters(line);
          assert.match(
            plain,
            /^( {2}|$)/,
            `${description.tool}/${themeName}/${width} body lines carry the quiet indent`,
          );
          assert.doesNotMatch(
            plain,
            /^[│└├]/,
            `${description.tool}/${themeName}/${width} renders no tree rails`,
          );
        }
      }
    }
  }
}

console.log("display header grammar tests: OK");
