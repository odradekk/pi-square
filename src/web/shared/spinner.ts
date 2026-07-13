import type { SpinnerState } from "../types";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL = 80;

export function currentSpinnerFrame(state: SpinnerState): string {
  return SPINNER_FRAMES[state.frame ?? 0] ?? SPINNER_FRAMES[0];
}

export function ensureSpinner(state: SpinnerState, invalidate: () => void): void {
  if (state.interval) return;
  state.frame = 0;
  state.interval = setInterval(() => {
    state.frame = (state.frame + 1) % SPINNER_FRAMES.length;
    invalidate();
  }, SPINNER_INTERVAL);
}

export function stopSpinner(state: SpinnerState): void {
  if (!state.interval) return;
  clearInterval(state.interval);
  state.interval = null;
}
