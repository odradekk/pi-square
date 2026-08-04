import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import jiti from "jiti";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

initTheme();
const packageRoot = resolve(import.meta.dirname, "..", "..");
const load = jiti(import.meta.url, { moduleCache: false });
const { createPwshToolDefinition } = await load(resolve(packageRoot, "src", "shell", "tools", "pwsh.ts"));
const themeModulePath = pathToFileURL(resolve(
  packageRoot,
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
  fg(_color, text) { return String(text); },
  bold(text) { return String(text); },
  bg(_color, text) { return String(text); },
};

function context(overrides = {}) {
  return {
    state: {},
    lastComponent: undefined,
    executionStarted: false,
    isError: false,
    showImages: false,
    invalidate() {},
    ...overrides,
  };
}

function plain(component, width = 80) {
  return component.render(width).map((line) => stripVTControlCharacters(line)).join("\n");
}

function result(text, details = {}) {
  return { content: [{ type: "text", text }], details };
}

const pwsh = createPwshToolDefinition({ probe: async () => ({ available: false, binary: null }) });

{
  assert.equal(pwsh.renderShell, undefined);
  const ctx = context({ executionStarted: true });
  const call = pwsh.renderCall({
    command: "Get-Process |\n  Where-Object CPU -gt 10\n\x1b]0;owned\x07Write-Output done",
    cwd: "C:\\work",
    timeoutMs: 5000,
  }, plainTheme, ctx);
  const rendered = plain(call);
  assert.match(rendered, /^PS> Get-Process \|/m);
  assert.match(rendered, /^      Where-Object CPU -gt 10/m);
  assert.match(rendered, /^    Write-Output done/m);
  assert.match(rendered, /cwd=C:\\work/);
  assert.match(rendered, /timeout=5\.0s/);
  assert.doesNotMatch(rendered, /owned|\x1b|\x07/);

  const reused = pwsh.renderCall({ command: "Write-Output next" }, plainTheme, { ...ctx, lastComponent: call });
  assert.equal(reused, call);
  assert.match(plain(reused), /^PS> Write-Output next/m);
}

{
  const state = {};
  pwsh.renderCall({ command: "Write-Output x" }, plainTheme, context({ state, executionStarted: true }));
  const outputText = Array.from({ length: 9 }, (_, index) => `line-${index + 1}`).join("\n");
  const ctx = context({ state });
  const component = pwsh.renderResult(
    result(outputText, { phase: "running", flavor: "pwsh", version: "7.6.0" }),
    { expanded: false, isPartial: true },
    plainTheme,
    ctx,
  );
  const rendered = plain(component);
  assert.doesNotMatch(rendered, /line-1(?:\s|$)/);
  assert.match(rendered, /line-9/);
  assert.match(rendered, /earlier visual lines/);
  assert.match(rendered, /Elapsed/);

  const reused = pwsh.renderResult(
    result(outputText, { flavor: "pwsh", version: "7.6.0", exitCode: 0, durationMs: 10 }),
    { expanded: false, isPartial: false },
    plainTheme,
    { ...ctx, lastComponent: component },
  );
  assert.equal(reused, component);
}

{
  const text = Array.from({ length: 9 }, (_, index) => `line-${index + 1}`).join("\n");
  const rendered = plain(pwsh.renderResult(
    result(text, { flavor: "windows-powershell", version: "5.1", exitCode: 0, durationMs: 20 }),
    { expanded: true, isPartial: false },
    plainTheme,
    context(),
  ));
  assert.match(rendered, /line-1/);
  assert.match(rendered, /line-9/);
  assert.match(rendered, /Took/);
  assert.match(rendered, /Windows PowerShell 5\.1/);
}

{
  const details = {
    flavor: "pwsh",
    version: "7.6.0",
    durationMs: 3,
    truncation: { truncated: true, truncatedBy: "bytes", outputLines: 2, totalLines: 8, maxBytes: 51200 },
    fullOutputPath: "/tmp/pi-pwsh.log",
  };
  const rendered = plain(pwsh.renderResult(
    result("safe\x1b]8;;https://evil.example\x07linked\x1b]8;;\x07\u0000tail", details),
    { expanded: true, isPartial: false },
    plainTheme,
    context(),
  ));
  assert.match(rendered, /safelinked\\x00tail/);
  assert.match(rendered, /Full output: \/tmp\/pi-pwsh\.log/);
  assert.match(rendered, /Truncated/);
  assert.doesNotMatch(rendered, /evil\.example|\x1b|\x07/);

  const withModelFooter = plain(pwsh.renderResult(
    result("tail\n\n[Showing lines 7-8 of 8. Full output: /tmp/pi-pwsh.log]", details),
    { expanded: true, isPartial: false },
    plainTheme,
    context(),
  ));
  assert.equal(withModelFooter.match(/Full output:/g)?.length, 1);
  assert.doesNotMatch(withModelFooter, /Showing lines 7-8/);
}

{
  for (const themeName of ["pi-square-theme-dark", "pi-square-theme-light"]) {
    const realTheme = loadThemeFromPath(resolve(packageRoot, "themes", `${themeName}.json`));
    for (const width of [39, 40, 63, 64, 80, 99, 100, 120]) {
      const call = pwsh.renderCall({
        command: `Get-ChildItem -Recurse | Where-Object Name -Like \"${"x".repeat(100)}\"`,
        cwd: `C:\\${"very-long-path\\".repeat(8)}`,
        timeoutMs: 600000,
      }, realTheme, context());
      const output = pwsh.renderResult(
        result(`${"long-output-token ".repeat(40)}\nlast`, { flavor: "pwsh", version: "7.6.0", durationMs: 4 }),
        { expanded: false, isPartial: false },
        realTheme,
        context(),
      );
      for (const component of [call, output]) {
        for (const line of component.render(width)) {
          assert.ok(visibleWidth(line) <= width, `${themeName}: ${visibleWidth(line)} exceeds ${width}: ${JSON.stringify(line)}`);
        }
      }
    }
  }
}

console.log("shell rendering tests: OK");
