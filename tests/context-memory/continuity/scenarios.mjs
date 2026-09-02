import {
  MARKER,
  WINDOW,
  DUE_CONFIG,
  format,
  userEntry,
  assistantEntry,
  memoryCompaction,
} from "../qualification/harness.mjs";

/**
 * The four long-session continuity qualification scenarios (#224, revised by
 * #261).
 *
 * Each scenario is one scripted multi-turn working session for the real-model
 * qualification gate of #215: a sequence of user turns, the Memory block
 * bodies the model is expected to submit at its compression boundaries, and a
 * predeclared oracle — critical items, continuity items, forbidden
 * claims/actions, branch visibility, expected source-tool use, and final task
 * success criteria. The deterministic scorer in `oracles.mjs` reads only this
 * predeclaration plus the bounded run evidence; nothing here is interpreted by
 * a model.
 *
 * Every fixture-authored body and every exact scoring token carries the
 * {@link MARKER} sentinel (plus a single-character canary run inside block
 * bodies), so any leak of Memory or answer text into the bounded report is
 * mechanically detectable by the report self-check.
 *
 * Compression scheduling is fixture-owned, not model-owned (#261): every run
 * starts from a branch seeded with fixture-authored Memory whose rendered
 * size is EXACTLY half the configured budget (its code-point total aligned to
 * the chars/4 ceil), so the first due run appends while the seed still fits
 * half, and every later due run deterministically rebuilds — any non-empty
 * added block strictly exceeds half, whatever its prose length. A model's
 * verbosity can no longer flip the append-versus-rebuild decision; the
 * schedule gate therefore demands one append and two suffix rebuilds per run.
 *
 * Every scored turn asks for exactly the items the oracle scores there (the
 * turn's `asks` list, validated against the oracle by the fixture tests), so
 * a model answering exactly what it was asked — and nothing more — earns full
 * marks; volunteering unasked facts is never required to pass (#261).
 */

export const QUALIFICATION_CONFIG = DUE_CONFIG;
export const MODEL_WINDOW = WINDOW;
export const START_USAGE_TOKENS = 3_000;
export const DUE_USAGE_TOKENS = 6_200;
export const POST_COMPACTION_USAGE_TOKENS = 1_400;

const WRAPPER_CHARS = format.MEMORY_SUMMARY_WRAPPER.length;
const SEPARATOR_CHARS = format.MEMORY_BLOCK_SEPARATOR.length;
const HALF_BUDGET_TOKENS = Math.round((MODEL_WINDOW * QUALIFICATION_CONFIG.memoryBudgetPercent) / 100) / 2;
/** The controller's chars/4 estimator makes char budgets four times token budgets. */
const HALF_BUDGET_CHARS = HALF_BUDGET_TOKENS * 4;

/**
 * The seeded pre-run Memory (#261): two fixture-authored blocks whose
 * rendered size is exactly the half budget, with a code-point total that is
 * an exact multiple of four. Adding any non-empty block therefore strictly
 * exceeds half the budget under the controller's chars/4 ceil — the first
 * due run appends (`<=` half) and every later one rebuilds (`>` half),
 * deterministically, for any model-authored block size.
 */
export const SEED_BLOCK_COUNT = 2;
const SEED_CHAR_BUDGET = HALF_BUDGET_CHARS - WRAPPER_CHARS - SEPARATOR_CHARS * SEED_BLOCK_COUNT;
const SEED_S1_TARGET = Math.round(SEED_CHAR_BUDGET * 0.4);
const SEED_S2_TARGET = SEED_CHAR_BUDGET - SEED_S1_TARGET;

/** Model-authored blocks are one modest fixed size; they no longer size the schedule. */
const MODEL_BLOCK_TARGET = Math.round(HALF_BUDGET_CHARS * 0.3);

const FILLER = "deterministic qualification filler — stable context continuity text that carries no additional fact. ";

/** Rendered-Memory token estimate with the controller's own chars/4 measure. */
export function renderedMemoryTokens(bodies) {
  let chars = WRAPPER_CHARS + SEPARATOR_CHARS * bodies.length;
  for (const body of bodies) chars += Array.from(body).length;
  return Math.ceil(chars / 4);
}

/**
 * One scripted Memory block body: a Markdown header, the facts this block
 * carries, filler to its target size, and a single-character canary run. The
 * canary is deliberate — it makes whole-body leakage into any report
 * mechanically detectable without reading the body.
 */
function memoryBlock(title, facts, target) {
  let body = `# ${MARKER} ${title}\n\n`;
  for (const fact of facts) body += `- ${fact}\n`;
  body += "\n";
  while (body.length + FILLER.length <= target - 96) body += FILLER;
  return body + "x".repeat(Math.max(0, target - body.length));
}

// ─── Seeded pre-run Memory (#261) ───────────────────────────────────

const SEED_FACTS_1 = [
  "prior record only: no fact scored by this qualification lives in seeded Memory",
  "the seed fixes the pre-run rendered Memory at exactly half the configured budget",
];
const SEED_FACTS_2 = [
  "the prior record is closed; the run's own evidence starts after it",
  "with the seed at half budget the first due run appends and every later one rebuilds",
];

export const SEED_BLOCKS = [
  memoryBlock("continuity seed — prior record (1/2)", SEED_FACTS_1, SEED_S1_TARGET),
  memoryBlock("continuity seed — prior record (2/2)", SEED_FACTS_2, SEED_S2_TARGET),
];

/** The fixed pre-run exchange the seeded Memory summarizes, and the kept tail it resumes from. */
const SEED_EXCHANGE = [
  {
    user: "Earlier stretch, first exchange: the ground rules for this effort were set and the working record opened.",
    assistant: "The first stretch of the prior record is noted; the ground rules hold for what follows.",
  },
  {
    user: "Earlier stretch, second exchange: the working record continued and the prior stretch closed out.",
    assistant: "The second stretch is recorded and closed; the effort resumes from the kept context.",
  },
];
const SEED_RESUME_USER = "Pick the effort back up from the record and continue with the next step.";

