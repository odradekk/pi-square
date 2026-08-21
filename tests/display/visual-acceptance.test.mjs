import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripVTControlCharacters } from "node:util";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { visibleWidth } from "@earendil-works/pi-tui";
import jiti from "jiti";

const load = jiti(import.meta.url, { moduleCache: false });
const { DISPLAY_CATALOG } = await load("../../src/display/catalog.ts");
const { OperationalDisplayComponent } = await load("../../src/display/components.ts");
const {
  DEFAULT_DISPLAY_POLICY,
  BULLET_MARKER,
  FALLBACK_MARKERS,
  FALLBACK_WARNING_MARKER,
  OPERATIONAL_QUALIFIERS,
  QUALIFIER_BADGES,
} = await load("../../src/display/types.ts");
const { DEFAULT_CONFIG } = await load("../../src/core/config.ts");
const { DisplayRuntime } = await load("../../src/display/runtime.ts");
const { decorateInternalTool } = await load("../../src/display/internal-adapters.ts");
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

// ── Themes: bundled dark, bundled light, and a minimal valid third-party ──

const darkTheme = loadThemeFromPath(join(root, "themes", "pi-square-theme-dark.json"));
const lightTheme = loadThemeFromPath(join(root, "themes", "pi-square-theme-light.json"));

// A minimal valid third-party theme with a different palette shape.
const thirdPartyTheme = {
  fg(token, text) { return `\x1b[31m${text}\x1b[0m`; },
  bg(_token, text) { return String(text); },
  bold(text) { return `\x1b[1m${text}\x1b[0m`; },
  inverse(text) { return `\x1b[7m${text}\x1b[0m`; },
};

const themes = [
  ["dark", darkTheme],
  ["light", lightTheme],
  ["third-party", thirdPartyTheme],
];

const widths = [39, 40, 63, 64, 80, 99, 100, 120];

// ── 1. Full state matrix: empty, truncated, expanded for all tools ──

const extraStates = ["empty", "truncated", "expanded-call", "expanded-result"];

const extraStateMap = {
  empty: { lifecycle: "completed", emptyRows: true },
  truncated: { lifecycle: "completed", qualifiers: ["truncated"] },
  "expanded-call": { lifecycle: "running", phase: "call" },
  "expanded-result": { lifecycle: "completed", expanded: true },
};

function descriptionFor(entry, state) {
  const cfg = extraStateMap[state];
  const isEmpty = state === "empty";
  return {
    version: 1,
    tool: entry.name,
    family: entry.family,
    lifecycle: cfg.lifecycle,
    ...(cfg.qualifiers ? { qualifiers: cfg.qualifiers } : {}),
    ...(cfg.phase ? { phase: cfg.phase } : {}),
    title: entry.name.toUpperCase(),
    target: "src/example\x1b]0;owned\x07.ts",
    metadata: [{ label: "count", value: "12" }, { label: "secret", value: "token=hidden-value" }],
    rows: isEmpty ? [] : [{ text: `${entry.name} ${state}` }],
    ...(isEmpty ? {} : { preview: { text: "line one\nline two\nline three", omittedLines: 2 } }),
    truncated: state === "truncated",
    ...(entry.name === "edit" || entry.name === "write"
      ? { diff: { path: "src/example.ts", before: "old\n", after: "new\n", projected: entry.name === "write" } }
      : {}),
  };
}

for (const entry of DISPLAY_CATALOG) {
  for (const state of extraStates) {
    const description = descriptionFor(entry, state);
    for (const [themeName, theme] of themes) {
      for (const width of widths) {
        const expanded = state === "expanded-result" || state === "expanded-call";
        const policy = { ...DEFAULT_DISPLAY_POLICY, resultMode: "preview" };
        const component = new OperationalDisplayComponent(description, policy, theme, { expanded });
        const lines = component.render(width);
        assert.ok(lines.length > 0, `${entry.name}/${state}/${themeName}/${width} rendered empty`);
        assert.ok(
          lines.every((line) => visibleWidth(line) <= width),
          `${entry.name}/${state}/${themeName}/${width} exceeded ${width}`,
        );
        const plain = stripVTControlCharacters(lines.join("\n"));
        assert.doesNotMatch(plain, /owned|hidden-value|\x07/);
      }
    }
  }
}

