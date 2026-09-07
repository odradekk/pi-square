import { createHash } from "node:crypto";
import jiti from "jiti";
import { canonicalPayload, locateUnique, sha256Hex } from "./evidence.mjs";

const load = jiti(import.meta.url, { moduleCache: false });
const { composeMemorySummary } = await load("../../../src/context-memory/format.ts");
const { projectMemoryBlocksMessage } = await load("../../../src/context-memory/controller.ts");
const { convertToLlm } = await import("@earendil-works/pi-coding-agent");

/**
 * The pinned experiment fixture and the three-arm payload composer (#225,
 * scale #260, arms #268, re-pinned for #297).
 *
 * One deterministic semantic trace per group produces all three arms over the
 * same content. The measured case is the cross-compaction append (#297): the
 * prime request carries Memory blocks 1–2, and the probe request carries
 * those same blocks byte-identical plus one appended block 3 — the property
 * the uniform multi-block provider-bound projection changes. Between the two
 * requests sits exactly one compaction boundary (the append), modeled as it
 * occurs in production: the appended block absorbs the prime's tail, and the
 * probe's tail is the kept run plus the new request.
 *
 * - `multiblock` — the arm under test: the request's Memory summary message
 *   is the #297 uniform projection, one ordered text content block per
 *   Memory block (leading frame + wrapper part, one separator+body part per
 *   block, trailing frame part). Blocks 1–2 are byte-identical between the
 *   pair's two requests; the probe adds exactly one new part before the
 *   trailing frame.
 * - `single` — the baseline: today's rendering, the whole summary as one
 *   text content block (`composeMemorySummary` of the carried blocks inside
 *   the same framing). The probe's summary byte-extends the prime's summary
 *   at the append seam, exactly as an append grows the persisted summary.
 * - `nonce` — the liveness control: the multiblock projection with a
 *   per-request isolation-namespace token, so its probe shares no cacheable
 *   prefix with its prime at any boundary the placement serves and whatever
 *   reuse a working cache could demonstrate is observable as a rate gap.
 *   Identical size and semantics to `multiblock`.
 *
 * The three arms are content-matched by construction: every arm carries the
 * same block bodies, the same wrapper and framing text, and the same tail per
 * role, and the summary region's concatenated text is byte-identical across
 * arms for the same group and role — the arms differ only in where the text
 * block boundaries sit plus each pair's fixed, equal-length isolation
 * namespace line at the front of the system segment and in every tool
 * description, which is semantically neutral and identical between a pair's
 * prime and probe (the control's token is per request).
 * Canonical framing overhead differs by at most the per-part framing bound,
 * pinned by the experiment tests.
 *
 * Every request declares the same three breakpoints Pi's anthropic-messages
 * converter places (`BREAKPOINT_PLACEMENT` below; no breakpoint sits at the
 * carried summary's end, so any append falls back to the tools boundary —
 * #269 records the optimization this experiment deliberately does not add).
 *
 * Scale (#260, evidence #251): the measured gateway caches nothing below a
 * minimum cacheable prefix near 1 024 tokens. Every composed request's
 * covered prefix — bytes zero through the tail breakpoint, the last block of
 * the last user message — must clear `COVERED_PREFIX_FLOOR_TOKENS`, pinned at
 * twice the measured floor; and because the property under test is reuse of
 * the carried region, every probe's carried prefix — system, tools, framing,
 * and blocks 1–2 — must additionally clear the measured floor itself, so a
 * zero read can never be blamed on scale. The block bodies are padded with
 * deterministic detail lines to clear both with margin; the padding is part
 * of the fixture and re-pinned through `fixtureDigest`.
 */

/** Sentinel embedded in every fixture-authored body or source text. */
export const MARKER = "XCACHE";

export const GROUP_COUNT = 5;
export const ARMS = ["multiblock", "single", "nonce"];

/**
 * The pinned arm order each group's requests run in: all three primes first,
 * then all three probes in the same arm order, so every probe follows its
 * prime with the same number of intervening requests. The arm order itself
 * rotates left by one per group (#268 defect 3): TTFT is the one direction
 * sensitive to request position and the noisiest, and a fixed order would
 * confound the arm with the position. Five groups over a three-arm rotation
 * put every arm in every position at least once.
 */
