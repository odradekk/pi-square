/**
 * Shadow result store (odradekk/pi-square#363).
 *
 * One module owns the complete lifecycle of a Shadow result: creation from a
 * schema-valid `submit_shadow_result` payload, listing, the delivery
 * transitions (`notified → pending → delivered`, degradation back to
 * inbox-only, forced downgrade of stale-task results, and reopen recovery),
 * attention (read, dismiss, delete), the exclusive transcript-reference
 * claims that keep one authoritative result to one bounded reference (#181),
 * retention eviction, and clearing. The session-scoped in-memory store below
 * and the persistent per-session partition (`inbox-store.ts`) both implement
 * this same interface in full: persistence is an internal strategy of each
 * implementation, never a capability gap exposed through optional members,
 * so callers never probe for features and never branch on a `persistent`
 * flag — a persistent partition's `clear()` is a deliberate no-op, which is
 * what makes the unconditional reset correct.
 *
 * `subscribe` fans out synchronously after each single-result
 * delivery/attention transition the runtime historically surfaced to its
 * observers (`send`, `markRead`, `dismiss`, `delete`, `markDelivered`,
 * `degradeToNotify`). Creation, claim bookkeeping, forced downgrades, bulk
 * recovery, and clearing do not emit; their drivers refresh observers around
 * the call.
 */

import { randomUUID } from "node:crypto";
import type { ChildSessionUsage } from "../subagents/child-session-executor";
import type { ShadowDelivery, ShadowOutputSchema, ShadowTrigger } from "./parser";
import { summarizeShadowResult } from "./result";

export type ShadowResultDelivery = "notified" | "pending" | "delivered";
export type ShadowResultAttention = "unread" | "read" | "dismissed";

/** How the activation that produced a result entered the runtime. */
export type ShadowResultSource = "manual" | "automatic";

/** Task identity of the activation that produced a result (scheduling fills it). */
export interface ShadowTaskIdentity {
  epoch: number;
  /** Parent-run sequence in which the automatic activation was observed. */
  sourceRun?: number;
  parentEntryId?: string;
}

/** Bounded provenance and contract metadata every result records (#157). */
export interface ShadowResultMetadata {
  /** Hash of the effective definition source that produced the result. */
  definitionHash?: string;
  /** Hash of the effective output schema the payload validated against. */
  schemaHash?: string;
  /** The definition's configured delivery policy at run time. */
  configuredDelivery?: ShadowDelivery;
  /** Manual trial or scheduler-dispatched activation. */
  source?: ShadowResultSource;
  /** Canonical highest-priority trigger for an automatic activation. */
  primaryTrigger?: ShadowTrigger;
  /** Trigger reasons of the activation; automatic scheduling fills these. */
  triggers?: ShadowTrigger[];
  taskIdentity?: ShadowTaskIdentity;
  /** Terminal lifecycle for a persisted cognitive result. */
  lifecycle?: "submitted";
  /** Number of child tool executions observed before submission. */
  toolCalls?: number;
  /** Whether deterministic trajectory truncation qualified this result. */
  trajectoryTruncated?: boolean;
  /** Bounded per-request usage and TTFT records. */
  requests?: Array<{
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
    ttftMs?: number;
    /** One-based turn ordinal (#161). */
    turn?: number;
    /** Tool executions attributed to this request (#161). */
    toolCalls?: number;
    /** Present only when the provider report carried cache fields (#161). */
    cacheReported?: boolean;
  }>;
}

export interface ShadowResultEntity extends ShadowResultMetadata {
  id: string;
  shadowId: string;
  shadowName: string;
  /** Legacy compatibility field; `source` and `primaryTrigger` are authoritative. */
  trigger: "manual";
  note?: string;
  payload: unknown;
  summary: string;
  delivery: ShadowResultDelivery;
  attention: ShadowResultAttention;
  createdAt: number;
  model?: string;
  usage?: ChildSessionUsage;
  /** Set once the parent transcript carries this result's bounded reference. */
  referenced?: boolean;
}

/** Default in-memory retention; the persistent store keeps the same bound. */
export const SHADOW_INBOX_DEFAULT_MAX_RESULTS = 100;

/** One recorded retention eviction, surfaced to manager diagnostics. */
export interface ShadowResultStoreEvictionEvent {
  kind: "evicted";
  id: string;
  at: number;
  reason: "count" | "bytes";
}