// ── 2. Empty state produces a visible header even without rows/preview ──

{
  for (const [themeName, theme] of themes) {
    const description = {
      version: 1,
      tool: "rg",
      family: "search",
      lifecycle: "completed",
      title: "TEXT SEARCH",
      target: "src/target.ts",
      rows: [],
    };
    const policy = { ...DEFAULT_DISPLAY_POLICY, resultMode: "preview" };
    const lines = new OperationalDisplayComponent(description, policy, theme, { expanded: false }).render(80);
    assert.ok(lines.length > 0, `empty state must render at least the header in ${themeName}`);
    const plain = stripVTControlCharacters(lines.join("\n"));
    assert.match(plain, /✓/, "completed marker must appear in empty state");
  }
}

// ── 3. Truncated state renders with bounded output ──

{
  for (const [themeName, theme] of themes) {
    const description = {
      version: 1,
      tool: "rg",
      family: "search",
      lifecycle: "completed",
      qualifiers: ["truncated"],
      title: "TEXT SEARCH",
      target: "src/target.ts",
      rows: [{ text: "truncated result" }],
      preview: { text: "visible\nhidden\nmore hidden\n", omittedLines: 50 },
      truncated: true,
    };
    const policy = { ...DEFAULT_DISPLAY_POLICY, resultMode: "preview", previewLines: 1 };
    const lines = new OperationalDisplayComponent(description, policy, theme, { expanded: false }).render(80);
    const plain = stripVTControlCharacters(lines.join("\n"));
    assert.match(plain, /✓/, "completed marker for truncated state");
    assert.ok(lines.every((line) => visibleWidth(line) <= 80), `truncated state bounded at 80 in ${themeName}`);
  }
}

// ── 4. All lifecycle + qualifier combinations at all widths ──

const lifecycleCombos = [
  { lifecycle: "queued" },
  { lifecycle: "pending" },
  { lifecycle: "running" },
  { lifecycle: "running", qualifiers: ["partial"] },
  { lifecycle: "running", qualifiers: ["retrying"] },
  { lifecycle: "running", qualifiers: ["cancelling"] },
  { lifecycle: "completed" },
  { lifecycle: "completed", qualifiers: ["warning"] },
  { lifecycle: "completed", qualifiers: ["truncated"] },
  { lifecycle: "completed", qualifiers: ["projected"] },
  { lifecycle: "completed", qualifiers: ["needs-input"] },
  { lifecycle: "failed" },
  { lifecycle: "aborted" },
];

for (const combo of lifecycleCombos) {
  const description = {
    version: 1,
    tool: "sample",
    family: "workflow",
    lifecycle: combo.lifecycle,
    ...(combo.qualifiers ? { qualifiers: combo.qualifiers } : {}),
    title: "Sample",
    target: "src/target.ts",
    metadata: [{ label: "count", value: "5" }],
    rows: [{ text: "result text" }],
  };
  for (const [themeName, theme] of themes) {
    for (const width of widths) {
      const component = new OperationalDisplayComponent(description, DEFAULT_DISPLAY_POLICY, theme, { expanded: false });
      const lines = component.render(width);
      assert.ok(lines.length > 0, `${combo.lifecycle}/${combo.qualifiers?.join("+") ?? "none"}/${themeName}/${width} rendered empty`);
      assert.ok(
        lines.every((line) => visibleWidth(line) <= width),
        `${combo.lifecycle}/${combo.qualifiers?.join("+") ?? "none"}/${themeName}/${width} exceeded ${width}`,
      );
    }
  }
}

// ── 5. Sanitization and redaction across all themes ──

const secretValues = [
  "Bearer ghp_SECRET123",
  "api_key=hidden-key",
  "password=do-not-show",
  "token: abc-token-xyz",
  "github_pat_ABCDE",
  "ghp_production_token",
  "fc-api-key-12345",
];

