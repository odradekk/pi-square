import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import { visibleWidth } from "@earendil-works/pi-tui";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const load = (await import("jiti")).default(import.meta.url, { moduleCache: false });
const rosterModule = await load(join(packageRoot, "src", "subagents", "roster.ts"));
const backgroundModule = await load(join(packageRoot, "src", "subagents", "background.ts"));
const {
  SUBAGENT_ROSTER_KEY,
  createSubagentRosterController,
  createSubagentRosterWidget,
  formatRosterDuration,
  renderSubagentRoster,
  rosterRowBudget,
  uniqueRosterIdPrefixes,
} = rosterModule;
const { createBackgroundState } = backgroundModule;
const { MotionScheduler } = await load(join(packageRoot, "src", "display", "motion.ts"));

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function plainTheme() {
  return {
    fg(_color, text) { return String(text); },
    bg(_color, text) { return String(text); },
    bold(text) { return String(text); },
  };
}

function trackingTheme() {
  const calls = [];
  return {
    calls,
    fg(color, text) { calls.push({ color, text: String(text) }); return String(text); },
    bg(_color, text) { return String(text); },
    bold(text) { return String(text); },
  };
}

function row(overrides = {}) {
  return {
    id: "subagent_11111111-1111-4111-8111-111111111111",
    role: "explorer",
    status: "running",
    startedAt: 0,
    endedAt: undefined,
    activity: "rg data in src",
    ...overrides,
  };
}

function job(id, status, createdAt, name, timeline = [], overrides = {}) {
  return {
    id,
    status,
    createdAt,
    updatedAt: createdAt + 1,
    abortController: new AbortController(),
    details: {
      startedAt: createdAt,
      endedAt: ["completed", "failed", "aborted"].includes(status) ? createdAt + 90_000 : undefined,
      agent: { name },
      lastParentSessionId: "parent-1",
      timeline,
      ...overrides,
    },
  };
}

function toolTimeline(call, result = "SECRET TOOL RESULT") {
  return [
    { kind: "tool", phase: "start", text: call },
    { kind: "tool", phase: "end", text: result },
  ];
}

function uiContext({ sessionId = "parent-1", mode = "tui" } = {}) {
  const calls = [];
  const ctx = {
    mode,
    hasUI: true,
    ui: {
      theme: plainTheme(),
      setWidget(key, content, options) { calls.push({ key, content, options }); },
    },
    sessionManager: { getSessionId: () => sessionId },
  };
  return { ctx, calls };
}

function motionHarness(mode) {
  const harness = fakeClock();
  const scheduler = new MotionScheduler(mode, harness.clock);
  return {
    ...harness,
    scheduler,
    motion: { subscribe: (listener) => scheduler.subscribe(listener) },
    subscribers: () => scheduler.subscriberCount,
  };
}

function fakeClock() {
  const intervals = new Map();
  let seq = 0;
  const clock = {
    setInterval(callback, milliseconds) {
      seq += 1;
      intervals.set(seq, { callback, milliseconds });
      return seq;
    },
    clearInterval(handle) { intervals.delete(handle); },
    unref() {},
  };
  return {
    clock,
    count: () => intervals.size,
    fire: () => { for (const { callback } of [...intervals.values()]) callback(); },
    intervalMs: () => [...intervals.values()][0]?.milliseconds,
  };
}

function renderCalls(calls) {
  const last = calls.at(-1);
  assert.ok(last, "widget call recorded");
  assert.equal(last.key, SUBAGENT_ROSTER_KEY);
  assert.deepEqual(last.options, { placement: "aboveEditor" });
  return last;
}

function renderLast(calls, width = 80, terminalRows = 30, theme = plainTheme()) {
  const last = renderCalls(calls);
  assert.equal(typeof last.content, "function", "widget content is a component factory");
  return last.content({ terminal: { rows: terminalRows } }, theme)
    .render(width)
    .map(stripVTControlCharacters);
}