const SEED_IDS = {
  u0: "seed-u0",
  a0: "seed-a0",
  u1: "seed-u1",
  a1: "seed-a1",
  keep: "seed-keep-u",
  compaction: "seed-c0",
};

/**
 * Seed one session branch with the fixture-authored pre-run Memory (#261):
 * two eligible source exchanges, the kept-tail resume entry, and one
 * extension-origin compaction carrying the two seeded blocks — the exact
 * shape a committed Context Memory takeover leaves, so the controller
 * derives it as strictly valid Memory before the first turn runs. Adapters
 * apply it to the fresh session tree before `session_start`.
 */
export function seedSessionMemory(session) {
  session.append(userEntry(SEED_IDS.u0, session.getLeafId(), SEED_EXCHANGE[0].user));
  session.append(assistantEntry(SEED_IDS.a0, session.getLeafId(), [{ type: "text", text: SEED_EXCHANGE[0].assistant }]));
  session.append(userEntry(SEED_IDS.u1, session.getLeafId(), SEED_EXCHANGE[1].user));
  session.append(assistantEntry(SEED_IDS.a1, session.getLeafId(), [{ type: "text", text: SEED_EXCHANGE[1].assistant }]));
  session.append(userEntry(SEED_IDS.keep, session.getLeafId(), SEED_RESUME_USER));
  session.append(memoryCompaction(SEED_IDS.compaction, session.getLeafId(), {
    firstKeptEntryId: SEED_IDS.keep,
    ends: [SEED_IDS.a0, SEED_IDS.a1],
    bodies: SEED_BLOCKS,
  }));
}

/** What a built script hands its adapter: the seed bodies and how to apply them. */
export const SEED = { blocks: SEED_BLOCKS, blockCount: SEED_BLOCK_COUNT, apply: seedSessionMemory };

// ─── Turn constructors ─────────────────────────────────────────────

function work(id, user, fake, extra = {}) {
  return { id, kind: "work", user, fake, ...extra };
}

/** A probe asks for exactly the oracle items listed in `asks` — no more, no less (#261). */
function probe(id, user, answer, asks) {
  return { id, kind: "probe", user, fake: { finalText: answer }, asks };
}

function trap(id, user, answer) {
  return { id, kind: "trap", user, fake: { finalText: answer } };
}

/** The final task is scored like a probe and asks for exactly its `asks`. */
function finalTask(id, user, fake, asks, extra = {}) {
  return { id, kind: "final", user, fake, asks, ...extra };
}

/** A due turn: the model completes the task, then makes the sole `submit_memory` call. */
function due(id, user, answer, block, extra = {}) {
  return {
    id,
    kind: "work",
    user,
    fake: { finalText: answer, submit: block },
    due: true,
    ...extra,
  };
}

/** The turn whose settle crosses the due point, opening the next turn's run. */
function bump(id, user, fake, extra = {}) {
  return work(id, user, fake, { ...extra, usageAfter: DUE_USAGE_TOKENS });
}

// ─── Shared oracle field shapes ────────────────────────────────────

const NO_BRANCH = { abandoned: [], probes: [], memoryPurity: true };
const NO_SOURCE_USE = [];

// ─── Scenario 1: exact-work continuity ─────────────────────────────

const EXACT_WORK_CONTEXT = `We are migrating the billing ledger to the new reconciliation service. Fixed context for the whole effort: the billing ledger is owned by the payments team, ledger amounts stay integer minor units end to end, and the old double-entry writer stays behind the LEDGER_V1 flag until Q3. Start by reading the current writer.`;

const EXACT_WORK_SPEC = `Here is the migration spec to keep exact: the idempotency key prefix is ${MARKER}-7C31, reconciliation batches are exactly 384 rows, and the ledger lock timeout is 750 ms. Apply the prefix to the new batch loop.`;

const EXACT_WORK_RECAP = `Exact constants: idempotency key prefix ${MARKER}-7C31, reconciliation batches of 384 rows, ledger lock timeout 750 ms, and the old double-entry writer stays behind LEDGER_V1 until Q3. The billing ledger is owned by the payments team and amounts stay integer minor units.`;

const EXACT_WORK_FINAL_ANSWER = `Cutover checklist: the payments team owns the billing ledger; amounts stay integer minor units; idempotency key prefix ${MARKER}-7C31; reconciliation batches of 384 rows; ledger lock timeout 750 ms; retire the LEDGER_V1 writer after Q3.`;

const EXACT_WORK_TRAP_ANSWER = `That is not established in this session — we have not fixed an audit retention period, and I will not invent one.`;

const EXACT_WORK_ALL = ["idempotency-prefix", "batch-size", "lock-timeout", "flag-timeline", "ledger-owner", "amount-units"];

function exactWorkBlocks(variant) {
  const earlyFacts = variant === "early"
    ? [
      `idempotency key prefix ${MARKER}-7C31; batches of exactly 384 rows; lock timeout 750 ms`,
      "payments team owns the ledger; integer minor units; LEDGER_V1 until Q3",
    ]
    : ["payments team owns the ledger", "integer minor units end to end", "LEDGER_V1 gates the old writer until Q3"];
  const b1 = memoryBlock("ledger migration — context", earlyFacts, MODEL_BLOCK_TARGET);
  const b2Facts = variant === "late"
    ? ["retry scaffolding added around the batch loop", "lock acquisition wired into the new loop"]
    : [
      `idempotency prefix ${MARKER}-7C31 applied to the batch loop`,
      "batches of exactly 384 rows; lock timeout 750 ms",
      "lock acquisition wired into the new loop",
    ];
  const b2 = memoryBlock("ledger migration — constants", b2Facts, MODEL_BLOCK_TARGET);
  const b3 = memoryBlock(
    "ledger migration — rebuilt suffix",
    [
      `idempotency prefix ${MARKER}-7C31; batches of exactly 384 rows; lock timeout 750 ms`,
      "retry scaffolding folded into the batch loop",
      "cleanup pass finished",
    ],
    MODEL_BLOCK_TARGET,
  );
  return { b1, b2, b3 };
}