for (const secret of secretValues) {
  for (const [themeName, theme] of themes) {
    const description = {
      version: 1,
      tool: "rg",
      family: "search",
      lifecycle: "failed",
      title: "TEXT SEARCH",
      target: "src/target.ts",
      rows: [{ text: secret }],
      error: secret,
    };
    const lines = new OperationalDisplayComponent(description, DEFAULT_DISPLAY_POLICY, theme, { expanded: false }).render(80);
    const plain = stripVTControlCharacters(lines.join("\n"));
    for (const sensitive of ["ghp_SECRET123", "hidden-key", "do-not-show", "abc-token-xyz", "github_pat_ABCDE", "ghp_production_token", "fc-api-key-12345"]) {
      assert.doesNotMatch(plain, new RegExp(sensitive), `secret '${sensitive}' leaked in ${themeName}`);
    }
    assert.match(plain, /\[REDACTED\]/, `failed state must show [REDACTED] in ${themeName}`);
  }
}

// ── 6. Control-character injection must be sanitized ──

{
  // Control sequences must be stripped; surrounding text remains.
  const maliciousInputs = [
    "safe\x1b]0;title-injection\x07text",
    "safe\x1b[31mred-text\x1b[0m",
  ];
  for (const malicious of maliciousInputs) {
    const description = {
      version: 1,
      tool: "rg",
      family: "search",
      lifecycle: "completed",
      title: "SEARCH",
      target: malicious,
      rows: [{ text: malicious }],
    };
    const lines = new OperationalDisplayComponent(description, DEFAULT_DISPLAY_POLICY, darkTheme, { expanded: false }).render(80);
    const plain = stripVTControlCharacters(lines.join("\n"));
    // OSC sequences must be fully stripped
    assert.doesNotMatch(plain, /title-injection/);
    assert.doesNotMatch(plain, /\x1b|\x07/);
  }
}

// ── 7. Expanded vs collapsed information reachability ──

{
  const description = {
    version: 1,
    tool: "read",
    family: "filesystem",
    lifecycle: "completed",
    title: "READ",
    target: "src/example.ts",
    metadata: [{ label: "lines", value: "100" }],
    rows: [{ text: "summary line" }],
    sections: [
      {
        title: "Content",
        blocks: [{ kind: "code", text: "line 1\nline 2\nline 3", language: "typescript", lineNumbers: true }],
        compact: false,
      },
    ],
  };

  // Collapsed: non-compact sections are hidden but header info is visible
  const collapsed = new OperationalDisplayComponent(description, DEFAULT_DISPLAY_POLICY, darkTheme, { expanded: false }).render(80);
  const collapsedPlain = stripVTControlCharacters(collapsed.join("\n"));
  assert.match(collapsedPlain, /✓ READ/, "collapsed must show marker and title");
  assert.match(collapsedPlain, /summary line/, "collapsed must show rows");

  // Expanded: all sections become visible
  const expanded = new OperationalDisplayComponent(description, DEFAULT_DISPLAY_POLICY, darkTheme, { expanded: true }).render(80);
  const expandedPlain = stripVTControlCharacters(expanded.join("\n"));
  assert.match(expandedPlain, /line 1/, "expanded must show section content");
  assert.match(expandedPlain, /line 2/, "expanded must show all section lines");
  // A lone Content section attaches its content directly without a title rule (C9).
  assert.ok(!expandedPlain.includes("FILE"), "the restating File section title is never rendered");
}

// ── 8. Motion downgrade: all lifecycles render correctly ──

{
  for (const lifecycle of ["running", "completed", "failed"]) {
    const description = {
      version: 1,
      tool: "sample",
      family: "workflow",
      lifecycle,
      title: "Sample",
      target: "src/target.ts",
      rows: [{ text: "content" }],
    };
    for (const [themeName, theme] of themes) {
      for (const width of widths) {
        const lines = new OperationalDisplayComponent(description, DEFAULT_DISPLAY_POLICY, theme, { expanded: false }).render(width);
        assert.ok(lines.length > 0, `motion/${lifecycle}/${themeName}/${width} rendered empty`);
        assert.ok(lines.every((line) => visibleWidth(line) <= width), `motion/${lifecycle}/${themeName}/${width} exceeded`);
      }
    }
  }
}

// ── 9. Diff: unified, split, and auto at all widths ──