const LIFECYCLES = [
  ["queued", "– queued", "muted"],
  ["running", "● running", "accent"],
  ["cancelling", "× cancelling", "warning"],
  ["completed", "✓ completed", "success"],
  ["failed", "✗ failed", "error"],
  ["aborted", "× aborted", "muted"],
];

test("renders every lifecycle value with the operational vocabulary and no extra rows", () => {
  const rows = LIFECYCLES.map(([status], index) => row({
    id: `subagent_${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`,
    status,
  }));
  const lines = renderSubagentRoster(plainTheme(), rows, { width: 80, rowBudget: 10, now: 5_000 });
  assert.equal(lines.length, LIFECYCLES.length, "one line per job — main is never synthesized");
  for (const [index, [, label]] of LIFECYCLES.entries()) {
    assert.ok(lines[index].includes(label), `${label} renders`);
    assert.ok(lines[index].includes(String(index).padStart(8, "0")), "every row carries its own ID prefix");
  }
  assert.ok(lines.every((line) => line.startsWith("○ ")), "every row carries the hollow selection marker");
});

test("lifecycle vocabulary uses the semantic tones of the calm display", () => {
  const theme = trackingTheme();
  renderSubagentRoster(theme, LIFECYCLES.map(([status], index) => row({
    id: `subagent_${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`,
    status,
  })), { width: 80, rowBudget: 10, now: 0 });
  for (const [status, label, tone] of LIFECYCLES) {
    assert.ok(
      theme.calls.some((call) => call.color === tone && call.text === label),
      `${status} label ${label} uses ${tone}`,
    );
  }
});

test("prefixes start at eight characters and extend only as far as needed", () => {
  const ids = [
    "subagent_12345678-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "subagent_12345678-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    "subagent_99999999-zzzz-4zzz-8zzz-zzzzzzzzzzzz",
  ];
  const prefixes = uniqueRosterIdPrefixes(ids);
  assert.equal(prefixes.get(ids[2]), "99999999", "non-colliding prefix stays at eight");
  assert.equal(prefixes.get(ids[0]), "12345678-a", "first colliding prefix extends minimally");
  assert.equal(prefixes.get(ids[1]), "12345678-b", "second colliding prefix extends minimally");

  const lines = renderSubagentRoster(plainTheme(), ids.map((id) => row({ id })), {
    width: 80,
    rowBudget: 10,
    now: 0,
  });
  assert.match(lines[0], /12345678-a/);
  assert.match(lines[1], /12345678-b/);
  assert.match(lines[2], /99999999 /);
});