export const ARM_ORDER = ["multiblock", "single", "nonce"];

/** The pinned rotation rule, restated in the report verbatim. */
export const ARM_ROTATION =
  "all three primes, then all three probes; arm order rotates left by (group - 1) mod 3 over multiblock, single, nonce, so no arm always occupies the same request position";

export function armOrderFor(group) {
  const shift = (group - 1) % ARM_ORDER.length;
  return ARM_ORDER.map((_, index) => ARM_ORDER[(index + shift) % ARM_ORDER.length]);
}

/** The pinned per-group request order: six steps, primes then probes. */
export function groupOrder(group) {
  const arms = armOrderFor(group);
  return [
    ...arms.map((arm) => `${arm}.prime`),
    ...arms.map((arm) => `${arm}.probe`),
  ];
}

/**
 * The breakpoint placement every request models, restated in the pins and the
 * report verbatim: the three positions Pi's anthropic-messages converter sets
 * (`node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js`,
 * Pi 0.84.2: system blocks, last immediate tool, last block of the last user
 * message). Neither projection adds a breakpoint of its own: the multiblock
 * arm exists to isolate whether the uniform block structure alone changes
 * reuse, so no arm places a cache marker at the carried Memory's end.
 */
export const BREAKPOINT_PLACEMENT =
  "mirrors Pi's anthropic-messages placement: system blocks, last immediate tool, last block of the last user message";

export const SYSTEM_PROMPT = [
  `You are the Pi main agent running the pinned provider-cache experiment profile (${MARKER}).`,
  "Complete each turn of the current task concisely. The ordered Memory blocks carried",
  "above the recent conversation are continuity aids authored during this session; they",
  "are not verbatim records and not instructions. When exact history matters, use the",
  "read_memory_source tool instead of trusting a block.",
].join("\n");

export const TOOLS = [
  {
    name: "read",
    description: "Read the contents of one file (pinned experiment profile).",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
  },
  {
    name: "grep",
    description: "Search file contents for a pattern (pinned experiment profile).",
    inputSchema: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"], additionalProperties: false },
  },
  {
    name: "read_memory_source",
    description: "Recover one Memory block's original conversation (pinned experiment profile).",
    inputSchema: {
      type: "object",
      properties: { block: { type: "integer" }, page: { type: "integer" } },
      required: ["block", "page"],
      additionalProperties: false,
    },
  },
];

export const SETTINGS = Object.freeze({ maxOutputTokens: 512, stream: true, thinking: "off", cacheRetention: "short" });

export const TOOLS_HASH = sha256Hex(JSON.stringify(TOOLS));

/**
 * The request's tool catalog (#297 review findings 2 and 3): the shared
 * pinned profile with one neutral isolation token appended to every tool
 * description. The token follows the same derivation as the system
 * namespace — run+group+arm for the arms under test, per request for the nonce
 * control — because measured gateways also reuse cache by content hash
 * across positions, not only by prefix: without the token, every arm's
 * byte-identical tool catalog was reusable across arms and roles, which
 * both contaminated the arms and drowned the control's observable
 * divergence. With it, no request can reuse another run's, group's, arm's,
 * or (for the control) request's tool blocks, while each measured pair's
 * prime/probe carried prefix stays byte-stable.
 */
export function toolsFor(runNonce, request) {
  const token = requestNamespace(runNonce, request);
  return TOOLS.map((tool) => ({ ...tool, description: `${tool.description} [isolation:${token}]` }));
}

export const SYSTEM_PROMPT_HASH = sha256Hex(SYSTEM_PROMPT);
export const SETTINGS_HASH = sha256Hex(JSON.stringify(SETTINGS));