{
  for (const diffView of ["unified", "split", "auto"]) {
    for (const threshold of [70, 100, 120]) {
      const policy = { ...DEFAULT_DISPLAY_POLICY, resultMode: "preview", diffView, diffSplitMinWidth: threshold };
      const description = {
        version: 1,
        tool: "edit",
        family: "filesystem",
        lifecycle: "completed",
        title: "EDIT",
        target: "src/example.ts",
        diff: {
          path: "src/example.ts",
          before: "old line\nshared line\nremoved line\n",
          after: "new line\nshared line\nadded line\n",
        },
      };
      for (const [themeName, theme] of themes) {
        for (const width of widths) {
          const lines = new OperationalDisplayComponent(description, policy, theme, { expanded: true }).render(width);
          assert.ok(lines.length > 0, `diff/${diffView}/${threshold}/${themeName}/${width} rendered empty`);
          assert.ok(
            lines.every((line) => visibleWidth(line) <= width),
            `diff/${diffView}/${threshold}/${themeName}/${width} exceeded ${width}`,
          );
        }
      }
    }
  }
}

// ── 10. Wrap vs no-wrap bounded at all widths ──

{
  for (const wordWrap of [true, false]) {
    const policy = { ...DEFAULT_DISPLAY_POLICY, wordWrap };
    const description = {
      version: 1,
      tool: "read",
      family: "filesystem",
      lifecycle: "completed",
      title: "READ",
      target: "src/example.ts",
      rows: [{ text: "a".repeat(200) }],
    };
    for (const width of widths) {
      const lines = new OperationalDisplayComponent(description, policy, darkTheme, { expanded: false }).render(width);
      assert.ok(lines.every((line) => visibleWidth(line) <= width), `wrap=${wordWrap}/${width} exceeded`);
    }
  }
}

// ── 11. Bundled themes use only standard Pi semantic tokens ──

for (const themeFile of ["pi-square-theme-dark.json", "pi-square-theme-light.json"]) {
  const themeData = JSON.parse(readFileSync(join(root, "themes", themeFile), "utf8"));
  // Every color value must be a var alias (string), not a raw hex
  for (const [token, value] of Object.entries(themeData.colors)) {
    assert.equal(typeof value, "string", `${themeFile}/${token} must be a var alias`);
    assert.ok(themeData.vars[value] !== undefined, `${themeFile}/${token} references unknown var '${value}'`);
  }
}

// ── 12. Hidden result mode preserves error visibility ──

{
  for (const [themeName, theme] of themes) {
    for (const lifecycle of ["failed", "aborted"]) {
      const description = {
        version: 1,
        tool: "rg",
        family: "search",
        lifecycle,
        title: "SEARCH",
        target: "src/target.ts",
        rows: [{ text: "result content" }],
        ...(lifecycle === "failed" ? { error: "Bearer secret-hidden" } : {}),
      };
      const policy = { ...DEFAULT_DISPLAY_POLICY, resultMode: "hidden" };
      const lines = new OperationalDisplayComponent(description, policy, theme, { expanded: false }).render(80);
      const plain = stripVTControlCharacters(lines.join("\n"));
      if (lifecycle === "failed") {
        assert.match(plain, /×/, `hidden/failed must show × marker in ${themeName}`);
        assert.match(plain, /\[REDACTED\]/, `hidden/failed must show [REDACTED] in ${themeName}`);
      } else {
        assert.match(plain, /·/, `hidden/aborted must show · marker in ${themeName}`);
      }
      // Hidden mode preserves markers for failed/aborted;
      // row suppression only applies to non-error states.
      // The error content itself is always redacted.
    }
  }
}

// ── 12b. Bundled themes are a recalibrated matched pair ──────────