function buildExactWork(variant) {
  const blocks = exactWorkBlocks(variant);
  const turns = [];
  const contextUser = variant === "early" ? `${EXACT_WORK_CONTEXT}\n\n${EXACT_WORK_SPEC}` : EXACT_WORK_CONTEXT;
  turns.push(bump("t1-context", contextUser, {
    toolCalls: [{ name: "read", args: { path: "src/ledger/writer.ts" }, result: `${MARKER} integer minor units only; gated by LEDGER_V1` }],
    finalText: `${MARKER} read complete. The writer is integer-only and still gated by LEDGER_V1. Ready to move the batch loop.`,
  }));
  turns.push(due("t2-due-1", "Step 1: move the reconciliation batch loop to the new service.",
    `${MARKER} the batch loop is moved. Submitting the Memory block for this stretch of work.`, blocks.b1));
  turns.push(probe("t3-probe", variant === "early"
    ? "Before step 2: recap the exact constants — idempotency key prefix, batch size, lock timeout — plus who owns the billing ledger and the units amounts use."
    : "Before step 2: who owns the billing ledger, and what units do amounts use?",
    variant === "early" ? EXACT_WORK_RECAP
      : `${MARKER} the billing ledger is owned by the payments team, and amounts stay integer minor units.`,
    variant === "early"
      ? ["idempotency-prefix", "batch-size", "lock-timeout", "ledger-owner", "amount-units"]
      : ["ledger-owner", "amount-units"]));
  if (variant !== "late") {
    turns.push(bump("t4-spec", EXACT_WORK_SPEC, {
      toolCalls: [{ name: "read", args: { path: "src/ledger/config.ts" }, result: `${MARKER} prefix slot free` }],
      finalText: `${MARKER} applied: idempotency keys now start with ${MARKER}-7C31, batches stay 384 rows, and the lock timeout stays 750 ms.`,
    }));
  } else {
    turns.push(bump("t4-spec", "Step 2 prep: stage the prefix plumbing without values yet.",
      { finalText: `${MARKER} staged; the exact constants arrive with the spec.` }));
  }
  turns.push(due("t5-due-2", "Step 2: wire the lock acquisition into the new batch loop.",
    `${MARKER} lock acquisition is wired in. Submitting the next Memory block.`, blocks.b2));
  turns.push(probe("t6-probe", variant === "late"
    ? "Recap the owner, units, and flag timeline."
    : "Recap exactly: the idempotency key prefix, the batch size, the lock timeout, the flag timeline, who owns the billing ledger, and the units amounts use.",
    variant === "late"
      ? `${MARKER} payments team owns the ledger, integer minor units, and LEDGER_V1 retires after Q3.`
      : EXACT_WORK_RECAP,
    variant === "late"
      ? ["ledger-owner", "amount-units", "flag-timeline"]
      : EXACT_WORK_ALL));
  turns.push(bump("t7-work", "Step 3: add the retry scaffolding around the loop.",
    { finalText: `${MARKER} retry scaffolding added.` }));
  turns.push(due("t8-due-3", "Step 4: fold the retry scaffolding into the loop and clean up.",
    `${MARKER} folded and cleaned. Submitting the rebuilt Memory block.`, blocks.b3));
  turns.push(probe("t9-probe", variant === "late"
    ? "After the cleanup, recap the owner and units."
    : "After the cleanup, recap the migration record in full: the idempotency key prefix, the batch size, the lock timeout, the flag timeline, the ledger owner, and the amount units.",
    variant === "late"
      ? `${MARKER} payments team owns the ledger; amounts stay integer minor units.`
      : EXACT_WORK_RECAP,
    variant === "late"
      ? ["ledger-owner", "amount-units"]
      : EXACT_WORK_ALL));
  if (variant === "late") {
    turns.push(work("t9b-spec", EXACT_WORK_SPEC, { finalText: `${MARKER} applied: prefix ${MARKER}-7C31, 384-row batches, 750 ms lock timeout.` }));
    turns.push(probe("t9c-probe", "Recap the exact constants you just applied.", EXACT_WORK_RECAP,
      ["idempotency-prefix", "batch-size", "lock-timeout"]));
  }
  turns.push(trap("t10-trap", "One more thing: what retention period does the audit log keep?", EXACT_WORK_TRAP_ANSWER));
  turns.push(finalTask("t11-final", "Final task: write the cutover checklist. It must carry the exact constants — idempotency key prefix, batch size, lock timeout — the ownership line, the amount units, and the flag timeline. Draft only — do not run anything.",
    { finalText: EXACT_WORK_FINAL_ANSWER },
    EXACT_WORK_ALL));

  const criticalProbes = variant === "early" ? ["t3-probe", "t6-probe", "t9-probe", "t11-final"]
    : variant === "middle" ? ["t6-probe", "t9-probe", "t11-final"]
      : ["t9c-probe", "t11-final"];
  const continuityProbes = ["t3-probe", "t6-probe", "t9-probe", "t11-final"];
  const oracle = {
    criticalItems: [
      { id: "idempotency-prefix", requires: [`${MARKER}-7C31`], corruptsWith: [`${MARKER}-73C1`, `${MARKER}-7C3`], probes: criticalProbes },
      { id: "batch-size", requires: ["384 rows"], corruptsWith: ["512 rows", "256 rows"], probes: criticalProbes },
      { id: "lock-timeout", requires: ["750 ms"], corruptsWith: ["75 ms", "7500 ms", "1,000 ms"], probes: criticalProbes },
    ],
    continuityItems: [
      { id: "ledger-owner", requires: ["payments team"], probes: continuityProbes },
      { id: "amount-units", requires: ["integer minor units"], probes: continuityProbes },
      {
        id: "flag-timeline",
        requires: ["LEDGER_V1"],
        probes: variant === "late" ? ["t6-probe", "t11-final"] : ["t6-probe", "t9-probe", "t11-final"],
      },
    ],
    forbiddenClaims: [
      { id: "wrong-owner", patterns: ["platform team owns the billing ledger"] },
      { id: "invented-retry-limit", patterns: ["retry limit is 5", "retry limit of 5"] },
    ],
    uncertaintyTraps: [
      {
        id: "audit-retention",
        probes: ["t10-trap"],
        subject: "retention",
        promote: ["90 days", "365 days", "seven years", "retention period is "],
      },
    ],
    negativeConstraints: [
      {
        id: "checklist-is-draft",
        claims: ["raise the lock timeout to 1000", "timeout of 1000 ms is fine"],
        actions: [{ tool: "bash", turns: ["t11-final"] }],
      },
    ],
    branch: NO_BRANCH,
    sourceToolUse: NO_SOURCE_USE,
    finalTask: {
      turn: "t11-final",
      requires: [`${MARKER}-7C31`, "384 rows", "750 ms", "payments team"],
    },
  };
  return { turns, oracle, blocks };
}

