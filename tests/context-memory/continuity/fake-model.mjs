import {
  ADVISORY_TYPE,
  PENDING_ACK,
  createHarness,
  fakeTree,
  userEntry,
  assistantEntry,
  toolResultEntry,
  projectedMessages,
  beforeCompactEvent,
  commitTakeover,
} from "../qualification/harness.mjs";
import {
  QUALIFICATION_CONFIG,
  MODEL_WINDOW,
  START_USAGE_TOKENS,
  POST_COMPACTION_USAGE_TOKENS,
} from "./scenarios.mjs";

/**
 * The scripted dry-run model adapter (#224).
 *
 * It drives the production Context Memory controller through the same
 * Pi-shaped fake host the #223 corpus uses — real `input`, `context`,
 * `message_end`, `agent_settled`, `session_before_compact`, and
 * `session_compact` flows, real submission validation, real takeover and
 * confirmation — while the "model" itself replays the scenario script. The
 * dry-run therefore proves orchestration, evidence capture, scoring, and the
 * report against the real seam without any provider credential.
 *
 * Defect injection is the fault-injection surface for ordinary tests: each
 * defect mutates the scripted model behavior at one named turn so the
 * deterministic oracle can be proven to catch every severe failure class and
 * every gate-blocking condition. Defects never touch the controller.
 */

const SUBMIT = "submit_memory";
const READ_SOURCE = "read_memory_source";
const ASSISTANT_TEXT_CAP = 8_000;
const SOURCE_READ_PAGE_CAP = 12;

/** The adapter declaration every real adapter (#227) must supply in this shape. */
export const FAKE_ADAPTER_DECLARATION = {
  id: "scripted-fake",
  requiredEnv: [],
  arms: {
    primary: {
      provider: "fixture",
      model: "scripted-continuity/1",
      thinking: "off",
      sampling: { mode: "deterministic-scripted", temperature: null, topP: null },
    },
    secondary: {
      provider: "fixture",
      model: "scripted-continuity/1",
      thinking: "off",
      sampling: { mode: "deterministic-scripted", temperature: null, topP: null },
    },
  },
};

export function createFakeAdapter(options = {}) {
  const { defects = [] } = options;
  return {
    declaration: FAKE_ADAPTER_DECLARATION,
    requiredEnv: FAKE_ADAPTER_DECLARATION.requiredEnv,
    createSession({ script }) {
      return createFakeSession({ script, defects });
    },
  };
}