{
  const darkData = JSON.parse(readFileSync(join(root, "themes", "pi-square-theme-dark.json"), "utf8"));
  const lightData = JSON.parse(readFileSync(join(root, "themes", "pi-square-theme-light.json"), "utf8"));
  // The palette variables are retuned as a pair; every value stays a hex color.
  for (const [name, themeData] of [["dark", darkData], ["light", lightData]]) {
    for (const [variable, value] of Object.entries(themeData.vars)) {
      assert.match(value, /^#[0-9a-fA-F]{6}$/, `${name} theme var ${variable} is a hex color`);
    }
  }
  // The accent family is retained in both themes (terracotta hue ~18-24°).
  for (const themeData of [darkData, lightData]) {
    for (const variable of ["accent", "accentStrong"]) {
      const hex = themeData.vars[variable];
      const red = parseInt(hex.slice(1, 3), 16);
      const green = parseInt(hex.slice(3, 5), 16);
      const blue = parseInt(hex.slice(5, 7), 16);
      assert.ok(red > green && red > blue, `${variable} keeps a warm terracotta family`);
    }
  }
}

// ── 13. Summary result mode across all catalog tools ──
// integration.test.mjs covers hidden/summary/preview for the 6 core states;
// this section adds summary mode for the extra states (empty, truncated, expanded).

{
  for (const entry of DISPLAY_CATALOG) {
    for (const state of ["empty", "truncated"]) {
      const description = descriptionFor(entry, state);
      for (const [themeName, theme] of themes) {
        for (const width of widths) {
          const policy = { ...DEFAULT_DISPLAY_POLICY, resultMode: "summary" };
          const lines = new OperationalDisplayComponent(description, policy, theme, { expanded: false }).render(width);
          assert.ok(lines.length > 0, `summary/${entry.name}/${state}/${themeName}/${width} rendered empty`);
          assert.ok(lines.every((line) => visibleWidth(line) <= width), `summary/${entry.name}/${state}/${themeName}/${width} exceeded`);
        }
      }
    }
  }
}

// ── 14. Call-phase rendering across all catalog tools ──

{
  for (const entry of DISPLAY_CATALOG) {
    for (const lifecycle of ["queued", "pending", "running"]) {
      const description = {
        version: 1,
        tool: entry.name,
        family: entry.family,
        lifecycle,
        phase: "call",
        title: entry.name.toUpperCase(),
        target: "src/target.ts",
        metadata: [{ label: "arg", value: "test" }],
      };
      for (const [themeName, theme] of themes) {
        for (const width of widths) {
          const lines = new OperationalDisplayComponent(description, DEFAULT_DISPLAY_POLICY, theme, { expanded: false }).render(width);
          assert.ok(lines.length > 0, `call/${entry.name}/${lifecycle}/${themeName}/${width} rendered empty`);
          assert.ok(lines.every((line) => visibleWidth(line) <= width), `call/${entry.name}/${lifecycle}/${themeName}/${width} exceeded`);
        }
      }
    }
  }
}

// ── 15. Every catalog tool renders the bullet without family icons ──

{
  const familyIconGlyphs = ["▪", "⌕", "⌬", "◆", "◇", "❯", "λ"];
  for (const entry of DISPLAY_CATALOG) {
    const description = {
      version: 1,
      tool: entry.name,
      family: entry.family,
      lifecycle: "completed",
      title: entry.name.toUpperCase(),
      target: "src/target.ts",
    };

    // Color-capable: every state renders ●
    const colorHeader = stripVTControlCharacters(
      new OperationalDisplayComponent(description, DEFAULT_DISPLAY_POLICY, darkTheme, { expanded: false, colorAvailable: true }).render(120).join("\n"),
    );
    assert.equal(colorHeader[0], BULLET_MARKER, `${entry.name} must render ● when color is available`);

    // No color (default): fallback marker for the lifecycle
    const fallbackHeader = stripVTControlCharacters(
      new OperationalDisplayComponent(description, DEFAULT_DISPLAY_POLICY, darkTheme, { expanded: false }).render(120).join("\n"),
    );
    assert.equal(fallbackHeader[0], FALLBACK_MARKERS.completed, `${entry.name} must render fallback marker when color is unavailable`);

    // No family icon glyph appears anywhere in the header
    for (const glyph of familyIconGlyphs) {
      assert.ok(!colorHeader.includes(glyph), `${entry.name} color header must not contain family icon '${glyph}'`);
      assert.ok(!fallbackHeader.includes(glyph), `${entry.name} fallback header must not contain family icon '${glyph}'`);
    }
  }
}

// ── 16. Every marker is one cell and every qualifier has a visible badge ──

{
  assert.equal(visibleWidth(BULLET_MARKER), 1, "BULLET_MARKER must measure one cell");
  for (const marker of Object.values(FALLBACK_MARKERS)) {
    assert.equal(visibleWidth(marker), 1, `fallback marker '${marker}' must measure one cell`);
  }
  assert.equal(visibleWidth(FALLBACK_WARNING_MARKER), 1, "warning marker must measure one cell");

  for (const qualifier of OPERATIONAL_QUALIFIERS) {
    const description = {
      version: 1,
      tool: "rg",
      family: "search",
      lifecycle: qualifier === "warning" ? "completed" : "running",
      qualifiers: [qualifier],
      title: "Text search",
      target: "needle",
    };
    for (const [themeName, theme] of themes) {
      const plain = stripVTControlCharacters(
        new OperationalDisplayComponent(description, DEFAULT_DISPLAY_POLICY, theme, { expanded: false }).render(120).join("\n"),
      );
      if (qualifier === "warning") {
        // The completed-with-warning marker already carries this qualifier.
        assert.match(plain, /!/, `warning qualifier must show the ! marker in ${themeName}`);
        continue;
      }
      assert.ok(
        plain.includes(`[${QUALIFIER_BADGES[qualifier]}]`),
        `${qualifier} must render a visible badge in ${themeName}`,
      );
    }
  }

  // Compact layouts keep the highest-priority badge and drop the duration.
  const compact = stripVTControlCharacters(new OperationalDisplayComponent(
    {
      version: 1,
      tool: "delegate",
      family: "agent",
      lifecycle: "running",
      qualifiers: ["partial", "cancelling"],
      title: "Subagent",
      target: "explorer",
      durationMs: 4000,
    },
    DEFAULT_DISPLAY_POLICY,
    darkTheme,
    { expanded: false },
  ).render(63).join("\n"));
  assert.match(compact, /\[cancelling\]/, "compact keeps the action-critical badge");
  assert.doesNotMatch(compact, /\[partial\]/, "compact drops lower-priority badges");
  assert.doesNotMatch(compact, /4\.0s/, "duration is the first header item dropped");
}

// ── 17. Production decoration path for every non-built-in catalog tool ──

{
  // Pi built-ins are decorated by builtins.ts and covered by their own suites.
  const builtins = new Set(["read", "ls", "edit", "write", "find", "grep", "bash"]);
  const runtime = new DisplayRuntime(structuredClone(DEFAULT_CONFIG), {
    environment: { isTTY: false, test: true },
  });

  function context(args, overrides = {}) {
    return {
      args,
      toolCallId: "call-1",
      invalidate() {},
      lastComponent: undefined,
      state: {},
      cwd: root,
      executionStarted: true,
      argsComplete: true,
      isPartial: false,
      expanded: false,
      showImages: false,
      isError: false,
      ...overrides,
    };
  }

  for (const entry of DISPLAY_CATALOG) {
    if (builtins.has(entry.name)) continue;
    const definition = {
      name: entry.name,
      description: entry.description,
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute() { return { content: [] }; },
    };
    const decorated = entry.name.startsWith("subagent_")
      ? decorateSubagentTool(definition, () => runtime)
      : decorateInternalTool(definition, () => runtime);
    assert.equal(decorated.renderShell, "self", `${entry.name} must own its render shell`);

    const call = decorated.renderCall({}, darkTheme, context({}));
    const result = decorated.renderResult(
      { content: [{ type: "text", text: "done" }], details: {} },
      { expanded: false, isPartial: false },
      darkTheme,
      context({}, { lastComponent: call }),
    );

    for (const width of widths) {
      for (const component of [call, result]) {
        const lines = component.render(width);
        assert.ok(
          lines.every((line) => visibleWidth(line) <= width),
          `${entry.name} exceeded ${width} through the production decoration path`,
        );
        const plain = stripVTControlCharacters(lines.join("\n"));
        assert.ok(!/[▪▣⌕⌬◆◇]/.test(plain), `${entry.name} must not show family icons at width ${width}`);
        // The runtime is created with { isTTY: false, test: true }, so colorAvailable
        // is false and every marker is a fallback glyph. Verify the first character
        // is a valid fallback marker, not a family icon.
        const firstChar = plain[0];
        const validFallbacks = [...Object.values(FALLBACK_MARKERS), FALLBACK_WARNING_MARKER];
        assert.ok(validFallbacks.includes(firstChar), `${entry.name} must render a fallback marker at width ${width}, got '${firstChar}'`);
      }
    }
  }

  runtime.dispose();
}

// ── 18. C4 revision: every non-mutation collapsed entry is one row ──

{
  const mutationFamily = new Set(["edit", "replace", "revert", "write"]);
  const runStates = ["queued", "pending", "running", "completed", "failed", "aborted"];
  for (const entry of DISPLAY_CATALOG) {
    for (const lifecycle of runStates) {
      const description = {
        version: 1,
        tool: entry.name,
        family: entry.family,
        lifecycle,
        phase: lifecycle === "running" ? "call" : "result",
        title: entry.name.toUpperCase(),
        target: "src/target.ts",
        rows: [{ text: "outcome row" }],
        preview: { text: "payload line one\npayload line two" },
        summary: "3 results",
        ...(lifecycle === "failed" ? { error: "it failed" } : {}),
        ...(entry.name === "edit" || entry.name === "write"
          ? { diff: { path: "src/target.ts", before: "old\n", after: "new\n" } }
          : {}),
      };
      for (const [themeName, theme] of themes) {
        for (const width of widths) {
          const lines = new OperationalDisplayComponent(description, DEFAULT_DISPLAY_POLICY, theme, { expanded: false }).render(width);
          if (mutationFamily.has(entry.name)) {
            assert.ok(lines.length >= 1, `${entry.name}/${lifecycle}/${themeName}/${width} renders at least the row`);
          } else {
            assert.equal(lines.length, 1, `${entry.name}/${lifecycle}/${themeName}/${width} collapsed entry is exactly one row`);
            const plain = stripVTControlCharacters(lines.join("\n"));
            assert.doesNotMatch(plain, /payload line/, `${entry.name}/${lifecycle}/${themeName}/${width} hides the payload collapsed`);
          }
        }
      }
    }
  }
}

// ── 19. Wide-tier content column: max(60, floor(0.6 × viewport)) ──

{
  const description = {
    version: 1,
    tool: "bash",
    family: "execution",
    lifecycle: "completed",
    title: "Bash",
    target: `echo ${Array.from({ length: 120 }, () => "x").join("")}`,
    rows: [{ text: "done" }],
  };
  for (const [themeName, theme] of themes) {
    for (const width of widths) {
      const lines = new OperationalDisplayComponent(description, DEFAULT_DISPLAY_POLICY, theme, { expanded: true }).render(width);
      const column = width >= 100 ? Math.max(60, Math.floor(0.6 * width)) : width;
      for (const line of lines) {
        assert.ok(visibleWidth(line) <= width, `${themeName}/${width} bounded by viewport`);
        assert.ok(visibleWidth(stripVTControlCharacters(line).trimEnd()) <= column, `${themeName}/${width} content stays within the column`);
      }
    }
  }
}

// ── 20. Title and target render in neutral tones (state-only hue) ──

{
  const description = {
    version: 1,
    tool: "bash",
    family: "execution",
    lifecycle: "completed",
    title: "Bash",
    target: "npm test",
    durationMs: 42,
  };
  // The dark theme maps toolTitle → accentStrong. The component styles the
  // title with the text token (neutral), the target with muted.
  const header = new OperationalDisplayComponent(description, DEFAULT_DISPLAY_POLICY, darkTheme, { expanded: false }).render(120)[0];
  const plain = stripVTControlCharacters(header);
  assert.match(plain, /Bash/, "title present");
  assert.match(plain, /npm test/, "target present");
  // No accent (state) tone is applied to title or target: strip the ANSI and
  // confirm the marker still carries its lifecycle color.
  assert.match(header, /\u001b\[38;2;113;176;128m\u2713\u001b\[39m/, "marker uses the success state tone");
  // The title text itself is not wrapped in the accentStrong fg code.
  const accentCode = "\u001b[38;2;217;122;82m";
  assert.ok(!header.includes(accentCode), "title and target avoid the accent tone");
}

console.log("visual acceptance tests: OK");