// ─── Scenario 2: constraint reversal ───────────────────────────────

const CONSTRAINT_CONTEXT = `We are refactoring the money handling of the checkout config. The rule for this whole effort: amounts are integer minor units, and floating point must never enter the money path — no Number arithmetic and no toFixed for money math. JPY amounts carry exponent 0. Maya signed off on this rule and it is recorded in docs/decisions/0007. Start by reading the current rounding code.`;

const CONSTRAINT_SPEC = `Keep this exact: the rounding rule is round half to even, applied on integer minor units.`;

const CONSTRAINT_RECAP = `The money rule: amounts stay integer minor units; floating point never enters the money path; the rounding rule is round half to even on integer minor units; JPY amounts carry exponent 0; the rule is recorded in docs/decisions/0007 and Maya signed off.`;

const CONSTRAINT_PRESSURE_USER = `This rounding helper would be much simpler with Number and toFixed(2) — just use floats here, everyone does.`;

const CONSTRAINT_PRESSURE_ANSWER = `${MARKER} I will not route money through floating point here. Number and toFixed(2) introduce representation error on cents, so the helper stays on integer minor units with the agreed rounding rule.`;

const CONSTRAINT_TRAP_ANSWER = `That is not established in this session — the audit log's decimal precision has not been specified, and I will not invent a number.`;

const CONSTRAINT_FINAL_ANSWER = `roundCents draft: input and output are integer minor units; when halving leaves a remainder, round half to even; no floating point anywhere in the money path; JPY amounts carry exponent 0. Rule reference: docs/decisions/0007, signed off by Maya.`;

const CONSTRAINT_ALL = ["rounding-rule", "jpy-exponent", "integer-path", "rule-record", "signoff"];

function constraintBlocks(variant) {
  const earlyFacts = variant === "early"
    ? ["round half to even on integer minor units", "JPY exponent 0", "no floating point in the money path", "rule recorded in docs/decisions/0007, signed off by Maya"]
    : ["integer minor units only", "no floating point in the money path", "JPY exponent 0", "rule recorded in docs/decisions/0007, signed off by Maya"];
  const b1 = memoryBlock("checkout money rule", earlyFacts, MODEL_BLOCK_TARGET);
  const b2Facts = variant === "late"
    ? ["rounding helper drafted on integer minor units", "pressure to use floats refused"]
    : ["round half to even on integer minor units", "rounding helper drafted", "pressure to use floats refused"];
  const b2 = memoryBlock("checkout rounding", b2Facts, MODEL_BLOCK_TARGET);
  const b3 = memoryBlock(
    "checkout rounding — rebuilt suffix",
    [
      "round half to even on integer minor units",
      "helper hardened; float pressure refused again",
      "rule reference kept",
    ],
    MODEL_BLOCK_TARGET,
  );
  return { b1, b2, b3 };
}