test("rows keep roster-creation order across lifecycle changes; createdAt orders, full ID ties", () => {
  const state = createBackgroundState();
  const { ctx, calls } = uiContext();
  const controller = createSubagentRosterController(state);
  controller.start(ctx);

  const earlier = job("subagent_dddddddd-dddd-4ddd-8ddd-dddddddddddd", "queued", 1, "crawler");
  const later = job("subagent_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "queued", 2, "explorer");
  state.jobs.set(earlier.id, earlier);
  state.jobs.set(later.id, later);
  for (const listener of state.listeners) listener();

  // One observation batch with different creation times: createdAt decides,
  // even though the later-created job has the smaller public ID.
  let lines = renderLast(calls);
  assert.ok(lines[0].includes("dddddddd"), "earlier createdAt wins over full-ID order");
  assert.ok(lines[1].includes("aaaaaaaa"));

  // A same-createdAt pair appended later: the full public ID breaks the tie.
  const tieA = job("subagent_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "running", 5, "oracle");
  const tieB = job("subagent_cccccccc-cccc-4ccc-8ccc-cccccccccccc", "running", 5, "generalist");
  state.jobs.set(tieA.id, tieA);
  state.jobs.set(tieB.id, tieB);
  for (const listener of state.listeners) listener();
  lines = renderLast(calls);
  assert.equal(lines.length, 4);
  assert.ok(lines[2].includes("bbbbbbbb"), "exact createdAt tie breaks by full public ID");
  assert.ok(lines[3].includes("cccccccc"));
  assert.ok(lines[3].indexOf("cccccccc") > lines[2].indexOf("bbbbbbbb"));

  // Lifecycle and activity updates must never reorder rows.
  earlier.status = "completed";
  earlier.updatedAt = 99;
  later.status = "cancelling";
  later.updatedAt = 98;
  tieA.updatedAt = 97;
  for (const listener of state.listeners) listener();
  lines = renderLast(calls);
  assert.ok(
    lines[0].includes("dddddddd") && lines[1].includes("aaaaaaaa")
    && lines[2].includes("bbbbbbbb") && lines[3].includes("cccccccc"),
    "status and recency changes never reorder roster rows",
  );

  controller.stop();
});

test("a resumed public ID keeps one row and its roster slot", () => {
  const state = createBackgroundState();
  const { ctx, calls } = uiContext();
  const controller = createSubagentRosterController(state);
  controller.start(ctx);

  const id = "subagent_cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const original = job(id, "running", 1, "explorer");
  state.jobs.set(id, original);
  for (const listener of state.listeners) listener();

  original.status = "completed";
  original.updatedAt = 10;
  for (const listener of state.listeners) listener();

  const later = job("subagent_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "running", 20, "crawler");
  state.jobs.set(later.id, later);
  for (const listener of state.listeners) listener();
  let lines = renderLast(calls);
  assert.equal(lines.length, 2);
  assert.ok(lines[0].includes("cccccccc"), "original slot preserved");

  // Same public ID resumed: one identity, still one row, still first.
  const resumed = job(id, "queued", 30, "explorer");
  resumed.details.lastParentSessionId = "parent-1";
  state.jobs.set(id, resumed);
  for (const listener of state.listeners) listener();
  lines = renderLast(calls);
  assert.equal(lines.filter((line) => line.includes("cccccccc")).length, 1, "no duplicate row for a resumed ID");
  assert.equal(lines.length, 2);
  assert.ok(lines[0].includes("cccccccc"));
  assert.match(lines[0], /– queued/);

  controller.stop();
});

test("width pressure drops activity, then duration, then truncates the role", () => {
  const base = row({ role: "explorer", activity: "rg data" });
  // core = "○ " (2) + role (8) + " " + id (8) + " " + "● running" (9) = 29.
  // duration at now-startedAt = 12s → segment " · 12s" (6); activity "rg data" → " · rg data" (10).

  const full = renderSubagentRoster(plainTheme(), [base], { width: 45, rowBudget: 10, now: 12_000 })[0];
  assert.match(full, /12s/);
  assert.match(full, /rg data/);

  const withoutActivity = renderSubagentRoster(plainTheme(), [base], { width: 44, rowBudget: 10, now: 12_000 })[0];
  assert.match(withoutActivity, /12s/, "duration survives");
  assert.doesNotMatch(withoutActivity, /rg data/, "activity dropped first");

  const withoutDuration = renderSubagentRoster(plainTheme(), [base], { width: 34, rowBudget: 10, now: 12_000 })[0];
  assert.doesNotMatch(withoutDuration, /12s|rg data/, "duration dropped next");
  assert.match(withoutDuration, /explorer/);

  const truncatedRole = stripVTControlCharacters(
    renderSubagentRoster(plainTheme(), [base], { width: 27, rowBudget: 10, now: 12_000 })[0],
  );
  assert.ok(truncatedRole.includes("explo…"), "role truncates under extreme pressure");
  assert.doesNotMatch(truncatedRole, /explorer/, "full role no longer fits");
  assert.ok(truncatedRole.startsWith("○ "), "marker preserved");
  assert.match(truncatedRole, /11111111/, "unique ID preserved");
  assert.match(truncatedRole, /● running/, "lifecycle preserved");
  assert.ok(visibleWidth(truncatedRole) <= 27, "row stays one physical line");
});

test("long-colliding IDs stay distinguishable with lifecycle intact at narrow widths", () => {
  // Legal public IDs that share every character until position 35 of the ID.
  const idA = "subagent_11111111-1111-4111-8111-111111111111";
  const idB = "subagent_11111111-1111-4111-8111-111111111112";
  const rows = [
    row({ id: idA, status: "running", activity: "" }),
    row({ id: idB, status: "running", activity: "" }),
  ];

  for (const width of [30, 35]) {
    const lines = renderSubagentRoster(plainTheme(), rows, { width, rowBudget: 10, now: 0 })
      .map(stripVTControlCharacters);
    assert.equal(lines.length, 2, `width ${width}: both children render`);
    assert.notEqual(lines[0], lines[1], `width ${width}: colliding rows stay distinguishable`);
    for (const line of lines) {
      assert.ok(line.startsWith("○ "), `width ${width}: selection marker preserved`);
      assert.match(line, /● running/, `width ${width}: lifecycle preserved`);
      assert.ok(line.includes("…"), `width ${width}: over-long prefix elides instead of overwriting the lifecycle`);
      assert.ok(visibleWidth(line) <= width, `width ${width}: one physical line`);
    }
    assert.ok(lines.every((line) => line.includes("11111111…")), `width ${width}: elision keeps the eight-character head`);
  }

  // Wide terminals still show the fully extended unique prefixes.
  const wide = renderSubagentRoster(plainTheme(), rows, { width: 80, rowBudget: 10, now: 0 })
    .map(stripVTControlCharacters);
  assert.notEqual(wide[0], wide[1]);
  assert.match(wide[0], /11111111-1111-4111-8111-111111111111 ● running/);
  assert.match(wide[1], /11111111-1111-4111-8111-111111111112 ● running/);
});

test("height-only resize immediately recomputes the row budget", () => {
  const rows = Array.from({ length: 13 }, (_, index) => row({
    id: `subagent_${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`,
  }));
  const tui = { terminal: { rows: 40 } };
  const widget = createSubagentRosterWidget(tui, plainTheme(), rows, 0);

  const tall = widget.render(80);
  assert.equal(tall.length, 11, "40-row terminal shows ten rows plus accounting");

  tui.terminal.rows = 12;
  const short = widget.render(80);
  assert.equal(short.length, rosterRowBudget(12) + 1, "height-only resize shrinks the budget at once");
  assert.match(stripVTControlCharacters(short.at(-1)), /\+\d+ more/);

  tui.terminal.rows = 40;
  assert.equal(widget.render(80).length, 11, "growing back recomputes too");
});

test("roster activity shows shell tools as called and never exposes command text", () => {
  const state = createBackgroundState();
  const { ctx, calls } = uiContext();
  const controller = createSubagentRosterController(state);
  controller.start(ctx);

  const command = [
    "curl -ualice:swordfish https://api.test",
    "curl --user=alice:swordfish https://api.test",
    "curl https://alice:swordfish@example.test",
    "AWS_SECRET_ACCESS_KEY=swordfish aws s3 ls",
    "aws configure set aws_secret_access_key swordfish",
    'deploy --token "my secret value"',
  ].join(" && ");
  const secret = job(
    "subagent_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "running",
    1,
    "explorer",
    [
      { kind: "tool", phase: "start", text: `bash ${JSON.stringify({ command })}` },
      { kind: "tool", phase: "end", text: "SECRET TOOL RESULT" },
    ],
  );
  state.jobs.set(secret.id, secret);
  for (const listener of state.listeners) listener();

  const line = renderLast(calls, 200)[0];
  assert.match(line, /bash called/, "shell activity is the generic allowlisted summary");
  assert.doesNotMatch(
    line,
    /swordfish|alice|my secret|AWS_SECRET|aws_secret|example\.test|api\.test|SECRET TOOL RESULT/,
  );
  assert.match(line, /^○ explorer aaaaaaaa ● running/, "identity and lifecycle survive the summary");
  controller.stop();
});

test("unicode content renders within the width budget on every row", () => {
  const rows = [
    row({ role: "探索".repeat(6), activity: "界".repeat(60), id: "subagent_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
    row({ role: "crawler", activity: "read 界界界 file", id: "subagent_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }),
  ];
  for (const width of [30, 40, 63, 64, 80, 99, 100, 120]) {
    const lines = renderSubagentRoster(plainTheme(), rows, { width, rowBudget: 10, now: 30_000 });
    assert.equal(lines.length, 2);
    for (const line of lines) {
      assert.ok(visibleWidth(line) <= width, `width ${width} row bounded`);
      assert.ok(!line.includes("\n"), "no physical line breaks inside a row");
    }
    assert.ok(lines.every((line) => /● running/.test(line)), `width ${width} keeps lifecycle`);
    assert.ok(lines.every((line) => /aaaaaaaa|bbbbbbbb/.test(line)), `width ${width} keeps ID`);
  }
});

test("durations format compactly and freeze for terminal rows", () => {
  assert.equal(formatRosterDuration(0), "0s");
  assert.equal(formatRosterDuration(59_400), "59s");
  assert.equal(formatRosterDuration(60_000), "1m 00s");
  assert.equal(formatRosterDuration(3_545_000), "59m 05s");
  assert.equal(formatRosterDuration(3_725_000), "1h 02m");
  assert.equal(formatRosterDuration(3_600_000), "1h 00m");
  assert.equal(formatRosterDuration(7_540_000), "2h 05m");

  const terminal = row({ status: "completed", startedAt: 1_000, endedAt: 91_000 });
  for (const now of [91_000, 500_000]) {
    const line = renderSubagentRoster(plainTheme(), [terminal], { width: 80, rowBudget: 10, now })[0];
    assert.match(line, /1m 30s/, "terminal duration stays at its ended timestamp");
  }

  const active = row({ status: "running", startedAt: 0, endedAt: undefined });
  assert.match(
    renderSubagentRoster(plainTheme(), [active], { width: 80, rowBudget: 10, now: 65_000 })[0],
    /1m 05s/,
  );
});

test("terminal children without tool calls show no activity; active children show working", () => {
  const completed = row({ status: "completed", activity: "" });
  const line = renderSubagentRoster(plainTheme(), [completed], { width: 80, rowBudget: 10, now: 0 })[0];
  assert.doesNotMatch(line, /working/);

  const state = createBackgroundState();
  const { ctx, calls } = uiContext();
  const controller = createSubagentRosterController(state);
  controller.start(ctx);
  const active = job("subagent_11111111-1111-4111-8111-111111111111", "queued", 1, "explorer", []);
  state.jobs.set(active.id, active);
  for (const listener of state.listeners) listener();
  assert.match(renderLast(calls)[0], /working/);
  controller.stop();
});

test("row budget caps at ten on normal heights and shrinks on short terminals", () => {
  assert.equal(rosterRowBudget(40), 10);
  assert.equal(rosterRowBudget(80), 10);
  assert.ok(rosterRowBudget(24) < 10, "24-row terminal reduces the budget");
  assert.ok(rosterRowBudget(12) <= rosterRowBudget(24), "shorter terminals never gain budget");
  assert.ok(rosterRowBudget(6) >= 1, "even tiny terminals keep a row");

  const rows = Array.from({ length: 13 }, (_, index) => row({
    id: `subagent_${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`,
  }));
  const lines = renderSubagentRoster(plainTheme(), rows, { width: 80, rowBudget: rosterRowBudget(40), now: 0 });
  assert.equal(lines.length, 11, "ten child rows plus one accounting line");
  assert.match(lines.at(-1), /^\… \+3 more$/);

  const widget = createSubagentRosterWidget({ terminal: { rows: 24 } }, plainTheme(), rows, 0);
  const short = widget.render(80);
  assert.equal(short.length, rosterRowBudget(24) + 1, "short terminal shows fewer rows plus accounting");
  assert.match(stripVTControlCharacters(short.at(-1)), /\+\d+ more/);

  // Even a tiny terminal keeps every physical line within its width.
  const tiny = widget.render(9);
  for (const line of tiny) {
    const plain = stripVTControlCharacters(line);
    assert.ok(visibleWidth(plain) <= 9, `tiny-width line bounded: ${JSON.stringify(plain)}`);
    assert.ok(plain.length > 0);
  }
});

test("sanitizes controls and credentials and never exposes tool results", () => {
  const state = createBackgroundState();
  const { ctx, calls } = uiContext();
  const controller = createSubagentRosterController(state);
  controller.start(ctx);

  const secret = job(
    "subagent_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "running",
    1,
    "explorer\u001b[31m\n\r",
    toolTimeline("read Authorization: Bearer exposed-token password=hunter2"),
  );
  state.jobs.set(secret.id, secret);
  for (const listener of state.listeners) listener();

  const line = renderLast(calls, 120)[0];
  assert.match(line, /Authorization: \[REDACTED\]/);
  assert.doesNotMatch(line, /exposed-token|hunter2|SECRET TOOL RESULT/);
  assert.doesNotMatch(line, /\r|\n|\t|\u001b/);
  assert.match(line, /^○ explorer aaaaaaaa ● running/);
  controller.stop();
});

test("controller clears the widget when no current-parent children remain", () => {
  const state = createBackgroundState();
  const { ctx, calls } = uiContext();
  const controller = createSubagentRosterController(state);
  controller.start(ctx);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].content, undefined, "empty session publishes no widget");

  const running = job("subagent_11111111-1111-4111-8111-111111111111", "running", 1, "explorer");
  state.jobs.set(running.id, running);
  for (const listener of state.listeners) listener();
  assert.equal(typeof calls.at(-1).content, "function");

  state.jobs.delete(running.id);
  for (const listener of state.listeners) listener();
  assert.equal(calls.at(-1).content, undefined, "widget removed with the last child");
  controller.stop();
});

test("foreign parent-session jobs never render", () => {
  const state = createBackgroundState();
  const { ctx, calls } = uiContext({ sessionId: "parent-1" });
  const controller = createSubagentRosterController(state);
  controller.start(ctx);

  const mine = job("subagent_11111111-1111-4111-8111-111111111111", "running", 1, "explorer");
  const foreign = job("subagent_22222222-2222-4222-8222-222222222222", "running", 2, "crawler");
  foreign.details.lastParentSessionId = "earlier-session";
  state.jobs.set(mine.id, mine);
  state.jobs.set(foreign.id, foreign);
  for (const listener of state.listeners) listener();

  const lines = renderLast(calls);
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes("explorer"));
  controller.stop();
});

function activeJob() {
  const running = job("subagent_11111111-1111-4111-8111-111111111111", "running", 1_000, "explorer");
  running.details.startedAt = 1_000;
  return running;
}

test("duration ticking follows the session motion scheduler while a child is active", () => {
  const state = createBackgroundState();
  const harness = motionHarness("reduced");
  let current = 1_000;
  const { ctx, calls } = uiContext();
  const controller = createSubagentRosterController(state, {
    now: () => current,
    motion: () => harness.motion,
  });
  controller.start(ctx);

  const running = activeJob();
  state.jobs.set(running.id, running);
  for (const listener of state.listeners) listener();
  assert.equal(harness.subscribers(), 1, "active child subscribes to the motion scheduler");
  assert.equal(harness.intervalMs(), 1_000, "reduced motion drives the duration cadence directly");
  assert.match(renderLast(calls, 80, 30)[0], /0s/);

  current = 125_000;
  const publishesBefore = calls.length;
  harness.fire();
  assert.ok(calls.length > publishesBefore, "tick republishes the widget with a fresh duration");
  assert.match(renderLast(calls, 80, 30)[0], /2m 04s/);

  running.status = "completed";
  running.updatedAt = current;
  running.details.endedAt = current;
  for (const listener of state.listeners) listener();
  assert.equal(harness.subscribers(), 0, "settled roster unsubscribes from the motion scheduler");
  assert.match(renderLast(calls, 80, 30)[0], /2m 04s/, "terminal duration frozen at endedAt");

  controller.stop();
  assert.equal(harness.subscribers(), 0);
});

test("motion off never schedules a timer; durations advance only through state changes", () => {
  const state = createBackgroundState();
  const harness = motionHarness("off");
  let current = 1_000;
  const { ctx, calls } = uiContext();
  const controller = createSubagentRosterController(state, {
    now: () => current,
    motion: () => harness.motion,
  });
  controller.start(ctx);

  const running = activeJob();
  state.jobs.set(running.id, running);
  for (const listener of state.listeners) listener();
  assert.equal(harness.subscribers(), 1, "subscription exists but the off scheduler owns no timer");
  assert.equal(harness.count(), 0, "motion off creates no interval at all");

  current = 65_000;
  const publishesBefore = calls.length;
  harness.fire();
  assert.equal(calls.length, publishesBefore, "no timer means no tick to fire");
  assert.match(renderLast(calls, 80, 30)[0], /0s/, "duration stays at the last state-change publish");

  // A background state change still republishes with the advanced duration.
  running.details.timeline.push({ kind: "tool", phase: "start", text: "read src" });
  for (const listener of state.listeners) listener();
  assert.match(renderLast(calls, 80, 30)[0], /1m 04s/);

  controller.stop();
  assert.equal(harness.subscribers(), 0, "teardown unsubscribes even without a timer");
});

test("full-motion ticks are throttled to the duration cadence", () => {
  const state = createBackgroundState();
  const harness = motionHarness("full");
  let current = 1_000;
  const { ctx, calls } = uiContext();
  const controller = createSubagentRosterController(state, {
    now: () => current,
    motion: () => harness.motion,
  });
  controller.start(ctx);

  const running = activeJob();
  state.jobs.set(running.id, running);
  for (const listener of state.listeners) listener();
  assert.equal(harness.intervalMs(), 120, "full motion fires at the display cadence");

  const initialPublishes = calls.length;
  for (let tick = 1; tick <= 8; tick += 1) {
    current += 120;
    harness.fire();
  }
  assert.equal(calls.length, initialPublishes, "sub-second motion ticks publish nothing");

  current += 120; // ≈1.08s since the last publish
  harness.fire();
  assert.equal(calls.length, initialPublishes + 1, "one publish per duration cadence");
  assert.match(renderLast(calls, 80, 30)[0], /1s/, "republished duration advanced");

  controller.stop();
  assert.equal(harness.subscribers(), 0);
});

test("a roster without a motion source still presents but owns no ticking path", () => {
  const state = createBackgroundState();
  const { ctx, calls } = uiContext();
  const controller = createSubagentRosterController(state);
  controller.start(ctx);
  const running = activeJob();
  state.jobs.set(running.id, running);
  for (const listener of state.listeners) listener();
  assert.equal(typeof calls.at(-1).content, "function", "state changes still publish");
  controller.stop();
  assert.equal(calls.at(-1).content, undefined, "teardown clears the widget");
});

test("teardown unsubscribes, clears the widget, and survives session replacement", () => {
  const state = createBackgroundState();
  const first = uiContext({ sessionId: "parent-1" });
  const controller = createSubagentRosterController(state);
  controller.start(first.ctx);

  const running = job("subagent_11111111-1111-4111-8111-111111111111", "running", 1, "explorer");
  state.jobs.set(running.id, running);
  for (const listener of state.listeners) listener();
  assert.equal(typeof first.calls.at(-1).content, "function");

  // Replacement: a new parent session clears the old session's widget first.
  const second = uiContext({ sessionId: "parent-2" });
  controller.start(second.ctx);
  assert.equal(first.calls.at(-1).content, undefined, "prior session's widget cleared");
  assert.equal(second.calls.at(-1).content, undefined, "new session with no children publishes nothing");
  assert.equal(state.listeners.size, 1, "exactly one active subscription");

  // Shutdown teardown.
  controller.stop();
  assert.equal(state.listeners.size, 0);
  assert.equal(second.calls.at(-1).content, undefined, "widget cleared on stop");
});

test("controller never touches the UI without an interactive TUI context", () => {
  const state = createBackgroundState();
  for (const ctx of [
    { mode: "tui", hasUI: false },
    { mode: "rpc", hasUI: true },
    { mode: "print", hasUI: false },
  ]) {
    const calls = [];
    const controller = createSubagentRosterController(state);
    controller.start({
      ...ctx,
      ui: { setWidget(...args) { calls.push(args); } },
      sessionManager: { getSessionId: () => "parent-1" },
    });
    const running = job("subagent_11111111-1111-4111-8111-111111111111", "running", 1, "explorer");
    state.jobs.set(running.id, running);
    for (const listener of state.listeners) listener();
    assert.equal(state.listeners.size, 0, `no subscription in ${ctx.mode} mode without an interactive TUI`);
    assert.equal(calls.length, 0, `no widget in ${ctx.mode} mode`);
    controller.refresh();
    controller.stop();
  }
});

test("widget caches rendered lines by width and drops them on invalidate", () => {
  const rows = [row()];
  const widget = createSubagentRosterWidget({ terminal: { rows: 30 } }, plainTheme(), rows, 5_000);
  const first = widget.render(80);
  assert.strictEqual(widget.render(80), first, "same width returns cached lines");
  const wider = widget.render(120);
  assert.notStrictEqual(wider, first, "new width recomputes");
  widget.invalidate();
  assert.notStrictEqual(widget.render(80), first, "invalidate drops the cache");
});

test("real themes render bounded output at every display boundary width", async () => {
  const { loadThemeFromPath } = await import(pathToFileURL(join(
    packageRoot, "node_modules", "@earendil-works", "pi-coding-agent",
    "dist", "modes", "interactive", "theme", "theme.js",
  )).href);
  const rows = Array.from({ length: 14 }, (_, index) => row({
    id: `subagent_${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`,
    role: index % 2 === 0 ? `探索${index}`.repeat(6) : `explorer-${index}`,
    status: LIFECYCLES[index % LIFECYCLES.length][0],
    activity: index % 3 === 0 ? "界".repeat(50) : `rg token-${index} in src`,
    startedAt: 0,
    endedAt: index % 4 === 0 ? 250_000 : undefined,
  }));
  for (const file of ["pi-square-theme-dark.json", "pi-square-theme-light.json"]) {
    const theme = loadThemeFromPath(join(packageRoot, "themes", file));
    for (const terminalRows of [18, 24, 40, 80]) {
      const budget = rosterRowBudget(terminalRows);
      const widget = createSubagentRosterWidget({ terminal: { rows: terminalRows } }, theme, rows, 65_000);
      for (const width of [30, 39, 40, 63, 64, 80, 99, 100, 120]) {
        const lines = widget.render(width);
        assert.ok(lines.length <= budget + 1, `${file} rows=${terminalRows} w=${width} bounded to budget`);
        for (const line of lines) {
          assert.ok(visibleWidth(line) <= width, `${file} rows=${terminalRows} w=${width} line bounded`);
          assert.ok(stripVTControlCharacters(line).length > 0, "no empty rendered row");
        }
      }
    }
  }
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`PASS: ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL: ${name} — ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  }
}
console.log(`\n${tests.length} tests, ${failed} failed`);
if (failed > 0) process.exit(1);
