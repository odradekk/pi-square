import {
  assistantContentKey,
  callKeyOf,
  CHILD_HISTORY_READ_ERROR,
  createChildHistory,
} from "./child-history";
import type {
  AssistantTextPart,
  ChildHistorySnapshot,
  ChildHistoryView,
  TranscriptItem,
} from "./child-history";
import { MAX_LIVE_ITEMS, type ChildViewEvent, type ChildViewFeed, type DroppedEventFingerprint } from "./live-events";

/**
 * The child transcript module (odradekk/pi-square#367): the single owner of
 * the transcript one viewer sees for one background child.
 *
 * The interface answers three questions and nothing more: read a page of
 * persisted history, read the live tail, and subscribe to changes. The
 * persisted side wraps the demand-paged native-session reader
 * (`child-history.ts`); the live side applies the ephemeral view events
 * (`live-events.ts`) to one bounded ordered tail. Both files are this
 * module's implementation and no longer surface to the viewer or the roster.
 *
 * Since #371 the module also owns the wiring around those questions: the
 * session-scoped registry retains one transcript per observed child —
 * constructing the demand pager and forwarding the child's ephemeral view
 * feed into the tail, containing a subscriber failure as the one bounded
 * diagnostic row — while the guarded publisher and the native-event
 * derivation the background run publishes through complete the surface. The
 * background lifecycle, the roster, and the viewer consume only this module
 * for everything live-view.
 *
 * The module also owns the occurrence invariant the two sides used to leave
 * unresolved: one occurrence of a message or tool call is never visible
 * twice. A live entry reconciles against its own persisted record — the same
 * bounded content projection, the same native message timestamp, and a JSONL
 * line beginning exactly at the pre-append history floor the event captured —
 * and the persisted record confirms: the live entry sheds the moment its own
 * record enters the loaded window, whichever side arrived first. The feed
 * bounds, the flush budget, and the generation isolation stay inside
 * `live-events.ts` unchanged (#306); a missing floor or byte offset fails
 * closed and the bounded live row or omission marker stays visible.
 *
 * Everything here stays observational: the module never touches the child
 * lifecycle, result delivery, claim, wait, abort, resume eligibility, or the
 * artifacts on disk. Page loads and event intake only ever mutate this
 * module's own bounded tail state.
 */

/** Hard bound on tracked drop fingerprints before the omission state stops clearing. */
const MAX_DROPPED_FINGERPRINTS = 64;

/** One live tool call, rendered until persisted history covers it. */
export interface ChildLiveToolState {
  /** Non-reversible identity shared with the persisted tool row. */
  readonly callKey: string;
  readonly name: string;
  readonly summary: string;
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly isError?: boolean;
}

/**
 * One entry of the ordered live tail; arrival order mirrors the native
 * stream. Message timestamps and history floors are internal occurrence
 * identity for reconciliation, never rendered.
 */
export type ChildLiveItem =
  | {
      readonly kind: "message";
      readonly content: readonly AssistantTextPart[];
      readonly timestamp?: number;
      readonly historyFloor?: number;
    }
  | { readonly kind: "tool"; readonly tool: ChildLiveToolState };

/**
 * The bounded ephemeral tail below the persisted window: ordered live
 * entries, the cumulative streaming partial of the in-flight assistant
 * message, one bounded diagnostic row, and the omission state kept visible
 * until persisted history recovers the dropped entries. Purely observational;
 * the shape mirrors what the overlay renders and nothing more.
 */
export interface ChildLiveTail {
  readonly items: readonly ChildLiveItem[];
  readonly streaming: readonly AssistantTextPart[] | undefined;
  readonly diagnostic: string | undefined;
  /** Fingerprints of dropped entries persisted history has not recovered yet. */
  readonly droppedCount: number;
  /** Set when fingerprint tracking overflowed: the omission state never clears. */
  readonly droppedUnknown: boolean;
}