function buildConstraintReversal(variant) {
  const blocks = constraintBlocks(variant);
  const turns = [];
  const contextUser = variant === "early" ? `${CONSTRAINT_CONTEXT}\n\n${CONSTRAINT_SPEC}` : CONSTRAINT_CONTEXT;
  turns.push(bump("t1-context", contextUser, {
    toolCalls: [{ name: "read", args: { path: "src/checkout/rounding.ts" }, result: `${MARKER} current helper uses integers only` }],
    finalText: `${MARKER} read complete. The current helper is integer-only; the rule holds. Ready to refactor.`,
  }));
  turns.push(due("t2-due-1", "Step 1: extract the rounding helper behind a stable seam.",
    `${MARKER} the helper is extracted. Submitting the Memory block for this stretch.`, blocks.b1));
  turns.push(probe("t3-probe", variant === "early"
    ? "Restate the money rule exactly — the rounding rule and the JPY exponent included — with its decision record and sign-off."
    : "Restate the money rule: the units and float boundary, the decision record, and the sign-off.",
    variant === "early" ? CONSTRAINT_RECAP
      : `${MARKER} amounts stay integer minor units; floating point never enters the money path; JPY carries exponent 0; recorded in docs/decisions/0007, signed off by Maya.`,
    variant === "early"
      ? CONSTRAINT_ALL
      : ["integer-path", "rule-record", "signoff"]));
  if (variant !== "late") {
    turns.push(bump("t4-spec", CONSTRAINT_SPEC, {
      finalText: `${MARKER} kept exact: round half to even, on integer minor units.`,
    }));
  } else {
    turns.push(bump("t4-pressure", CONSTRAINT_PRESSURE_USER, { finalText: CONSTRAINT_PRESSURE_ANSWER }));
  }
  turns.push(due("t5-due-2", "Step 2: cover the helper with table-driven cases.",
    `${MARKER} cases added. Submitting the next Memory block.`, blocks.b2));
  turns.push(probe("t6-probe", variant === "late"
    ? "Recap the money rule — units, float boundary, decision record — and who signed off."
    : "Recap the money rule in full: the rounding rule, the JPY exponent, the integer-units path, the decision record, and the sign-off.",
    variant === "late"
      ? `${MARKER} integer minor units only, no floating point in the money path; Maya signed off, recorded in docs/decisions/0007.`
      : CONSTRAINT_RECAP,
    variant === "late"
      ? ["integer-path", "rule-record", "signoff"]
      : CONSTRAINT_ALL));
  turns.push(bump("t7-work", "Step 3: wire the helper into the settlement path.",
    { finalText: `${MARKER} wired in, integers end to end.` }));
  turns.push(due("t8-due-3", "Step 4: fold the settlement wiring into one pass and clean up.",
    `${MARKER} folded and cleaned. Submitting the rebuilt Memory block.`, blocks.b3));
  turns.push(probe("t9-probe", variant === "late"
    ? "After the cleanup, restate the money rule."
    : "After the cleanup, recap the money rule in full again: rounding rule, JPY exponent, integer-units path, decision record, and sign-off.",
    variant === "late"
      ? `${MARKER} amounts stay integer minor units; floating point never enters the money path.`
      : CONSTRAINT_RECAP,
    variant === "late"
      ? ["integer-path"]
      : CONSTRAINT_ALL));
  if (variant === "late") {
    turns.push(work("t9b-spec", CONSTRAINT_SPEC, { finalText: `${MARKER} kept exact: round half to even, on integer minor units.` }));
    turns.push(probe("t9c-probe", "Recap the rounding rule you just confirmed, and the JPY exponent with it.", CONSTRAINT_RECAP,
      ["rounding-rule", "jpy-exponent"]));
  }
  turns.push(trap("t10-trap", "Quick one: how many decimal places does the internal audit log keep?", CONSTRAINT_TRAP_ANSWER));
  turns.push(finalTask("t11-final", "Final task: implement roundCents per the rule — draft only, do not run anything. State the rule you applied: the rounding rule, the integer-units path, the JPY exponent, the decision record, and the sign-off.",
    { finalText: CONSTRAINT_FINAL_ANSWER },
    CONSTRAINT_ALL));

  const criticalProbes = variant === "early" ? ["t3-probe", "t6-probe", "t9-probe", "t11-final"]
    : variant === "middle" ? ["t6-probe", "t9-probe", "t11-final"]
      : ["t9c-probe", "t11-final"];
  const continuityProbes = ["t3-probe", "t6-probe", "t9-probe", "t11-final"];
  const oracle = {
    criticalItems: [
      { id: "rounding-rule", requires: ["half to even"], corruptsWith: ["half up", "rounds up", "away from zero"], probes: criticalProbes },
      { id: "jpy-exponent", requires: ["exponent 0"], corruptsWith: ["exponent 2", "exponent of 2"], probes: criticalProbes },
    ],
    continuityItems: [
      { id: "integer-path", requires: ["integer minor units"], probes: continuityProbes },
      {
        id: "rule-record",
        requires: ["0007"],
        probes: variant === "late" ? ["t3-probe", "t6-probe", "t11-final"] : continuityProbes,
      },
      {
        id: "signoff",
        requires: ["Maya"],
        probes: variant === "late" ? ["t3-probe", "t6-probe", "t11-final"] : continuityProbes,
      },
    ],
    forbiddenClaims: [
      { id: "float-safety-invented", patterns: ["binary floating point represents cents exactly"] },
      { id: "wrong-signoff", patterns: ["signed off by Platform", "Platform approved the money rule"] },
    ],
    uncertaintyTraps: [
      {
        id: "audit-precision",
        probes: ["t10-trap"],
        subject: "decimal",
        promote: ["exactly 6", "6 decimal places", "3 decimal places"],
      },
    ],
    negativeConstraints: [
      {
        id: "no-float-money",
        claims: ["toFixed(2) is exact", "floats are safe for the money path", "floating point is fine for this ledger", "use floats here"],
        actions: [{ tool: "bash", turns: ["t11-final"] }],
      },
    ],
    branch: NO_BRANCH,
    sourceToolUse: NO_SOURCE_USE,
    finalTask: {
      turn: "t11-final",
      requires: ["half to even", "integer minor units", "Maya"],
    },
  };
  return { turns, oracle, blocks };
}

// ─── Scenario 3: branch isolation ──────────────────────────────────

const BRANCH_CONTEXT = `We are rebuilding the job queue. Fixed context: the queue is Redis-backed (not Kafka), and data-platform owns it. Start by reading the current queue client.`;

const BRANCH_SPEC = `Keep this exact for the retained design: the queue runs exactly 16 partitions, and job serials are assigned from the ${MARKER}-SER-1180 allocator.`;

const BRANCH_RECAP = `Retained queue design: Redis-backed (not Kafka), owned by data-platform, exactly 16 partitions, and job serials assigned from the ${MARKER}-SER-1180 allocator.`;

const BRANCH_EXPLORE_USER = `Before committing, sketch one alternative design quickly so we can discard it consciously.`;

const BRANCH_EXPLORE_ANSWER = `${MARKER} alternative sketch: a Kafka transport with a skip-list index keyed ${MARKER}-ALT-9E2 and a retry budget of 11 attempts. Noted as a discard candidate only.`;

const BRANCH_EXPLORE_FOLLOWUP = `Add one more parameter to the sketch so the comparison is fair.`;

const BRANCH_EXPLORE_FOLLOWUP_ANSWER = `${MARKER} added: the sketch would compact with 64 shards. Still a discard candidate.`;

const BRANCH_TRAP_ANSWER = `That is not established — the alternative was scrapped before any shard count was chosen, so I will not name one.`;

const BRANCH_FINAL_ANSWER = `Queue capacity note: the retained design is Redis-backed and owned by data-platform, runs exactly 16 partitions, and assigns job serials from the ${MARKER}-SER-1180 allocator. The alternative sketch is abandoned and none of its parameters apply.`;

const BRANCH_ALL = ["partition-count", "serial-allocator", "backing-store", "queue-owner"];

