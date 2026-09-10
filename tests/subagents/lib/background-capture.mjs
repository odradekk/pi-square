/**
 * Test-only alias target for loading `src/subagents/index.ts` with the
 * background module captured: re-exports the real module while recording every
 * state it creates, so focused tests can observe session-scoped teardown (the
 * live view feed) without any test seam in production code. The recorded list
 * is bounded by the tests themselves and resettable.
 */
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

import jiti from "jiti";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolvePath(here, "..", "..", "..");
// Synchronous jiti call: this file is also an alias target for jiti's CJS
// transform, where top-level await is unavailable.
const load = jiti(import.meta.url, { moduleCache: false });
const real = load(join(packageRoot, "src", "subagents", "background.ts"));

const captured = [];

export const __resetCapturedStates = () => { captured.length = 0; };
export const __capturedStates = () => [...captured];

export function createBackgroundState(...args) {
  const state = real.createBackgroundState(...args);
  captured.push(state);
  return state;
}

// Re-export the real module's members (functions keep their identity); only
// createBackgroundState is wrapped for capture.
export const abortAllBackgroundJobs = real.abortAllBackgroundJobs;
export const cancelBackgroundJobs = real.cancelBackgroundJobs;
export const createQueuedJob = real.createQueuedJob;
export const createQueuedResumeJob = real.createQueuedResumeJob;
export const ensureDeliveryController = real.ensureDeliveryController;
export const listBackgroundJobs = real.listBackgroundJobs;
export const notifyBackgroundChange = real.notifyBackgroundChange;
export const replaceBackgroundViewFeed = real.replaceBackgroundViewFeed;
export const startBackgroundJob = real.startBackgroundJob;
export const startBackgroundResumeJob = real.startBackgroundResumeJob;
export const subscribeBackgroundState = real.subscribeBackgroundState;