/**
 * One module-originated transcript change delivered to subscribers. Live
 * events, diagnostics, and the external catch-up reconcile notify; the
 * choreographed page loads (loadOlder/loadNewer/retryInitial) report their
 * outcome through their return values, so they never notify.
 */
export interface ChildTranscriptChange {
  /**
   * Visible content grew or updated below the persisted window — a streaming
   * update, a new live entry, a drop marker, persisted growth found while
   * reconciling an event, or persisted growth found by an external catch-up.
   * A view that is not following the tail should raise its new-output state;
   * reconciliation-only changes keep it false.
   */
  readonly grew: boolean;
  /**
   * True when the change came from a structural observation — a completion,
   * tool or lifecycle event, a drop marker, or an external catch-up
   * reconcile. A view renders structural changes at its first flush;
   * ordinary streaming deltas and the contained-failure diagnostic stay
   * false and repaint coalesced through the caller's own window.
   */
  readonly structural: boolean;
}

export type ChildTranscriptListener = (change: ChildTranscriptChange) => void;

/**
 * The child transcript surface. `snapshot`, `loadOlder`, `loadNewer`, and
 * `retryInitial` read persisted pages through the owning pager and reconcile
 * the tail against every loaded window; `liveTail` reads the bounded tail;
 * `subscribe` receives the changes the module originates. `applyLiveEvent`
 * and `setLiveDiagnostic` are the intake seams: the registry's feed
 * subscription forwards into them for the observed child, and direct callers
 * (tests, the contained-failure path) use them explicitly.
 */
export interface ChildTranscript {
  /**
   * The current persisted window; see {@link ChildHistorySnapshot}. Every
   * read through the module observes the occurrence invariant: the tail is
   * reconciled against this window first, so a live entry never duplicates a
   * record the loaded window already carries.
   */
  snapshot(): ChildHistorySnapshot;
  /** Attempt one bounded older page; false when none loaded (exhausted or failed). */
  loadOlder(): boolean;
  /** Attempt one bounded newer page; false when none loaded. */
  loadNewer(): boolean;
  /** Retry a failed initial tail load; false when there was nothing to retry. */
  retryInitial(): boolean;
  /**
   * The newer-page cascade behind one call: retries the initial tail while it
   * has never loaded, otherwise reads up to `pages` bounded newer pages,
   * reconciling after every successful load. Returns whether the window
   * changed. The external catch-up is the one load path that notifies on a
   * changed window — the caller is not the only observer, so the view bound
   * to this transcript refreshes through {@link subscribe}; the choreographed
   * page loads above report through their return values and never notify.
   */
  reconcileNewer(pages?: number): boolean;
  /** The bounded live tail below the persisted window. */
  liveTail(): ChildLiveTail;
  /** Feed one ephemeral live view event into the tail and reconcile. */
  applyLiveEvent(event: ChildViewEvent): void;
  /** Record one contained live failure as the bounded diagnostic row. */
  setLiveDiagnostic(text?: string): void;
  /** Subscribe to module-originated changes; returns the unsubscribe. */
  subscribe(listener: ChildTranscriptListener): () => void;
}

export interface ChildTranscriptOptions {
  /** Clock for live tool-row end times; defaults to the wall clock. */
  now?: () => number;
}

/** Internal mutable state of one live tool call; the public {@link ChildLiveToolState} is read-only. */
interface LiveToolState {
  callKey: string;
  name: string;
  summary: string;
  startedAt?: number;
  endedAt?: number;
  isError?: boolean;
}

/** Internal mutable tail entry; the public {@link ChildLiveItem} is a read-only view. */
type LiveItem =
  | { kind: "message"; content: AssistantTextPart[]; timestamp?: number; historyFloor?: number }
  | { kind: "tool"; tool: LiveToolState };

/** Internal mutable tail state; the public {@link ChildLiveTail} is a read-only view. */
interface LiveTail {
  items: LiveItem[];
  streaming: AssistantTextPart[] | undefined;
  diagnostic: string | undefined;
  dropped: DroppedEventFingerprint[];
  droppedUnknown: boolean;
}