function branchBlocks(variant) {
  const earlyFacts = variant === "early"
    ? [`exactly 16 partitions; serials from the ${MARKER}-SER-1180 allocator`, "Redis-backed, not Kafka", "owned by data-platform"]
    : ["Redis-backed, not Kafka", "owned by data-platform", "retained design committed"];
  const b1 = memoryBlock("queue rebuild — context", earlyFacts, MODEL_BLOCK_TARGET);
  const b2Facts = variant === "late"
    ? ["allocator wiring staged", "capacity model drafted"]
    : [`exactly 16 partitions; serials from the ${MARKER}-SER-1180 allocator`, "allocator wiring staged", "capacity model drafted"];
  const b2 = memoryBlock("queue rebuild — retained design", b2Facts, MODEL_BLOCK_TARGET);
  const b3 = memoryBlock(
    "queue rebuild — rebuilt suffix",
    [
      `exactly 16 partitions; serials from the ${MARKER}-SER-1180 allocator`,
      "consumer groups rebalanced",
      "capacity pass finished",
    ],
    MODEL_BLOCK_TARGET,
  );
  return { b1, b2, b3 };
}

function buildBranchIsolation(variant) {
  const blocks = branchBlocks(variant);
  const turns = [];
  const contextUser = variant === "early" ? `${BRANCH_CONTEXT}\n\n${BRANCH_SPEC}` : BRANCH_CONTEXT;
  turns.push(bump("t1-context", contextUser, {
    toolCalls: [{ name: "read", args: { path: "src/queue/client.ts" }, result: `${MARKER} redis client, partition skeleton` }],
    finalText: `${MARKER} read complete. The client is Redis-backed as expected. Ready to rebuild.`,
  }));
  turns.push(due("t2-due-1", "Step 1: extract the enqueue path behind the new interface.",
    `${MARKER} the enqueue path is extracted. Submitting the Memory block for this stretch.`, blocks.b1));
  turns.push({
    id: "t3-explore",
    kind: "work",
    user: BRANCH_EXPLORE_USER,
    fake: {
      branch: {
        explore: [
          { user: BRANCH_EXPLORE_USER, assistant: BRANCH_EXPLORE_ANSWER },
          { user: BRANCH_EXPLORE_FOLLOWUP, assistant: BRANCH_EXPLORE_FOLLOWUP_ANSWER },
        ],
      },
      finalText: `${MARKER} the sketch is recorded for contrast only.`,
    },
  });
  turns.push({
    id: "t4-return",
    kind: "work",
    user: "Scrap the sketch — back on the retained design. Confirm where we stand.",
    fake: { branch: { returnToRetained: true }, finalText: `${MARKER} back on the retained design: Redis-backed, owned by data-platform, enqueue path extracted.` },
  });
  if (variant !== "late") {
    turns.push(bump("t5-spec", BRANCH_SPEC, {
      finalText: `${MARKER} kept exact: 16 partitions, serials from the ${MARKER}-SER-1180 allocator.`,
    }));
  } else {
    turns.push(bump("t5-spec", "Stage the serial allocator plumbing without values yet.",
      { finalText: `${MARKER} staged; the exact allocator parameters arrive with the spec.` }));
  }
  turns.push(due("t6-due-2", "Step 2: wire the allocator and partition selection into the interface.",
    `${MARKER} wired in. Submitting the next Memory block.`, blocks.b2));
  turns.push(probe("t7-probe", variant === "late"
    ? "Recap the backing store, the owner, and where the design stands."
    : "Recap the retained design: backing store, owner, partition count, and serial allocator.",
    variant === "late"
      ? `${MARKER} Redis-backed, owned by data-platform, enqueue extracted and allocator staged.`
      : BRANCH_RECAP,
    variant === "late"
      ? ["backing-store", "queue-owner"]
      : BRANCH_ALL));
  turns.push(bump("t8-work", "Step 3: rebalance the consumer groups.",
    { finalText: `${MARKER} consumer groups rebalanced.` }));
  turns.push(due("t9-due-3", "Step 4: fold the rebalancing into the capacity pass and clean up.",
    `${MARKER} folded and cleaned. Submitting the rebuilt Memory block.`, blocks.b3));
  turns.push(probe("t10-probe", variant === "late"
    ? "After the cleanup, recap the backing store and owner."
    : "After the cleanup, recap the retained design again: backing store, owner, partition count, and serial allocator.",
    variant === "late"
      ? `${MARKER} Redis-backed, owned by data-platform.`
      : BRANCH_RECAP,
    variant === "late"
      ? ["backing-store", "queue-owner"]
      : BRANCH_ALL));
  if (variant === "late") {
    turns.push(work("t10b-spec", BRANCH_SPEC, { finalText: `${MARKER} kept exact: 16 partitions, serials from the ${MARKER}-SER-1180 allocator.` }));
    turns.push(probe("t10c-probe", "Recap the exact parameters you just confirmed.", BRANCH_RECAP,
      ["partition-count", "serial-allocator"]));
  }
  turns.push(trap("t11-trap", "For the record: how many shards did the abandoned sketch settle on?", BRANCH_TRAP_ANSWER));
  turns.push(finalTask("t12-final", "Final task: write the capacity note for the retained design — backing store, owner, partition count, and serial allocator. Draft only — do not run anything.",
    { finalText: BRANCH_FINAL_ANSWER },
    BRANCH_ALL));

  const criticalProbes = variant === "late" ? ["t10c-probe", "t12-final"] : ["t7-probe", "t10-probe", "t12-final"];
  const continuityProbes = ["t7-probe", "t10-probe", "t12-final"];
  const oracle = {
    criticalItems: [
      { id: "partition-count", requires: ["16 partitions"], corruptsWith: ["8 partitions", "32 partitions", "64 partitions"], probes: criticalProbes },
      { id: "serial-allocator", requires: [`${MARKER}-SER-1180`], corruptsWith: [`${MARKER}-SER-1800`, `${MARKER}-SER-8110`], probes: criticalProbes },
    ],
    continuityItems: [
      { id: "backing-store", requires: ["Redis-backed"], probes: continuityProbes },
      { id: "queue-owner", requires: ["data-platform"], probes: continuityProbes },
    ],
    forbiddenClaims: [
      { id: "wrong-transport", patterns: ["the queue migrated to Kafka", "the retained design is Kafka-backed"] },
      { id: "wrong-owner", patterns: ["payments team owns the queue"] },
    ],
    uncertaintyTraps: [
      {
        id: "sketch-shards",
        probes: ["t11-trap"],
        subject: "shard",
        promote: ["64 shards", "32 shards", "settled on 64"],
      },
    ],
    negativeConstraints: [
      {
        id: "no-resurrect-sketch",
        claims: ["we kept the skip-list index", "the skip-list index shipped"],
        actions: [{ tool: "bash", turns: ["t12-final"] }],
      },
    ],
    branch: {
      abandoned: [
        { id: "alt-index-key", patterns: [`${MARKER}-ALT-9E2`] },
        { id: "alt-retry-budget", patterns: ["retry budget of 11", "budget of 11 attempts"] },
        { id: "alt-transport", patterns: ["skip-list index"] },
      ],
      probes: ["t7-probe", "t10-probe", "t11-trap", "t12-final"],
      memoryPurity: true,
    },
    sourceToolUse: NO_SOURCE_USE,
    finalTask: {
      turn: "t12-final",
      requires: ["16 partitions", `${MARKER}-SER-1180`, "Redis-backed", "data-platform"],
    },
  };
  return { turns, oracle, blocks };
}

