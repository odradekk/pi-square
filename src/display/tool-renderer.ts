import type {
  AgentToolResult,
  Theme,
  ToolDefinition,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type { Static, TSchema } from "typebox";
import { isOperationalDisplayComponent, type OperationalDisplayComponent } from "./components";
import type { DisplayRuntime } from "./runtime";
import type {
  DisplayDescriptionV1,
  OperationalLifecycle,
} from "./types";

export type DisplayRuntimeProvider = DisplayRuntime | (() => DisplayRuntime);

function resolveRuntime(provider: DisplayRuntimeProvider): DisplayRuntime {
  return typeof provider === "function" ? provider() : provider;
}

export interface DisplayToolRenderContext<TState, TArgs> {
  readonly args: TArgs;
  readonly toolCallId: string;
  readonly invalidate: () => void;
  readonly lastComponent: Component | undefined;
  readonly state: TState;
  readonly cwd: string;
  readonly executionStarted: boolean;
  readonly argsComplete: boolean;
  readonly isPartial: boolean;
  readonly expanded: boolean;
  readonly showImages: boolean;
  readonly isError: boolean;
}

export interface InternalToolDisplayAdapter<
  TParams extends TSchema,
  TDetails,
  TState = unknown,
> {
  readonly describeCall: (
    args: Static<TParams>,
    context: DisplayToolRenderContext<TState, Static<TParams>>,
  ) => DisplayDescriptionV1;
  readonly describeCallAsync?: (
    args: Static<TParams>,
    context: DisplayToolRenderContext<TState, Static<TParams>>,
  ) => Promise<DisplayDescriptionV1>;
  readonly callDescriptionKey?: (args: Static<TParams>) => string;
  readonly describeResult: (
    result: AgentToolResult<TDetails>,
    options: ToolRenderResultOptions,
    context: DisplayToolRenderContext<TState, Static<TParams>>,
  ) => DisplayDescriptionV1;
}

export interface ToolDisplayState {
  displayStartedAt?: number;
  displayEndedAt?: number;
  displayMotionUnsubscribe?: () => void;
  displayMotionComponent?: OperationalDisplayComponent;
  displayPhase?: "call" | "result";
  displayAsyncCallKey?: string;
  displayAsyncCallGeneration?: number;
  displayAsyncCallPending?: boolean;
  displayAsyncCallDescription?: DisplayDescriptionV1;
}

class CallDisplaySlot implements Component {
  constructor(
    private component: OperationalDisplayComponent,
    private state: ToolDisplayState,
  ) {}

  update(component: OperationalDisplayComponent, state: ToolDisplayState): void {
    this.component = component;
    this.state = state;
  }

  operationalComponent(): OperationalDisplayComponent {
    return this.component;
  }

  render(width: number): string[] {
    return this.state.displayPhase === "result" ? [] : this.component.render(width);
  }

  invalidate(): void {
    this.component.invalidate();
  }
}

function duration(state: ToolDisplayState, terminal: boolean): number | undefined {
  if (state.displayStartedAt === undefined) return undefined;
  if (terminal) state.displayEndedAt ??= Date.now();
  return (state.displayEndedAt ?? Date.now()) - state.displayStartedAt;
}

function applyRuntimeFields(
  description: DisplayDescriptionV1,
  state: ToolDisplayState,
  terminal: boolean,
  forceError: boolean,
  phase: "call" | "result",
): DisplayDescriptionV1 {
  // forceError (isError safety net) overrides completed/running to failed,
  // but preserves aborted so cancelled tools keep the × marker.
  const lifecycle: OperationalLifecycle = forceError && description.lifecycle !== "aborted"
    ? "failed"
    : description.lifecycle;
  return {
    ...description,
    phase: description.phase ?? phase,
    lifecycle,
    qualifiers: description.qualifiers ?? [],
    durationMs: description.durationMs ?? duration(state, terminal),
  };
}

function componentFor(
  runtime: DisplayRuntime,
  description: DisplayDescriptionV1,
  theme: Theme,
  lastComponent: Component | undefined,
  expanded: boolean,
): OperationalDisplayComponent {
  const component = isOperationalDisplayComponent(lastComponent)
    ? lastComponent
    : runtime.createComponent(description, theme, { expanded });
  runtime.updateComponent(component, description, theme, { expanded });
  return component;
}

function ensureMotion(
  runtime: DisplayRuntime,
  component: OperationalDisplayComponent,
  state: ToolDisplayState,
  context: DisplayToolRenderContext<ToolDisplayState, unknown>,
  active: boolean,
): void {
  if (active && state.displayMotionComponent !== component) {
    state.displayMotionUnsubscribe?.();
    state.displayMotionUnsubscribe = runtime.subscribeMotion(context.invalidate);
    state.displayMotionComponent = component;
  } else if (!active && state.displayMotionUnsubscribe) {
    state.displayMotionUnsubscribe();
    state.displayMotionUnsubscribe = undefined;
    state.displayMotionComponent = undefined;
  }
}

export function decorateToolDefinition<
  TParams extends TSchema,
  TDetails,
  TState,
>(
  definition: ToolDefinition<TParams, TDetails, TState>,
  runtimeProvider: DisplayRuntimeProvider,
  adapter: InternalToolDisplayAdapter<TParams, TDetails, TState>,
): ToolDefinition<TParams, TDetails, TState> {
  return {
    ...definition,
    renderShell: "self",
    renderCall(args, theme, context) {
      const runtime = resolveRuntime(runtimeProvider);
      const state = context.state as TState & ToolDisplayState;
      state.displayPhase = "call";
      if (context.executionStarted && state.displayStartedAt === undefined) state.displayStartedAt = Date.now();
      const asyncKey = adapter.describeCallAsync && context.argsComplete
        ? adapter.callDescriptionKey?.(args) ?? "complete"
        : undefined;
      if (asyncKey !== undefined && state.displayAsyncCallKey !== asyncKey) {
        state.displayAsyncCallKey = asyncKey;
        state.displayAsyncCallDescription = undefined;
        state.displayAsyncCallPending = false;
        state.displayAsyncCallGeneration = (state.displayAsyncCallGeneration ?? 0) + 1;
      }
      const raw = state.displayAsyncCallKey === asyncKey && state.displayAsyncCallDescription
        ? state.displayAsyncCallDescription
        : adapter.describeCall(args, context);
      const description = applyRuntimeFields(raw, state, false, false, "call");
      const displayContext = context as DisplayToolRenderContext<ToolDisplayState, unknown>;
      const previousSlot = context.lastComponent instanceof CallDisplaySlot ? context.lastComponent : undefined;
      const component = componentFor(
        runtime,
        description,
        theme,
        previousSlot?.operationalComponent(),
        context.expanded,
      );
      const slot = previousSlot ?? new CallDisplaySlot(component, state);
      slot.update(component, state);
      ensureMotion(
        runtime,
        component,
        state,
        displayContext,
        description.lifecycle === "running",
      );
      if (
        asyncKey !== undefined
        && adapter.describeCallAsync
        && state.displayAsyncCallDescription === undefined
        && !state.displayAsyncCallPending
        && state.displayAsyncCallGeneration !== undefined
      ) {
        const generation = state.displayAsyncCallGeneration;
        state.displayAsyncCallPending = true;
        void adapter.describeCallAsync(args, context).then((resolved) => {
          if (
            state.displayPhase !== "call"
            || state.displayAsyncCallGeneration !== generation
            || state.displayAsyncCallKey !== asyncKey
          ) return;
          state.displayAsyncCallPending = false;
          state.displayAsyncCallDescription = resolved;
          const next = applyRuntimeFields(resolved, state, false, false, "call");
          runtime.updateComponent(component, next, theme, { expanded: context.expanded });
          context.invalidate();
        }).catch(() => {
          if (state.displayAsyncCallGeneration === generation) state.displayAsyncCallPending = false;
          // Preview hydration is best effort and must never affect tool execution.
        });
      }
      return slot;
    },
    renderResult(result, options, theme, context) {
      const runtime = resolveRuntime(runtimeProvider);
      const state = context.state as TState & ToolDisplayState;
      state.displayPhase = "result";
      state.displayStartedAt ??= Date.now();
      const terminal = !options.isPartial || context.isError;
      const raw = adapter.describeResult(result, options, context);
      const description = applyRuntimeFields(raw, state, terminal, context.isError, "result");
      const displayContext = context as DisplayToolRenderContext<ToolDisplayState, unknown>;
      const component = componentFor(runtime, description, theme, context.lastComponent, options.expanded);
      state.displayAsyncCallDescription = undefined;
      state.displayAsyncCallPending = false;
      ensureMotion(
        runtime,
        component,
        state,
        displayContext,
        !terminal && description.lifecycle === "running",
      );
      return component;
    },
  };
}