export interface ShadowResultStoreAddInput extends ShadowResultMetadata {
  /** Effective validated schema persisted only as the disk re-validation contract. */
  validationSchema?: ShadowOutputSchema;
  shadowId: string;
  shadowName: string;
  payload: unknown;
  note?: string;
  createdAt: number;
  model?: string;
  usage?: ChildSessionUsage;
}

/**
 * The single Shadow result store contract. Every member is required and both
 * implementations (in-memory below, persistent partition in `inbox-store.ts`)
 * honor the full surface; there is no capability-probing and no persistence
 * branching at call sites.
 */
export interface ShadowResultStore {
  add(input: ShadowResultStoreAddInput): ShadowResultEntity;
  list(): ShadowResultEntity[];
  /**
   * Atomic `notified → pending` delivery transition; the confirmed-delivery
   * slice drives it through to `delivered`. Refused for any other state.
   */
  send(id: string): boolean;
  markRead(id: string): boolean;
  dismiss(id: string): boolean;
  delete(id: string): boolean;
  /**
   * Downgrades one still-undelivered result's configured delivery to
   * `notify`; a new parent task forces old-task results inbox-only.
   */
  forceNotify(id: string): boolean;
  /** Confirms one delivery from transcript observation; `pending → delivered`. */
  markDelivered(id: string): boolean;
  /**
   * A degraded delivery returns inbox-only: `pending → notified` with notify
   * policy. Refused for delivered results.
   */
  degradeToNotify(id: string): boolean;
  /**
   * Reopen recovery: results left `pending` by a lost session return
   * inbox-only with notify policy; delivery never resumes automatically.
   */
  recoverPendingDelivery(): number;
  /**
   * Atomically claims the right to append this result's bounded transcript
   * reference (#181). The claim is acquired before the append and is shared
   * at the store's lifecycle scope — the persistent partition arbitrates
   * between overlapping runtime instances and extension instances — so one
   * authoritative result produces at most one reference. Returns false when
   * another holder still owns the claim or the result is already referenced.
   */
  claimReference(id: string): boolean;
  /**
   * Releases a claim after a failed append so a later update can retry; the
   * result itself stays available in the store.
   */
  releaseReferenceClaim(id: string): void;
  /**
   * Persists that the parent transcript already carries this result's
   * bounded reference entry, so a reopen does not append it again.
   */
  markReferenced(id: string): boolean;
  /** Recorded retention events; the in-memory store records none. */
  events(): ShadowResultStoreEvictionEvent[];
  /**
   * Wipes session-scoped state. The persistent partition is the authoritative
   * record and deliberately survives this call; only the in-memory store
   * removes anything.
   */
  clear(): void;
  /**
   * Subscribes to single-result delivery/attention transitions (`send`,
   * `markRead`, `dismiss`, `delete`, `markDelivered`, `degradeToNotify`);
   * returns the unsubscribe. Creation, claim bookkeeping, forced downgrades,
   * bulk recovery, and clearing do not emit.
   */
  subscribe(listener: () => void): () => void;
}

/** Retention order: oldest resolved (read, dismissed, or delivered) first. */
export function evictionCandidate(entries: readonly ShadowResultEntity[]): ShadowResultEntity | undefined {
  return [...entries]
    .filter((entry) => entry.attention !== "unread" || entry.delivery === "delivered")
    .sort((a, b) => a.createdAt - b.createdAt)[0]
    ?? [...entries].sort((a, b) => a.createdAt - b.createdAt)[0];
}

/**
 * Session-scoped in-memory result store. Newest first; every state
 * transition is observable and unknown IDs are refused. `send` performs the
 * atomic `notified → pending` delivery transition. Retention evicts the
 * oldest resolved (read, dismissed, or delivered) entries before unread
 * notified ones, matching the persistent retention order.
 */