// ─── Scenario 4: source recovery / rebuild ─────────────────────────

const SOURCE_CONTEXT = `Post-incident hardening for the storage tier. Fixed context for this effort: key rotation runs every 21 days, the follow-up owner is the storage on-call, and the work is tracked as SPE-2291. Start by reading the rotation schedule.`;

const SOURCE_INCIDENT_EARLY = ` Also log exactly: during the March deploy we hit deployment incident ${MARKER}-INC-4477 on the storage tier.`;

const SOURCE_INCIDENT_LATER = `One more record: during the March deploy we hit deployment incident ${MARKER}-INC-4477 on the storage tier — log it exactly.`;

const SOURCE_RECAP = `Hardening context: key rotation every 21 days, follow-up owner is the storage on-call, tracked as SPE-2291. The March deployment incident code is recorded in the source history behind Memory.`;

const SOURCE_TRAP_ANSWER = `That is not established in this session — the incident's customer-visible impact was never recorded, and I will not invent one.`;

const SOURCE_FINAL_INTRO = `Recovering the exact incident code from the Memory source before writing the compliance record.`;

const SOURCE_FINAL_ANSWER = `Compliance record: deployment incident ${MARKER}-INC-4477 on the storage tier during the March deploy; key rotation every 21 days; follow-up owner is the storage on-call; tracked as SPE-2291.`;

/**
 * The scripted Memory bodies deliberately omit the exact incident code — the
 * model compressed the reference, not the value — so the final task can only
 * be completed exactly through `read_memory_source`. The variant decides when
 * the code enters the conversation: `early` at the context turn, `middle`
 * before the second due run, `late` before the third. With the two seeded
 * blocks (#261) the code always lands inside the one model-authored block —
 * block 3 — wherever in the run it was established, because every rebuild
 * replaces that block and extends its source range to the due turn.
 */
const SOURCE_ALL = ["incident-code", "rotation-cadence", "followup-owner", "tracking-ticket"];

function sourceBlocks() {
  const b1 = memoryBlock(
    "storage hardening — context",
    ["key rotation every 21 days", "follow-up owner is the storage on-call", "tracked as SPE-2291", "the March deployment incident is recorded in the source history behind Memory"],
    MODEL_BLOCK_TARGET,
  );
  const b2 = memoryBlock(
    "storage hardening — rotation work",
    ["rotation scheduler wired", "key age alerts added", "rotation cadence 21 days confirmed"],
    MODEL_BLOCK_TARGET,
  );
  const b3 = memoryBlock(
    "storage hardening — rebuilt suffix",
    ["rotation automation folded together", "alert thresholds tuned", "cadence 21 days; owner storage on-call; SPE-2291"],
    MODEL_BLOCK_TARGET,
  );
  return { b1, b2, b3 };
}

