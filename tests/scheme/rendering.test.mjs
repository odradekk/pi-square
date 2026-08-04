import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";

import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

import {
  loadSandboxModule,
  run,
  test,
} from "./lib/test-helpers.mjs";

initTheme();

const { createSchemeToolDefinition } = await loadSandboxModule("src/tools/scheme.ts");
const definition = createSchemeToolDefinition();
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

test("scheme call shows complete sanitized code, effective access, and explicit timeout", () => {
  const ctx = context({ executionStarted: true });
  const component = definition.renderCall({
    code: `(display "one")\n\x1b]0;owned\x07(display "two")`,
    access: "fullaccess",
    timeoutMs: 5000,
  }, plainTheme, ctx);
  const rendered = plain(component);

  assert.match(rendered, /^scheme  access=fullaccess · timeout=5000ms/m);
  assert.match(rendered, /  \(display "one"\)/);
  assert.match(rendered, /  \(display "two"\)/);
  assert.doesNotMatch(rendered, /owned|\x1b|\x07/);

  const defaultCall = plain(definition.renderCall({ code: "(+ 1 2)" }, plainTheme, context()));
  assert.match(defaultCall, /access=readonly/);
  assert.doesNotMatch(defaultCall, /timeout=/);
});

test("scheme call applies the warning token to fullaccess", () => {
  const colors = [];
  const theme = {
    ...plainTheme,
    fg(color, text) { colors.push(color); return String(text); },
  };
  definition.renderCall({ code: "x", access: "fullaccess" }, theme, context()).render(80);
  assert.ok(colors.includes("warning"));
});

test("collapsed streaming output shows the last five visual lines and elapsed status", () => {
  const state = {};
  const callContext = context({ state, executionStarted: true });
  definition.renderCall({ code: "x" }, plainTheme, callContext);

  const partialContext = context({ state });
  const text = Array.from({ length: 9 }, (_, index) => `line-${index + 1}`).join("\n");
  const component = definition.renderResult(
    result(text, { phase: "evaluating", access: "readonly" }),
    { expanded: false, isPartial: true },
    plainTheme,
    partialContext,
  );
  const rendered = plain(component, 80);

  assert.doesNotMatch(rendered, /line-1(?:\s|$)/);
  assert.match(rendered, /line-9/);
  assert.match(rendered, /earlier visual lines/);
  assert.match(rendered, /Elapsed/);

  definition.renderResult(
    result(`${text}\n-- scheme access=readonly exit=0 duration=1ms`, { access: "readonly", exitCode: 0, durationMs: 1, timedOut: false }),
    { expanded: false, isPartial: false },
    plainTheme,
    { ...partialContext, lastComponent: component },
  );
});

test("expanded output shows all selected content and a collapse hint", () => {
  const text = Array.from({ length: 9 }, (_, index) => `line-${index + 1}`).join("\n");
  const rendered = plain(definition.renderResult(
    result(text, { access: "readonly", durationMs: 5 }),
    { expanded: true, isPartial: false },
    plainTheme,
    context(),
  ));

  assert.match(rendered, /line-1/);
  assert.match(rendered, /line-9/);
  assert.match(rendered, /collapse/);
  assert.match(rendered, /Took/);
});

test("renderer removes terminal controls and surfaces truncation metadata", () => {
  const rendered = plain(definition.renderResult(
    result("safe\x1b]8;;https://evil.example\x07linked\x1b]8;;\x07\u0000tail", {
      access: "readonly",
      truncated: true,
      outputLimitBytes: 524288,
      durationMs: 3,
    }),
    { expanded: true, isPartial: false },
    plainTheme,
    context(),
  ));

  assert.match(rendered, /safelinkedtail/);
  assert.match(rendered, /Output limit reached \(524288 byte limit\)/);
  assert.doesNotMatch(rendered, /evil\.example|\x1b|\x07|\u0000/);
});

test("renderer falls back to complete content when details are absent", () => {
  const tail = "unique-legacy-tail";
  const content = `${"legacy output ".repeat(100)}${tail}`;
  const rendered = plain(definition.renderResult(
    { content: [{ type: "text", text: content }] },
    { expanded: true, isPartial: false },
    plainTheme,
    context(),
  ), 40);
  assert.match(rendered, new RegExp(tail));
});

test("scheme call and result stay within every display boundary width", () => {
  for (const width of [39, 40, 63, 64, 80, 99, 100, 120]) {
    const call = definition.renderCall({
      code: `(define (very-long-function-name value) (display value))\n(very-long-function-name "${"x".repeat(120)}")`,
      access: "write",
      timeoutMs: 120000,
    }, plainTheme, context());
    const output = definition.renderResult(
      result(`${"long-output-token ".repeat(40)}\n-- scheme access=write exit=0 duration=1ms`, { access: "write", durationMs: 1 }),
      { expanded: false, isPartial: false },
      plainTheme,
      context(),
    );
    for (const component of [call, output]) {
      for (const line of component.render(width)) {
        assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} exceeds ${width}: ${JSON.stringify(line)}`);
      }
    }
  }
});

await run();