/**
 * The cold isolation namespaces (#297 review findings 2 and 3, round 3):
 * fixed-width, semantically neutral tokens derived from the run nonce, the
 * group, and the arm name, placed at the very front of the system segment —
 * before any shared cacheable byte — so requests from different groups,
 * arms, or executions of the experiment diverge inside the first bytes of
 * the payload and can never read each other's cache at any prefix length the
 * provider could serve. The group is part of the derivation because each
 * group is an independent cold prime/probe pair: without it, a later
 * group's prime read the same-arm boundary an earlier group's requests had
 * already cached, and the five groups were not independent measurements.
 * The nonce is generated per execution and recorded in the report pins; a
 * measured arm's token is identical between its prime and probe (the
 * same-pair carried prefix stays byte-stable) and different for every other
 * pair.
 *
 * The `nonce` control arm is the observable liveness control: its namespace
 * token is derived per request, so its probe cannot read even its own
 * prime's system breakpoint. If the provider's cache reports track content
 * at all, the nonce arm's probe reads measurably less than the arms under
 * test and the liveness rule is alive; a dead control means the measurement
 * cannot distinguish content in any region it can serve, and the verdict
 * stays inconclusive. The carried Memory region itself is structurally
 * unservable under the pinned breakpoint placement (#269), which the report
 * states — the control validates the measurement, not that region.
 */
const NAMESPACE_WIDTH = 16;
export const NAMESPACE_LINE_PREFIX = "Experiment isolation namespace ";
/** The nonce used for the pinned fixture digest; every live run passes its own. */
export const DIGEST_NONCE = "fixture-digest";

export function armNamespace(runNonce, group, arm) {
  return sha256Hex(`provider-cache-experiment|namespace|${runNonce}|${group}|${arm}`).slice(0, NAMESPACE_WIDTH);
}

/** The request's isolation namespace token: fixed per run+group+arm pair; per request for the control arm. */
export function requestNamespace(runNonce, { group, arm, role }) {
  if (arm === "nonce") {
    return sha256Hex(`provider-cache-experiment|namespace|${runNonce}|${arm}|${group}|${role}`).slice(0, NAMESPACE_WIDTH);
  }
  return armNamespace(runNonce, group, arm);
}

/** The request's system prompt: its isolation namespace line first, then the shared base. */
export function systemPromptFor(runNonce, request) {
  const token = requestNamespace(runNonce, request);
  return `${NAMESPACE_LINE_PREFIX}${token} — fixed for this run, carries no task meaning.\n${SYSTEM_PROMPT}`;
}

/**
 * The measured minimum cacheable prefix of the qualification gateway (#251,
 * 2026-09-01, claude-sonnet-5 through the #249 adapter): a 968-token request
 * did not cache, a 1 121-token request did. Requests below this floor cache
 * nothing, so no hit rate can be computed from them.
 */
export const MEASURED_CACHEABLE_PREFIX_TOKENS = 1024;

/**
 * The pinned fixture scale floors (#260, re-pinned #297): every composed
 * request's covered prefix (bytes zero through the tail breakpoint — system,
 * tools, the whole carried summary, and the whole tail) must clear twice the
 * measured floor, and every probe's carried prefix (system, tools, framing,
 * and blocks 1–2 — the region whose reuse the append case measures) must
 * clear the measured floor itself. `DETAIL_LINES_PER_BLOCK` is tuned so the
 * smallest covered prefix in the whole fixture clears both with headroom;
 * the experiment tests assert the invariants, not the tuning constant.
 */
export const COVERED_PREFIX_FLOOR_TOKENS = 2048;
export const CARRIED_PREFIX_FLOOR_TOKENS = MEASURED_CACHEABLE_PREFIX_TOKENS;
const DETAIL_LINES_PER_BLOCK = 40;

/**
 * Deterministic per-block padding: semantically shaped task-narrative lines
 * that carry no randomness, stay identical between a group's prime and probe
 * for the carried blocks, and never repeat one character 64+ times. Each kind
 * keeps its own line shape so block texts stay unique inside a payload.
 */
function detailLines(kind, group) {
  const shapes = {
    setup: (index) => `frozen row ${index}: scenario ${group}-${index} carries ${3 + (index % 4)} cases, a pinned expectation, and no deferred input`,
    parser: (index) => `ledger entry ${index}: column ${11 + index} kept its width marker, and case ${group}-${index} re-parsed without residue`,
    verification: (index) => `check pass ${index}: ${37 + index} assertions held, and the residual risk row ${index} stayed attached to task ${group}`,
  };
  const lines = [];
  for (let index = 1; index <= DETAIL_LINES_PER_BLOCK; index += 1) {
    lines.push(`- ${shapes[kind](index)}`);
  }
  return lines;
}