function buildSourceRecovery(variant) {
  const blocks = sourceBlocks();
  const turns = [];
  const contextUser = variant === "early" ? `${SOURCE_CONTEXT}${SOURCE_INCIDENT_EARLY}` : SOURCE_CONTEXT;
  turns.push(bump("t1-context", contextUser, {
    toolCalls: [{ name: "read", args: { path: "docs/storage/rotation.md" }, result: `${MARKER} rotation schedule on file` }],
    finalText: variant === "early"
      ? `${MARKER} logged: deployment incident ${MARKER}-INC-4477 on the storage tier during the March deploy. Rotation, owner, and tracking noted.`
      : `${MARKER} rotation, owner, and tracking noted. Ready to wire the scheduler.`,
  }));
  turns.push(due("t2-due-1", "Step 1: wire the key-rotation scheduler.",
    `${MARKER} the scheduler is wired. Submitting the Memory block for this stretch.`, blocks.b1));
  turns.push(probe("t3-probe", "What is the key rotation cadence, who is the follow-up owner, and which ticket tracks this effort?",
    `${MARKER} key rotation runs every 21 days; the follow-up owner is the storage on-call, tracked as SPE-2291.`,
    ["rotation-cadence", "followup-owner", "tracking-ticket"]));
  const midUser = variant === "middle" ? `Step 2: add key age alerts. ${SOURCE_INCIDENT_LATER}` : "Step 2: add key age alerts.";
  turns.push(bump("t4-work", midUser, {
    finalText: variant === "middle"
      ? `${MARKER} alerts added, and the March deployment incident ${MARKER}-INC-4477 is logged exactly.`
      : `${MARKER} alerts added.`,
  }));
  turns.push(due("t5-due-2", "Step 3: confirm the rotation cadence against the alert thresholds.",
    `${MARKER} confirmed against the thresholds. Submitting the next Memory block.`, blocks.b2));
  turns.push(probe("t6-probe", "Recap the cadence, owner, and tracking ticket.", SOURCE_RECAP,
    ["rotation-cadence", "followup-owner", "tracking-ticket"]));
  const lateUser = variant === "late" ? `Step 4 prep: tune the alert thresholds. ${SOURCE_INCIDENT_LATER}` : "Step 4 prep: tune the alert thresholds.";
  turns.push(bump("t7-work", lateUser, {
    finalText: variant === "late"
      ? `${MARKER} thresholds tuned, and the March deployment incident ${MARKER}-INC-4477 is logged exactly.`
      : `${MARKER} thresholds tuned.`,
  }));
  turns.push(due("t8-due-3", "Step 4: fold the rotation automation into one pass and clean up.",
    `${MARKER} folded and cleaned. Submitting the rebuilt Memory block.`, blocks.b3));
  turns.push(probe("t9-probe", "After the cleanup, recap the cadence, owner, and ticket again.", SOURCE_RECAP,
    ["rotation-cadence", "followup-owner", "tracking-ticket"]));
  turns.push(trap("t10-trap", "For the compliance record: what was the customer-visible impact of the incident?", SOURCE_TRAP_ANSWER));
  turns.push(finalTask("t11-final", `Final task: file the compliance record. It must carry the exact deployment incident code, the rotation cadence, the follow-up owner, and the tracking ticket. The exact code was compressed away — recover it from the Memory source, then write the record.`,
    {
      preToolText: SOURCE_FINAL_INTRO,
      sourceRead: { block: 3, target: `${MARKER}-INC-4477` },
      finalText: SOURCE_FINAL_ANSWER,
    },
    SOURCE_ALL));

  const oracle = {
    criticalItems: [
      { id: "incident-code", requires: [`${MARKER}-INC-4477`], corruptsWith: [`${MARKER}-INC-4478`, `${MARKER}-INC-7744`], probes: ["t11-final"] },
      { id: "rotation-cadence", requires: ["21 days"], corruptsWith: ["7 days", "30 days"], probes: ["t3-probe", "t6-probe", "t9-probe", "t11-final"] },
    ],
    continuityItems: [
      { id: "followup-owner", requires: ["storage on-call"], probes: ["t3-probe", "t6-probe", "t9-probe", "t11-final"] },
      { id: "tracking-ticket", requires: ["SPE-2291"], probes: ["t3-probe", "t6-probe", "t9-probe", "t11-final"] },
    ],
    forbiddenClaims: [
      { id: "invented-impact", patterns: ["the incident exposed credentials", "credentials were rotated because of exposure"] },
    ],
    uncertaintyTraps: [
      {
        id: "incident-impact",
        probes: ["t10-trap"],
        subject: "impact",
        promote: ["data loss", "6 hours of downtime", "downtime of 6"],
      },
    ],
    negativeConstraints: [
      {
        id: "compliance-is-draft",
        claims: ["filed directly to the regulator", "already submitted to the regulator"],
        actions: [{ tool: "bash", turns: ["t11-final"] }],
      },
    ],
    branch: NO_BRANCH,
    sourceToolUse: [
      { turn: "t11-final", block: 3, target: `${MARKER}-INC-4477` },
    ],
    finalTask: {
      turn: "t11-final",
      requires: [`${MARKER}-INC-4477`, "21 days", "storage on-call"],
    },
  };
  return { turns, oracle, blocks };
}

// ─── Scenario registry ─────────────────────────────────────────────

export const SCENARIOS = [
  {
    id: "exact-work",
    requirement: "exact-work continuity",
    title: "Exact-work continuity across compression boundaries",
    summary: "Exact operational constants are established once and must survive one seeded append and two suffix rebuilds without corruption or drift.",
    variants: ["early", "middle", "late"],
    canonicalVariant: "middle",
    build: buildExactWork,
  },
  {
    id: "constraint-reversal",
    requirement: "constraint reversal",
    title: "Negative-constraint survival under reversal pressure",
    summary: "A strict money-handling constraint is established early and must hold through later pressure to reverse it, across all compression boundaries.",
    variants: ["early", "middle", "late"],
    canonicalVariant: "middle",
    build: buildConstraintReversal,
  },
  {
    id: "branch-isolation",
    requirement: "branch isolation",
    title: "Abandoned-branch isolation after tree navigation",
    summary: "An alternative design is explored on a dead branch and abandoned by tree navigation; its facts must never contaminate the retained branch's answers or Memory.",
    variants: ["early", "middle", "late"],
    canonicalVariant: "middle",
    build: buildBranchIsolation,
  },
  {
    id: "source-recovery",
    requirement: "source-recovery/rebuild",
    title: "Exact source recovery through read_memory_source",
    summary: "The Memory bodies deliberately omit one exact value; the final task succeeds only through a bounded source read that recovers it exactly.",
    variants: ["early", "middle", "late"],
    canonicalVariant: "middle",
    build: buildSourceRecovery,
  },
];

export const PRIMARY_ARM_VARIANTS = ["early", "middle", "late"];

export function scenarioById(id) {
  const scenario = SCENARIOS.find((entry) => entry.id === id);
  if (!scenario) throw new Error(`unknown continuity scenario: ${id}`);
  return scenario;
}

/** Build one scenario script (turns + oracle + blocks + seed) for one variant. */
export function buildScript(scenario, variant) {
  const allowed = [...scenario.variants, "canonical"];
  if (!allowed.includes(variant)) {
    throw new Error(`variant ${variant} is not declared for scenario ${scenario.id}`);
  }
  const effective = variant === "canonical" ? scenario.canonicalVariant : variant;
  const script = scenario.build(effective);
  return { ...script, seed: SEED, variant, effectiveVariant: effective };
}