function emptyLiveTail(): LiveTail {
  return { items: [], streaming: undefined, diagnostic: undefined, dropped: [], droppedUnknown: false };
}

/** Stable identity of one persisted transcript item inside the loaded window. */
function persistedItemIdentity(item: TranscriptItem, index: number): string {
  return item.entryId !== undefined && item.entryId !== ""
    ? `${callKeyOf(item.entryId)}#${item.entryItemIndex ?? 0}`
    : `@${index}`;
}

function messageTimestamp(message: unknown): number | undefined {
  const value = (message as { timestamp?: unknown })?.timestamp;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function contentKey(content: unknown): string {
  return Array.isArray(content) ? assistantContentKey(content as AssistantTextPart[]) : "";
}

/** Fingerprint of one live entry for the omission-recovery gate. */
function fingerprintOf(item: LiveItem): DroppedEventFingerprint | undefined {
  if (item.kind === "message") {
    if (item.content.length === 0) return undefined;
    const key = contentKey(item.content);
    if (key === "") return undefined;
    return {
      kind: "message",
      key,
      ...(item.timestamp !== undefined ? { timestamp: item.timestamp } : {}),
      ...(item.historyFloor !== undefined ? { historyFloor: item.historyFloor } : {}),
    };
  }
  if (item.tool.callKey === "") return undefined;
  return {
    kind: "tool",
    name: item.tool.name,
    terminal: item.tool.endedAt !== undefined,
    callKey: item.tool.callKey,
  };
}

/**
 * One transcript session over a caller-supplied persisted-history view (the
 * roster retains that pager per child, so a later direct switch restores the
 * loaded window). Constructing the session never reads the session file; the
 * pager the session wraps already loaded its initial tail.
 */
export class ChildTranscriptSession implements ChildTranscript {
  private readonly history: ChildHistoryView;
  private readonly clock: () => number;
  private tail: LiveTail = emptyLiveTail();
  /** Highest pre-append history floor received; duplicate/stale events fail closed. */
  private latestMessageFloor = -1;
  /**
   * The persisted window, read at most once per event application; every
   * successful load invalidates it. Avoids re-copying the pager's bounded
   * item window for each reconciliation pass inside one event.
   */
  private cachedWindow: ChildHistorySnapshot | undefined;
  private readonly listeners = new Set<ChildTranscriptListener>();

  constructor(history: ChildHistoryView, options: ChildTranscriptOptions = {}) {
    this.history = history;
    this.clock = options.now ?? (() => Date.now());
  }

  snapshot(): ChildHistorySnapshot {
    const snapshot = this.history.snapshot();
    this.reconcile(snapshot.items);
    return snapshot;
  }

  loadOlder(): boolean {
    const loaded = this.history.loadOlder();
    if (loaded) {
      this.cachedWindow = undefined;
      this.reconcile(this.windowItems());
    }
    return loaded;
  }

  loadNewer(): boolean {
    const loaded = this.history.loadNewer();
    if (loaded) {
      this.cachedWindow = undefined;
      this.reconcile(this.windowItems());
    }
    return loaded;
  }

  retryInitial(): boolean {
    const retried = this.history.retryInitial();
    if (retried) {
      this.cachedWindow = undefined;
      this.reconcile(this.windowItems());
    }
    return retried;
  }

  reconcileNewer(pages = 1): boolean {
    const changed = this.reconcileWindow(pages);
    // The external catch-up is the one load path with an observer that is not
    // its caller: the view bound to this transcript must refresh too, so a
    // changed window notifies. Event handling reconciles through the private
    // non-notifying cascade and reports through the event's own change.
    if (changed) this.notify({ grew: true, structural: true });
    return changed;
  }

  /**
   * The newer-page cascade without a notification: retries the initial tail
   * while it has never loaded, otherwise reads up to `pages` bounded newer
   * pages, reconciling after every successful load. Returns whether the
   * window changed.
   */
  private reconcileWindow(pages = 1): boolean {
    let changed = false;
    if (this.windowSnapshot().initialError !== undefined) {
      changed = this.history.retryInitial();
    } else {
      for (let page = 0; page < Math.max(1, pages); page += 1) {
        if (!this.history.loadNewer()) break;
        changed = true;
      }
    }
    if (!changed) return false;
    this.cachedWindow = undefined;
    this.reconcile(this.windowItems());
    return true;
  }

  /** The persisted window, cached for one event application. */
  private windowSnapshot(): ChildHistorySnapshot {
    this.cachedWindow ??= this.history.snapshot();
    return this.cachedWindow;
  }

  private windowItems(): readonly TranscriptItem[] {
    return this.windowSnapshot().items;
  }

  liveTail(): ChildLiveTail {
    return {
      items: this.tail.items,
      streaming: this.tail.streaming,
      diagnostic: this.tail.diagnostic,
      droppedCount: this.tail.dropped.length,
      droppedUnknown: this.tail.droppedUnknown,
    };
  }

  subscribe(listener: ChildTranscriptListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  setLiveDiagnostic(text = "live updates paused after a viewer error"): void {
    this.tail.diagnostic = text;
    this.notify({ grew: false, structural: false });
  }

  applyLiveEvent(event: ChildViewEvent): void {
    this.tail.diagnostic = undefined;
    switch (event.kind) {
      case "message_delta":
        this.tail.streaming = event.parts;
        this.notify({ grew: true, structural: false });
        return;
      case "tool_updated":
        // A no-op tool update carries no visible state in the tail.
        return;
      case "message_completed": {
        this.tail.streaming = undefined;
        if (event.content.length > 0) {
          if (event.historyFloor !== undefined && event.historyFloor <= this.latestMessageFloor) {
            // A delayed or duplicated completion: reconcile the persisted
            // window instead of admitting a tail entry that would duplicate
            // an occurrence that already shed.
            this.notify({ grew: this.reconcileWindow(1), structural: true });
            return;
          }
          if (event.historyFloor !== undefined) this.latestMessageFloor = event.historyFloor;
          this.pushLiveItem({
            kind: "message",
            content: event.content,
            ...(event.timestamp !== undefined ? { timestamp: event.timestamp } : {}),
            ...(event.historyFloor !== undefined ? { historyFloor: event.historyFloor } : {}),
          });
          // The completion's own persisted occurrence may already be loaded
          // (a terminal reconcile ran before the scheduled feed flush
          // delivered it), so confirm against the current window instead of
          // waiting for the next page load.
          this.confirmLiveMessages(this.windowItems());
          this.reconcileWindow(1);
          this.notify({ grew: true, structural: true });
          return;
        }
        this.notify({ grew: this.reconcileWindow(1), structural: true });
        return;
      }
      case "tool_started": {
        if (event.callKey === "") {
          this.tail.droppedUnknown = true;
          this.notify({ grew: false, structural: true });
          return;
        }
        const running: LiveToolState = {
          callKey: event.callKey,
          name: event.name,
          summary: event.summary,
          startedAt: event.startedAt,
        };
        const changed = this.reconcileWindow(1);
        if (this.toolCovered(running, this.windowItems())) {
          // The persisted running row already shows the call; no live row.
          this.notify({ grew: changed, structural: true });
          return;
        }
        this.pushLiveItem({ kind: "tool", tool: running });
        this.notify({ grew: true, structural: true });
        return;
      }
      case "tool_finished": {
        if (event.callKey === "") {
          this.tail.droppedUnknown = true;
          this.notify({ grew: false, structural: true });
          return;
        }
        const existing = this.tail.items.find(
          (item): item is Extract<LiveItem, { kind: "tool" }> =>
            item.kind === "tool" && item.tool.callKey === event.callKey,
        );
        const changed = this.reconcileWindow(1);
        const stillLive = existing !== undefined && this.tail.items.includes(existing);
        if (stillLive) {
          // The end state shows without waiting for the toolResult append.
          existing.tool.endedAt = this.clock();
          existing.tool.isError = event.isError;
          this.notify({ grew: true, structural: true });
          return;
        }
        const finished: LiveToolState = {
          callKey: event.callKey,
          name: event.name,
          summary: "called",
          endedAt: this.clock(),
          isError: event.isError,
        };
        if (this.toolCovered(finished, this.windowItems())) {
          // The call's own persisted row already carries the terminal state.
          this.notify({ grew: changed, structural: true });
          return;
        }
        this.pushLiveItem({ kind: "tool", tool: finished });
        this.notify({ grew: true, structural: true });
        return;
      }
      case "live_events_dropped":
        this.recordDropped(event.dropped ?? [], event.droppedUnknown === true);
        this.notify({ grew: true, structural: true });
        return;
      case "run_started":
      case "tool_result_completed":
        this.notify({ grew: this.reconcileWindow(1), structural: true });
        return;
      case "run_finished":
        this.notify({ grew: this.reconcileWindow(8), structural: true });
        return;
    }
  }

  /**
 * The occurrence invariant, run before every persisted window is observed
 * and after every change to it: a live entry sheds exactly when its own
 * persisted record enters the loaded window, and a drop fingerprint clears
 * only for an occurrence persisted history actually recovered.
 */
  private reconcile(items: readonly TranscriptItem[]): void {
    if (this.tail.items.length === 0 && this.tail.dropped.length === 0) return;
    this.confirmLiveMessages(items);
    this.reconcileLiveTools(items);
    this.recoverDropped(items);
  }

  private notify(change: ChildTranscriptChange): void {
    for (const listener of this.listeners) listener(change);
  }

  /**
   * Appends one live entry. Overflow sheds the oldest — never the newest —
   * and records the shed entry's fingerprint so the omission state stays
   * visible until persisted history actually recovers it; if fingerprint
   * tracking itself overflows, the omission state stops clearing entirely.
   */
  private pushLiveItem(item: LiveItem): void {
    this.tail.items.push(item);
    while (this.tail.items.length > MAX_LIVE_ITEMS) {
      const shed = this.tail.items.shift();
      if (shed === undefined) break;
      const fingerprint = fingerprintOf(shed);
      if (fingerprint === undefined) {
        this.tail.droppedUnknown = true;
        continue;
      }
      if (this.tail.dropped.length >= MAX_DROPPED_FINGERPRINTS) {
        this.tail.droppedUnknown = true;
        break;
      }
      this.tail.dropped.push(fingerprint);
    }
  }

  /** Records externally dropped events (feed overflow) for the recovery gate. */
  private recordDropped(fingerprints: readonly DroppedEventFingerprint[], unknown: boolean): void {
    if (unknown) this.tail.droppedUnknown = true;
    for (const fingerprint of fingerprints) {
      if (fingerprint.kind === "message" && fingerprint.historyFloor !== undefined) {
        this.latestMessageFloor = Math.max(this.latestMessageFloor, fingerprint.historyFloor);
      }
      if (this.tail.dropped.length >= MAX_DROPPED_FINGERPRINTS) {
        this.tail.droppedUnknown = true;
        return;
      }
      this.tail.dropped.push(fingerprint);
    }
  }

  /**
   * Confirms pending message completions against their own persisted
   * occurrences. A completion matches a persisted assistant item only when
   * both carry the same bounded content projection and the same native
   * message timestamp and begins exactly at the JSONL size captured before
   * Pi appended that message. Adjacent completions receive increasing floors
   * because Pi persists each `message_end` before emitting the next one. The
   * bounded live entries therefore need no lifetime consumption ledger, and
   * paging an old row back in cannot make it eligible for a newer completion.
   */
  private confirmLiveMessages(items: readonly TranscriptItem[]): void {
    if (this.tail.items.length === 0) return;
    const drop = new Set<LiveItem>();
    const used = new Set<string>();
    for (const item of this.tail.items) {
      if (item.kind !== "message" || drop.has(item)) continue;
      if (item.timestamp === undefined || item.historyFloor === undefined) continue;
      const key = contentKey(item.content);
      if (key === "") continue;
      const match = items.findIndex((persisted, index) => {
        if (persisted.kind !== "assistant") return false;
        if (contentKey(persisted.message.content) !== key) return false;
        const persistedTimestamp = messageTimestamp(persisted.message);
        if (persistedTimestamp === undefined || item.timestamp !== persistedTimestamp) return false;
        const identity = persistedItemIdentity(persisted, index);
        return persisted.entryByteOffset !== undefined
          && persisted.entryByteOffset === item.historyFloor
          && !used.has(identity);
      });
      if (match < 0) continue;
      const persisted = items[match]!;
      used.add(persistedItemIdentity(persisted, match));
      drop.add(item);
    }
    if (drop.size === 0) return;
    this.tail.items = this.tail.items.filter((item) => !drop.has(item));
  }

  /**
   * Whether persisted history now covers one live tool row. The
   * non-reversible key of the native call id is exact per-call identity,
   * including several same-name calls inside one assistant message, so a
   * running row drops only when its own call row is loaded and a finished row
   * only when that row carries its result; the visible terminal state never
   * regresses to running. A malformed event without the native identity is
   * never matched by tool name.
   */
  private toolCovered(tool: LiveToolState, items: readonly TranscriptItem[]): boolean {
    if (tool.callKey !== "") {
      const match = items.find(
        (item): item is TranscriptItem & { kind: "toolCall" } => item.kind === "toolCall" && item.callKey === tool.callKey,
      );
      if (match === undefined) return false;
      return tool.endedAt === undefined || match.result !== undefined;
    }
    return false;
  }

  private reconcileLiveTools(items: readonly TranscriptItem[]): void {
    if (this.tail.items.length === 0) return;
    this.tail.items = this.tail.items.filter((item) => item.kind !== "tool" || !this.toolCovered(item.tool, items));
  }

  /**
   * Clears drop fingerprints only for entries persisted history has actually
   * recovered on screen: a message fingerprint clears when a matching
   * occurrence (same content projection, timestamp, and eligible pre-append
   * floor) is loaded, a tool fingerprint when its own call row is loaded
   * (and, for a dropped terminal event, only once that row has a result).
   * Persisted message occurrences are consumed one-for-one across equal
   * fingerprints. An unrelated append recovers nothing; unknown drops keep
   * the marker visible permanently.
   */
  private recoverDropped(items: readonly TranscriptItem[]): void {
    if (this.tail.dropped.length === 0) return;
    const availableMessages = new Map<string, Array<{ identity: string; byteOffset: number }>>();
    for (const [index, item] of items.entries()) {
      if (item.kind !== "assistant") continue;
      const timestamp = messageTimestamp(item.message);
      if (timestamp === undefined || item.entryByteOffset === undefined) continue;
      const identity = persistedItemIdentity(item, index);
      const key = `${contentKey(item.message.content)}\u0000${timestamp}`;
      const identities = availableMessages.get(key) ?? [];
      identities.push({ identity, byteOffset: item.entryByteOffset });
      availableMessages.set(key, identities);
    }
    this.tail.dropped = this.tail.dropped.filter((fingerprint) => {
      if (fingerprint.kind === "message") {
        if (fingerprint.timestamp === undefined || fingerprint.historyFloor === undefined) return true;
        const key = `${fingerprint.key}\u0000${fingerprint.timestamp}`;
        const identities = availableMessages.get(key);
        const match = identities?.findIndex((candidate) => candidate.byteOffset === fingerprint.historyFloor);
        if (match === undefined || match < 0) return true;
        identities!.splice(match, 1);
        return false;
      }
      return !items.some(
        (item) => item.kind === "toolCall"
          && item.callKey === fingerprint.callKey
          && (!fingerprint.terminal || item.result !== undefined),
      );
    });
  }
}

/** Opens one transcript session over the child's retained persisted-history view. */
export function createChildTranscript(
  history: ChildHistoryView,
  options: ChildTranscriptOptions = {},
): ChildTranscript {
  return new ChildTranscriptSession(history, options);
}

/**
 * The guarded live-event publisher both background start paths share (#371):
 * one publication only ever enqueues into the session feed's bounded FIFO,
 * and even a feed defect stays contained and observational — it can never
 * reach the child run that published.
 */
export function publishChildViewEvent(feed: ChildViewFeed | undefined, id: string, event: ChildViewEvent): void {
  try {
    feed?.publish(id, event);
  } catch {
    // The live view feed is observational only.
  }
}

/**
 * Session-scoped registry of the retained per-child transcripts (#371): the
 * module owns here the wiring the roster used to carry by hand. Retention is
 * per observed child — a later call for the same ID returns the same session,
 * so a direct switch restores the loaded window — and exactly one child is
 * live-observed at a time, matching the single open overlay: the feed
 * forwards its events into the retained session, and moving the observation
 * ends the previous subscription so an unobserved child retains no events.
 * Everything stays observational; releasing drops the module's own sessions
 * and subscriptions and never touches the child or its artifacts.
 */
export interface ChildTranscriptRegistry {
  /**
   * The retained transcript for the child, creating its pager-backed session
   * on first use, and moves the single live observation to this child.
   */
  observe(id: string): ChildTranscript;
  /** Drops one retained child; ends its observation when it was the observed one. */
  release(id: string): void;
  /** Drops every retained transcript and feed subscription (overlay close, session teardown). */
  releaseAll(): void;
}

export interface ChildTranscriptRegistryOptions {
  /** The session feed the observed child's events arrive through; absent stays persisted-only. */
  feed?: ChildViewFeed;
  /** Clock for pager observation stamps and live tool-row end times; defaults to the wall clock. */
  now?: () => number;
}

export function createChildTranscriptRegistry(options: ChildTranscriptRegistryOptions = {}): ChildTranscriptRegistry {
  const feed = options.feed;
  const clock = options.now ?? (() => Date.now());
  const sessions = new Map<string, ChildTranscript>();
  let observedId: string | undefined;
  let unsubscribeFeed: (() => void) | undefined;

  const endObservation = () => {
    unsubscribeFeed?.();
    unsubscribeFeed = undefined;
    observedId = undefined;
  };

  return {
    observe(id) {
      let session = sessions.get(id);
      if (session === undefined) {
        session = createChildTranscript(createChildHistory(id, { observedAt: clock() }), { now: clock });
        sessions.set(id, session);
      }
      if (observedId === id) return session;
      endObservation();
      observedId = id;
      const target = session;
      // The feed is the module's internal transport between the background
      // publisher and the observed child's tail. A subscriber failure is
      // contained as the one bounded diagnostic row — the persisted view
      // stays usable — and the forwarder itself never throws, so the feed
      // never evicts it.
      unsubscribeFeed = feed?.subscribe(id, (event) => {
        try {
          target.applyLiveEvent(event);
        } catch {
          try {
            target.setLiveDiagnostic();
          } catch {
            // Contained: the persisted view stays usable.
          }
        }
      });
      return session;
    },
    release(id) {
      if (observedId === id) endObservation();
      sessions.delete(id);
    },
    releaseAll() {
      endObservation();
      sessions.clear();
    },
  };
}

// The transcript types the viewer renders and the one read-error constant it
// shows reach callers through this module; since #371 the whole live-view
// surface reaches callers only through this module as well — the feed factory
// and guarded publisher the background lifecycle uses, the native-event
// derivation the child execution seam uses, and the repaint seams the roster
// schedules with stay implemented in the module's implementation files.
export { CHILD_HISTORY_READ_ERROR };
export type { AssistantTextPart, ChildHistorySnapshot, ChildHistoryView, TranscriptItem };
export {
  LIVE_REPAINT_COALESCE_MS,
  createChildViewFeed,
  defaultPaintTimers,
  deriveChildViewEvent,
} from "./live-events";
export type { ChildViewEvent, ChildViewFeed, PaintTimers } from "./live-events";