function createFakeSession({ script, defects }) {
  // The usage object is shared with the fake host by reference: the session
  // moves it across the due point exactly the way Pi's live usage moves.
  const usage = { tokens: START_USAGE_TOKENS, contextWindow: MODEL_WINDOW };
  const harness = createHarness({ config: QUALIFICATION_CONFIG, usage });
  const session = fakeTree([]);
  // #261: the branch starts seeded with fixture-authored Memory rendering at
  // exactly half the budget, so the append-versus-rebuild schedule is
  // fixture-owned rather than a function of the model's prose length.
  script.seed?.apply(session);
  const ctx = harness.baseContext(session);
  const compressions = [];
  const abandonedPatterns = (script.oracle.branch?.abandoned ?? []).flatMap((entry) => entry.patterns);
  let blocks = script.seed?.blockCount ?? 0;
  // #265: the body of the block submitted at the run's due boundary, so the
  // compression event can carry the model-authored Memory into evidence.
  let submittedBody = null;
  let requestEntryId = null;
  let idCounter = 0;
  let started = false;
  let retainedLeafId = null;

  const nextId = (prefix) => `${prefix}-${String((idCounter += 1)).padStart(3, "0")}`;
  const emit = (name, event) => harness.emit(name, event, ctx);

  async function start() {
    if (started) return;
    started = true;
    await emit("session_start", { type: "session_start", reason: "new" });
  }

  /**
   * The scripted model: one turn becomes up to three assistant beats plus
   * their tool work. A due turn carries the sole `submit_memory` call in its
   * own beat and then — after the pending acknowledgement, in the same run —
   * the turn's final answer; a source-recovery final task reads the Memory
   * source first, then answers.
   */
  function beatsFor(turn) {
    const defectsFor = defects.filter((defect) => defect.turn === turn.id);
    const skipSubmit = defectsFor.some((defect) => defect.kind === "skip-submit");
    const skipSourceRead = defectsFor.some((defect) => defect.kind === "skip-source-read");
    const fake = turn.fake ?? {};
    const beats = [];

    if (fake.sourceRead && !skipSourceRead) {
      beats.push({ text: fake.preToolText ?? "", sourceRead: fake.sourceRead });
      beats.push({ text: fake.finalText ?? "" });
    } else if ((fake.toolCalls ?? []).length > 0) {
      beats.push({ text: fake.preToolText ?? "", toolCalls: fake.toolCalls });
      if (fake.finalText) beats.push({ text: fake.finalText });
    } else if (fake.submit && !skipSubmit) {
      // #253 run shape: the model finishes the task work, makes the sole
      // submit_memory call, receives the pending acknowledgement, and then
      // continues the same run to deliver the turn's answer.
      beats.push({ text: "Task work complete; submitting the Memory block before the final answer.", submit: { body: fake.submit } });
      beats.push({ text: fake.finalText ?? "" });
    } else {
      beats.push({ text: fake.finalText ?? "" });
    }

    const final = beats[beats.length - 1];
    for (const defect of defectsFor) {
      if (defect.kind === "claim") final.text = `${final.text} ${defect.text}`.trim();
      if (defect.kind === "corrupt" && defect.find) {
        final.text = final.text.split(defect.find).join(defect.replaceWith);
      }
      if (defect.kind === "miss" && defect.find) {
        final.text = final.text.split(defect.find).join("");
      }
      if (defect.kind === "action") {
        beats.splice(beats.length - 1, 0, {
          text: "",
          toolCalls: [{ name: defect.tool, args: defect.args ?? {}, result: defect.result ?? "ok" }],
        });
      }
    }
    return beats;
  }

  async function runBeat(turn, beat, evidence) {
    const parts = [];
    if (beat.text) parts.push({ type: "text", text: beat.text });
    const planned = [];
    for (const call of beat.toolCalls ?? []) {
      planned.push({
        name: call.name,
        arguments: call.args ?? {},
        result: call.result ?? "",
        kind: "ordinary",
      });
    }
    if (beat.submit) {
      planned.push({ name: SUBMIT, arguments: { markdown: beat.submit.body ?? "" }, kind: "submit" });
    }
    if (beat.sourceRead) {
      planned.push({
        name: READ_SOURCE,
        arguments: { block: beat.sourceRead.block, page: 1 },
        kind: "source-read",
        sourceRead: beat.sourceRead,
      });
    }
    if (parts.length === 0 && planned.length === 0) return;
    if (beat.text) evidence.assistantText += (evidence.assistantText ? "\n" : "") + beat.text;

    const toolCallParts = planned.map((call) => ({
      type: "toolCall",
      id: nextId(`${turn.id}-call`),
      name: call.name,
      arguments: call.arguments,
    }));
    const content = [...parts, ...toolCallParts];
    session.append(assistantEntry(nextId(`${turn.id}-a`), session.getLeafId(), content));
    await emit("message_end", { type: "message_end", message: { role: "assistant", content } });

    for (let index = 0; index < planned.length; index += 1) {
      const call = planned[index];
      const toolCallId = toolCallParts[index].id;
      if (call.kind === "submit") {
        const submit = harness.tools.get(SUBMIT);
        submittedBody = typeof call.arguments?.markdown === "string" ? call.arguments.markdown : "";
        await submit.execute(toolCallId, call.arguments, undefined, undefined, ctx);
        session.append(toolResultEntry(nextId(`${turn.id}-r`), session.getLeafId(), SUBMIT, PENDING_ACK));
        evidence.toolCalls.push(SUBMIT);
      } else if (call.kind === "source-read") {
        const read = harness.tools.get(READ_SOURCE);
        const record = { block: call.sourceRead.block, pages: 0, verified: false };
        const target = String(call.sourceRead.target).toLowerCase();
        for (let page = 1; page <= SOURCE_READ_PAGE_CAP; page += 1) {
          const result = await read.execute(nextId(`${turn.id}-read`), { block: record.block, page }, undefined, undefined, ctx);
          const text = result.content.map((part) => part.text).join("\n");
          session.append(toolResultEntry(nextId(`${turn.id}-r`), session.getLeafId(), READ_SOURCE, text));
          record.pages = page;
          if (text.toLowerCase().includes(target)) record.verified = true;
          if (!result.details.hasMore) break;
        }
        evidence.toolCalls.push(READ_SOURCE);
        evidence.sourceReads.push(record);
      } else {
        session.append(toolResultEntry(nextId(`${turn.id}-r`), session.getLeafId(), call.name, call.result));
        evidence.toolCalls.push(call.name);
      }
    }
  }

  async function runTurn(turn) {
    await start();
    const evidence = {
      turn: turn.id,
      kind: turn.kind,
      advisory: false,
      assistantText: "",
      assistantChars: 0,
      requestChars: 0,
      toolCalls: [],
      sourceReads: [],
      compression: null,
      memoryPurity: null,
      error: null,
    };

    try {
      // Branch mechanics: explore on a dead sibling path, then navigate back.
      if (turn.fake?.branch?.explore?.length) {
        retainedLeafId = session.getLeafId();
        for (const exchange of turn.fake.branch.explore) {
          await emit("input", { type: "input", text: exchange.user, source: "interactive" });
          session.append(userEntry(nextId(`${turn.id}-xu`), session.getLeafId(), exchange.user));
          await emit("context", { type: "context", messages: projectedMessages(session) });
          session.append(assistantEntry(nextId(`${turn.id}-xa`), session.getLeafId(), [{ type: "text", text: exchange.assistant }]));
          await emit("message_end", {
            type: "message_end",
            message: { role: "assistant", content: [{ type: "text", text: exchange.assistant }] },
          });
        }
      }
      if (turn.fake?.branch?.returnToRetained && retainedLeafId !== null) {
        const oldLeaf = session.getLeafId();
        session.branchTo(retainedLeafId);
        await emit("session_tree", { type: "session_tree", newLeafId: retainedLeafId, oldLeafId: oldLeaf });
      }

      // The real-user turn: input (which opens the due run while the previous
      // entry is still the leaf, exactly as Pi orders it), entry, provider
      // request, scripted reply.
      await emit("input", { type: "input", text: turn.user, source: "interactive" });
      const userId = nextId(`${turn.id}-u`);
      session.append(userEntry(userId, session.getLeafId(), turn.user));
      requestEntryId = userId;

      const request = projectedMessages(session);
      const transformed = await emit("context", { type: "context", messages: request });
      const messages = transformed?.messages ?? request;
      evidence.advisory = messages.at(-1)?.customType === ADVISORY_TYPE;
      evidence.requestChars = JSON.stringify(messages).length;

      for (const beat of beatsFor(turn)) {
        await runBeat(turn, beat, evidence);
      }
      if (evidence.assistantText.length > ASSISTANT_TEXT_CAP) {
        evidence.assistantText = evidence.assistantText.slice(0, ASSISTANT_TEXT_CAP);
      }
      evidence.assistantChars = evidence.assistantText.length;

      if (typeof turn.usageAfter === "number") usage.tokens = turn.usageAfter;
      const compactsBefore = harness.compactCalls.length;
      await emit("agent_settled", { type: "agent_settled" });

      if (harness.compactCalls.length > compactsBefore) {
        const takeover = await emit(
          "session_before_compact",
          beforeCompactEvent(session, { firstKeptEntryId: requestEntryId }),
        );
        if (takeover?.compaction) {
          const entry = await commitTakeover(harness, session, ctx, takeover);
          usage.tokens = POST_COMPACTION_USAGE_TOKENS;
          const blocksAfter = entry.details.blocks.length;
          compressions.push({
            turn: turn.id,
            turnIndex: null,
            operation: blocks === 0 || blocksAfter > blocks ? "append" : "rebuild",
            blocksBefore: blocks,
            blocksAfter,
            // #265: the block body this scripted model authored at the
            // boundary, retained with the event for real-mode evidence.
            block: submittedBody,
          });
          submittedBody = null;
          blocks = blocksAfter;
          evidence.compression = compressions[compressions.length - 1];
          if (abandonedPatterns.length > 0) {
            evidence.memoryPurity = !abandonedPatterns.some((pattern) => entry.summary.includes(pattern));
          }
        } else {
          evidence.error = "the settle-triggered compaction fell back to Pi native; no Memory takeover matched";
          usage.tokens = POST_COMPACTION_USAGE_TOKENS;
        }
      }
    } catch (error) {
      evidence.error = `turn harness failure: ${error instanceof Error ? error.message : String(error)}`;
    }
    return evidence;
  }

  return {
    async runTurn(turn) {
      return runTurn(turn);
    },
    /** The live compression list; the runner stamps turn indexes after the fact. */
    stats() {
      return { compressions };
    },
    async close() {
      await emit("session_shutdown", { type: "session_shutdown" });
    },
  };
}
