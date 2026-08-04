import {
  MOTION_FULL_FPS,
  MOTION_REDUCED_FPS,
  type DisplayMotion,
} from "./types";

export interface MotionClock {
  readonly setInterval: (callback: () => void, milliseconds: number) => unknown;
  readonly clearInterval: (handle: unknown) => void;
  readonly unref?: (handle: unknown) => void;
}

const SYSTEM_CLOCK: MotionClock = {
  setInterval: (callback, milliseconds) => setInterval(callback, milliseconds),
  clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
  unref: (handle) => (handle as NodeJS.Timeout).unref?.(),
};

export interface MotionEnvironment {
  readonly isTTY?: boolean;
  readonly term?: string;
  readonly ci?: boolean;
  readonly test?: boolean;
}

export function effectiveMotion(
  configured: DisplayMotion,
  environment: MotionEnvironment = {},
): DisplayMotion {
  if (configured === "off") return "off";
  if (environment.test || environment.ci || environment.isTTY === false || environment.term === "dumb") return "off";
  return configured;
}

export class MotionScheduler {
  private readonly subscribers = new Set<() => void>();
  private handle: unknown;
  private motion: DisplayMotion;

  constructor(
    motion: DisplayMotion,
    private readonly clock: MotionClock = SYSTEM_CLOCK,
  ) {
    this.motion = motion;
  }

  get mode(): DisplayMotion {
    return this.motion;
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  setMode(motion: DisplayMotion): void {
    if (motion === this.motion) return;
    this.motion = motion;
    this.restart();
  }

  subscribe(callback: () => void): () => void {
    this.subscribers.add(callback);
    this.ensureTimer();
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.subscribers.delete(callback);
      if (this.subscribers.size === 0) this.stopTimer();
    };
  }

  dispose(): void {
    this.subscribers.clear();
    this.stopTimer();
  }

  private intervalMs(): number | undefined {
    if (this.motion === "off") return undefined;
    return Math.floor(1_000 / (this.motion === "full" ? MOTION_FULL_FPS : MOTION_REDUCED_FPS));
  }

  private ensureTimer(): void {
    if (this.handle !== undefined || this.subscribers.size === 0) return;
    const interval = this.intervalMs();
    if (interval === undefined) return;
    this.handle = this.clock.setInterval(() => {
      for (const subscriber of [...this.subscribers]) {
        try {
          subscriber();
        } catch {
          this.subscribers.delete(subscriber);
        }
      }
      if (this.subscribers.size === 0) this.stopTimer();
    }, interval);
    this.clock.unref?.(this.handle);
  }

  private stopTimer(): void {
    if (this.handle === undefined) return;
    this.clock.clearInterval(this.handle);
    this.handle = undefined;
  }

  private restart(): void {
    this.stopTimer();
    this.ensureTimer();
  }
}

export function processMotionEnvironment(env: NodeJS.ProcessEnv = process.env): MotionEnvironment {
  return {
    isTTY: Boolean(process.stdout.isTTY),
    term: env.TERM,
    ci: env.CI === "true" || env.CI === "1",
    test: env.NODE_ENV === "test" || env.PI_SQUARE_TEST === "1",
  };
}