export function createShadowResultStore(options?: { maxResults?: number; makeId?: () => string }): ShadowResultStore {
  const maxResults = Math.min(
    SHADOW_INBOX_DEFAULT_MAX_RESULTS,
    Math.max(1, Math.trunc(options?.maxResults ?? SHADOW_INBOX_DEFAULT_MAX_RESULTS)),
  );
  const makeId = options?.makeId ?? (() => `shr-${randomUUID()}`);
  const entries: ShadowResultEntity[] = [];
  // One in-flight transcript-reference claim per result id (#181): the
  // fallback store lives in one process, so a plain set coordinates every
  // overlapping subscriber and runtime rebind sharing this instance.
  const referenceClaims = new Set<string>();
  const subscribers = new Set<() => void>();
  const clone = <T>(value: T): T => structuredClone(value);

  const emit = () => {
    for (const subscriber of subscribers) {
      try {
        subscriber();
      } catch {
        // A broken observer never affects result state.
      }
    }
  };

  const evictIfNeeded = () => {
    while (entries.length > maxResults) {
      const candidate = evictionCandidate(entries);
      if (!candidate) return;
      entries.splice(entries.indexOf(candidate), 1);
    }
  };

  return {
    add(input) {
      const entity: ShadowResultEntity = {
        id: makeId(),
        shadowId: input.shadowId,
        shadowName: input.shadowName,
        trigger: "manual",
        ...(input.note?.trim() ? { note: input.note.trim() } : {}),
        payload: clone(input.payload),
        summary: summarizeShadowResult(input.payload),
        delivery: "notified",
        attention: "unread",
        createdAt: input.createdAt,
        ...(input.model ? { model: input.model } : {}),
        ...(input.usage ? { usage: input.usage } : {}),
        ...(input.definitionHash ? { definitionHash: input.definitionHash } : {}),
        ...(input.schemaHash ? { schemaHash: input.schemaHash } : {}),
        ...(input.configuredDelivery ? { configuredDelivery: input.configuredDelivery } : {}),
        ...(input.source ? { source: input.source } : {}),
        ...(input.primaryTrigger ? { primaryTrigger: input.primaryTrigger } : {}),
        ...(input.triggers ? { triggers: [...input.triggers] } : {}),
        ...(input.taskIdentity ? { taskIdentity: clone(input.taskIdentity) } : {}),
      };
      entries.unshift(entity);
      evictIfNeeded();
      return entity;
    },
    list() {
      return entries.map((entry) => clone(entry));
    },
    send(id) {
      const entry = entries.find((item) => item.id === id);
      if (!entry || entry.delivery !== "notified") return false;
      entry.delivery = "pending";
      emit();
      return true;
    },
    markRead(id) {
      const entry = entries.find((item) => item.id === id);
      if (!entry) return false;
      entry.attention = "read";
      emit();
      return true;
    },
    dismiss(id) {
      const entry = entries.find((item) => item.id === id);
      if (!entry) return false;
      entry.attention = "dismissed";
      emit();
      return true;
    },
    delete(id) {
      const index = entries.findIndex((item) => item.id === id);
      if (index === -1) return false;
      entries.splice(index, 1);
      referenceClaims.delete(id);
      emit();
      return true;
    },
    forceNotify(id) {
      const entry = entries.find((item) => item.id === id);
      if (!entry || entry.delivery !== "notified" || entry.configuredDelivery === "notify") return false;
      entry.configuredDelivery = "notify";
      return true;
    },
    markDelivered(id) {
      const entry = entries.find((item) => item.id === id);
      if (!entry || entry.delivery !== "pending") return false;
      entry.delivery = "delivered";
      emit();
      return true;
    },
    degradeToNotify(id) {
      const entry = entries.find((item) => item.id === id);
      if (!entry || entry.delivery === "delivered") return false;
      entry.configuredDelivery = "notify";
      if (entry.delivery === "pending") entry.delivery = "notified";
      emit();
      return true;
    },
    recoverPendingDelivery() {
      let recovered = 0;
      for (const entry of entries) {
        if (entry.delivery !== "pending") continue;
        entry.delivery = "notified";
        entry.configuredDelivery = "notify";
        recovered += 1;
      }
      return recovered;
    },
    claimReference(id) {
      const entry = entries.find((item) => item.id === id);
      if (!entry || entry.referenced || referenceClaims.has(id)) return false;
      referenceClaims.add(id);
      return true;
    },
    releaseReferenceClaim(id) {
      referenceClaims.delete(id);
    },
    markReferenced(id) {
      const entry = entries.find((item) => item.id === id);
      if (!entry || entry.referenced) return false;
      entry.referenced = true;
      referenceClaims.delete(id);
      return true;
    },
    events() {
      return [];
    },
    clear() {
      entries.length = 0;
    },
    subscribe(listener) {
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
  };
}
