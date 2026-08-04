import { randomUUID } from "node:crypto";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { OperationalDisplayComponent, type OperationalDisplayOptions } from "./components";
import { activateQueuedDisplayAdapters } from "./public";
import { effectiveMotion, MotionScheduler, processMotionEnvironment, type MotionClock, type MotionEnvironment } from "./motion";
import { resolveDisplayPolicies, resolveDisplayPolicyForTool, type ResolvedDisplay } from "./policy";
import type { PiSquareConfig } from "../core/config";
import type { DisplayDescriptionV1, DisplayFamily, EffectiveDisplayPolicy } from "./types";

export const DISPLAY_RUNTIME_VERSION = 1 as const;
export const DISPLAY_RUNTIME_SYMBOL = Symbol.for("@odradekk/pi-square.display.runtime.v1");

export interface DisplayRuntimeGlobal {
  readonly version: typeof DISPLAY_RUNTIME_VERSION;
  readonly instanceId: string;
  readonly runtime: DisplayRuntime;
}

export interface DisplayRuntimeOptions {
  readonly environment?: MotionEnvironment;
  readonly clock?: MotionClock;
}

export class DisplayRuntime {
  readonly version = DISPLAY_RUNTIME_VERSION;
  readonly instanceId = randomUUID();
  private resolved: ResolvedDisplay;
  private config: PiSquareConfig;
  private readonly scheduler: MotionScheduler;
  private readonly invalidators = new Set<() => void>();
  private readonly cleanupCallbacks = new Set<() => void>();
  private disposed = false;

  constructor(
    config: PiSquareConfig,
    options: DisplayRuntimeOptions = {},
  ) {
    this.config = structuredClone(config);
    this.resolved = resolveDisplayPolicies(this.config);
    const environment = options.environment ?? processMotionEnvironment();
    this.scheduler = new MotionScheduler(effectiveMotion(this.resolved.motion, environment), options.clock);
  }

  get motion(): MotionScheduler["mode"] {
    return this.scheduler.mode;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  policyFor(toolName: string, family: DisplayFamily): EffectiveDisplayPolicy {
    return this.resolved.policies.get(toolName)
      ?? resolveDisplayPolicyForTool(toolName, family, this.config.display);
  }

  createComponent(
    description: DisplayDescriptionV1,
    theme: Theme,
    options: OperationalDisplayOptions,
  ): OperationalDisplayComponent {
    const effective = this.policyFor(description.tool, description.family);
    return new OperationalDisplayComponent(description, effective.policy, theme, options);
  }

  updateComponent(
    component: OperationalDisplayComponent,
    description: DisplayDescriptionV1,
    theme: Theme,
    options: OperationalDisplayOptions,
  ): void {
    component.update(description, this.policyFor(description.tool, description.family).policy, theme, options);
  }

  subscribe(invalidate: () => void): () => void {
    if (this.disposed) return () => {};
    return this.scheduler.subscribe(invalidate);
  }

  subscribeMotion(component: OperationalDisplayComponent, invalidate: () => void): () => void {
    if (this.disposed) return () => {};
    return this.scheduler.subscribe(() => {
      component.advanceFrame();
      invalidate();
    });
  }

  registerInvalidator(invalidate: () => void): () => void {
    if (this.disposed) return () => {};
    this.invalidators.add(invalidate);
    return () => this.invalidators.delete(invalidate);
  }

  registerCleanup(cleanup: () => void): () => void {
    if (this.disposed) return () => {};
    this.cleanupCallbacks.add(cleanup);
    return () => this.cleanupCallbacks.delete(cleanup);
  }

  updateConfig(config: PiSquareConfig, environment: MotionEnvironment = processMotionEnvironment()): void {
    if (this.disposed) return;
    this.config = structuredClone(config);
    this.resolved = resolveDisplayPolicies(this.config);
    this.scheduler.setMode(effectiveMotion(this.resolved.motion, environment));
    for (const invalidate of [...this.invalidators]) {
      try {
        invalidate();
      } catch {
        this.invalidators.delete(invalidate);
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.scheduler.dispose();
    this.invalidators.clear();
    for (const cleanup of [...this.cleanupCallbacks]) {
      try {
        cleanup();
      } catch {
        // Adapter cleanup is isolated from core runtime disposal.
      }
    }
    this.cleanupCallbacks.clear();
    const current = readGlobalDisplayRuntime();
    if (current?.instanceId === this.instanceId) delete (globalThis as Record<PropertyKey, unknown>)[DISPLAY_RUNTIME_SYMBOL];
  }
}

export function readGlobalDisplayRuntime(): DisplayRuntimeGlobal | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, DISPLAY_RUNTIME_SYMBOL);
  const value = descriptor && "value" in descriptor
    ? descriptor.value as Partial<DisplayRuntimeGlobal> | undefined
    : undefined;
  return value?.version === DISPLAY_RUNTIME_VERSION
    && typeof value.instanceId === "string"
    && value.runtime?.version === DISPLAY_RUNTIME_VERSION
    && value.runtime.instanceId === value.instanceId
    && typeof value.runtime.dispose === "function"
    ? value as DisplayRuntimeGlobal
    : undefined;
}

export function installGlobalDisplayRuntime(runtime: DisplayRuntime): DisplayRuntimeGlobal {
  const previous = readGlobalDisplayRuntime();
  if (previous && previous.instanceId !== runtime.instanceId) previous.runtime.dispose();
  const globalValue: DisplayRuntimeGlobal = Object.freeze({
    version: DISPLAY_RUNTIME_VERSION,
    instanceId: runtime.instanceId,
    runtime,
  });
  (globalThis as Record<PropertyKey, unknown>)[DISPLAY_RUNTIME_SYMBOL] = globalValue;
  activateQueuedDisplayAdapters(runtime);
  return globalValue;
}