function setupBlock(group) {
  return [
    `# ${MARKER} task ${group} setup`,
    "",
    `- scope agreed and fixtures frozen for task ${group}`,
    `- the harness wires ${group} scenario rows before any run`,
    ...detailLines("setup", group),
  ].join("\n");
}

function parserBlock(group) {
  return [
    `# ${MARKER} task ${group} parser work`,
    "",
    "- width handling corrected after the failing cases",
    `- the decision is recorded in the ledger with the task ${group} tag`,
    ...detailLines("parser", group),
  ].join("\n");
}

function verificationBlock(group) {
  return [
    `# ${MARKER} task ${group} verification`,
    "",
    "- the checks run green after the fix",
    `- the residual risk note stays attached to task ${group}`,
    ...detailLines("verification", group),
  ].join("\n");
}

export function baseBlocks(group) {
  return [setupBlock(group), parserBlock(group), verificationBlock(group)];
}

/**
 * The carried blocks of one request (#297): the prime carries blocks 1–2; the
 * probe carries those plus the appended block 3. Identical across arms — the
 * arms differ only in their isolation namespace and their summary block
 * boundaries; the nonce control arm diverges through its per-request
 * namespace token, not through its block bodies.
 */
export function carriedBodies({ group, role }) {
  const blocks = [baseBlocks(group)[0], baseBlocks(group)[1]];
  if (role === "probe") blocks.push(baseBlocks(group)[2]);
  return blocks;
}

/**
 * The summary region's text content blocks for one arm request (#297), both
 * derived from the production code paths so the fixture can never drift from
 * what Pi actually sends: the `multiblock` arm uses the extension's own
 * `projectMemoryBlocksMessage` output parts (leading framing + wrapper, one
 * separator+body part per block, trailing framing), and the `single` arm
 * uses Pi's own `convertToLlm` rendering of the same compaction summary as
 * one text block. The parts concatenate to byte-identical text across arms.
 */
export function summaryPartTexts(arm, bodies) {
  if (arm === "single") {
    const message = { role: "compactionSummary", summary: composeMemorySummary(bodies), tokensBefore: 0, timestamp: 0 };
    return [convertToLlm([message])[0].content[0].text];
  }
  const summary = composeMemorySummary(bodies);
  const projected = projectMemoryBlocksMessage(
    [{ role: "compactionSummary", summary, tokensBefore: 0, timestamp: 0 }],
    [{ summary, bodies }],
  );
  if (projected === undefined) {
    throw new Error("the production projection rejected the fixture summary");
  }
  return projected[0].content.map((part) => part.text);
}

/**
 * The prime's tail: the pre-run conversation plus the run's request. The
 * probe's tail: the append compaction kept the whole first run, so the tail
 * is that run's retained entries plus the second request. Same row count and
 * scale, different deterministic text — the append absorbed the prime's tail
 * into block 3, so the probe must not repeat it.
 */
export function traceTail(group, { probe }) {
  if (!probe) {
    return [
      { role: "user", text: `Begin task ${group}: stabilize the parser harness for the ${MARKER} corpus.` },
      { role: "assistant", text: `Task ${group} fixtures parsed; three cases fail on column width.` },
      { role: "user", text: `Fix the width handling for task ${group} and record the decision.` },
      { role: "assistant", text: `Width handling fixed for task ${group}; decision recorded.` },
      { role: "user", text: `Run the checks for task ${group} again.` },
      { role: "tool", text: `checks: 42 passed, 0 failed (task ${group}, ${MARKER})` },
      { role: "user", text: `Release task ${group}: start the pinned run now.` },
    ];
  }
  return [
    { role: "user", text: `Release task ${group}: start the pinned run now.` },
    { role: "assistant", text: `Task ${group} run finished; the width fix held under load.` },
    { role: "user", text: `Continue task ${group} with the release notes.` },
    { role: "assistant", text: `Release notes drafted for task ${group}.` },
    { role: "user", text: `File the follow-ups for task ${group}.` },
    { role: "assistant", text: `Follow-ups filed for task ${group}; nothing deferred.` },
    { role: "user", text: `Verify task ${group} once more after the append.` },
  ];
}

