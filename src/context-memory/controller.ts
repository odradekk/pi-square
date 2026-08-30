import type { ContextMemoryConfig } from "../core/config";
import type { HostSupport } from "./host";
import { READ_MEMORY_SOURCE_TOOL_NAME, SUBMIT_MEMORY_TOOL_NAME } from "./tools";
import type { ContextMemorySnapshot } from "./view";

/**
 * The session-scoped Context Memory controller (odradekk/pi-square#215, #216).
 *
 * The controller is the highest test seam: tests drive it through the same
 * registrar events Pi drives and assert externally visible state — the
 * read-only snapshot, the active tool set, and tool behavior. Later slices
 * extend it with current-leaf derivation, format parsing, thresholds,
 * transactions, and compaction takeover; the shell owns only lifecycle,
 * the compatibility gate, baseline snapshot states, and keeping the two
 * owned tool names out of the active tool list.
 */

/** The only tool names this feature may add to or remove from the active list. */
export const OWNED_TOOL_NAMES: readonly string[] = Object.freeze([
  SUBMIT_MEMORY_TOOL_NAME,
  READ_MEMORY_SOURCE_TOOL_NAME,
]);

const OWNED_TOOL_NAME_SET: ReadonlySet<string> = new Set(OWNED_TOOL_NAMES);

export interface ContextMemoryControllerOptions {
  readonly config: ContextMemoryConfig;
  readonly support: HostSupport;
}

export class ContextMemoryController {
  private readonly config: ContextMemoryConfig;
  private readonly support: HostSupport;
  private current: ContextMemorySnapshot;

  constructor(options: ContextMemoryControllerOptions) {
    this.config = options.config;
    this.support = options.support;
    this.current = this.baselineSnapshot();
  }

  /** Read-only view snapshot; Prompt Manager renders it as `/context` `memory[]`. */
  get view(): ContextMemorySnapshot {
    return this.current;
  }

  get hostSupport(): HostSupport {
    return this.support;
  }

  get memoryConfig(): ContextMemoryConfig {
    return this.config;
  }

  /** The shell never opens a due run; #218 replaces this with real due tracking. */
  isDueRun(): boolean {
    return false;
  }

  /** The shell never derives Memory; #217 replaces this with compaction parsing. */
  hasMemory(): boolean {
    return false;
  }

  /**
   * Synchronize the owned active-tool names while preserving every other
   * active tool selected by Pi or another pi-square module. In the baseline
   * state both tools stay inactive: `submit_memory` needs a due run and
   * `read_memory_source` needs valid current Memory, neither of which the
   * shell produces. Returns the owned names removed from the active list.
   */
  synchronizeActiveTools(pi: Pick<ExtensionAPIForTools, "getActiveTools" | "setActiveTools">): readonly string[] {
    const active = pi.getActiveTools();
    const removed = active.filter((name) => OWNED_TOOL_NAME_SET.has(name));
    if (removed.length === 0) return [];
    pi.setActiveTools(active.filter((name) => !OWNED_TOOL_NAME_SET.has(name)));
    return removed;
  }

  private baselineSnapshot(): ContextMemorySnapshot {
    if (!this.config.enabled) return { state: "disabled" };
    if (!this.support.supported) return { state: "unsupported", reason: this.support.reason };
    // Enabled on a supported host with no Memory derived yet (#217 owns derivation).
    return { state: "no-memory" };
  }
}

/** The minimal Pi surface the active-tool synchronization consumes. */
export interface ExtensionAPIForTools {
  getActiveTools(): string[];
  setActiveTools(toolNames: string[]): void;
}