/**
 * Composes one arm request. Returns the canonical payload plus the byte
 * layout the divergence invariants are checked against: each memory block's
 * global byte range, the probe's exact append seam (`expectedShared`), and
 * the three canonical breakpoint positions every request declares — the end
 * of the system segment, the end of the tools segment, and the end of the
 * last message segment, mirroring Pi's placement.
 *
 * The summary region is emitted as contiguous `summary-part-N` segments: the
 * multiblock arm carries one segment per text content block (frame part, one
 * part per block, frame part); the single arm carries exactly one segment
 * holding the whole summary text as one block. The credentialed adapter
 * reconstructs one user message with one text block per summary-part segment
 * from the contiguous run.
 */
export function composeRequest({ group, arm, role, runNonce = DIGEST_NONCE }) {
  const bodies = carriedBodies({ group, role });
  const partTexts = summaryPartTexts(arm, bodies);
  const tail = traceTail(group, { probe: role === "probe" });
  const segments = [
    { element: "system", text: systemPromptFor(runNonce, { group, arm, role }) },
    { element: "tools", text: JSON.stringify(toolsFor(runNonce, { group, arm, role })) },
    ...partTexts.map((text, index) => ({ element: `summary-part-${index}`, text })),
    ...tail.map((message, index) => ({
      element: `message-${index}`,
      text: `${message.role}: ${message.text}`,
    })),
  ];
  const payload = canonicalPayload(segments);
  const segmentOf = (element) => payload.table.find((entry) => entry.element === element);
  const breakpoints = [
    segmentOf("system").contentEnd,
    segmentOf("tools").contentEnd,
    segmentOf(`message-${tail.length - 1}`).contentEnd,
  ];
  const systemSegment = segmentOf("system");
  const systemText = payload.bytes.subarray(systemSegment.contentStart, systemSegment.contentEnd).toString("utf8");
  const layout = {
    summaryParts: partTexts.map((text) => locateUnique(payload.bytes, text)),
    blocks: bodies.map((body) => locateUnique(payload.bytes, body)),
    breakpoints,
    // The isolation-namespace line's global end: the control arm's probe must
    // diverge strictly inside it, before any shared cacheable content.
    namespaceEnd: systemSegment.contentStart + systemText.indexOf("\n"),
    expectedShared: null,
  };
  if (role === "probe") {
    // The exact byte position where the probe first diverges from its prime.
    // Both arms share every carried byte and diverge exactly at the append
    // seam: the multiblock arm's next summary segment has an identical
    // element name and diverges at its first content byte, while the single
    // arm diverges inside its one summary part where the appended separator
    // begins. The seam position is advanced past the leading bytes the
    // trailing framing and the appended separator genuinely share — both
    // begin with a newline — so the pinned boundary is the first byte that
    // actually differs, derived from the fixture's own literals.
    // The trailing framing the prime continues with at the seam: the
    // multiblock arm's own trailing part, or the framing tail of the single
    // arm's one part after its composed summary.
    const composedAll = composeMemorySummary(bodies);
    const trailing = Buffer.from(
      arm === "single"
        ? partTexts[0].slice(partTexts[0].indexOf(composedAll) + composedAll.length)
        : partTexts[partTexts.length - 1],
      "utf8",
    );
    const seam = arm === "single"
      ? locateUnique(payload.bytes, composeMemorySummary(bodies.slice(0, 2))).end
      : segmentOf(`summary-part-${bodies.length}`).contentStart;
    let sharedPrefix = 0;
    while (
      seam + sharedPrefix < payload.bytes.length
      && sharedPrefix < trailing.length
      && payload.bytes[seam + sharedPrefix] === trailing[sharedPrefix]
    ) {
      sharedPrefix += 1;
    }
    layout.expectedShared = seam + sharedPrefix;
  }
  return {
    group,
    arm,
    role,
    payload,
    layout,
  };
}

/** Digest over every composed payload in pinned per-group order: the pinned fixture. */
export function fixtureDigest(groupCount = GROUP_COUNT) {
  const hash = createHash("sha256");
  for (let group = 1; group <= groupCount; group += 1) {
    for (const step of groupOrder(group)) {
      const [arm, role] = step.split(".");
      const { payload } = composeRequest({ group, arm, role });
      hash.update(sha256Hex(payload.bytes));
      hash.update("\0");
    }
  }
  return hash.digest("hex");
}
