/**
 * Timer seams for the main process: production uses Node timers, tests pass
 * deterministic fakes so supervision and quit sequences can be asserted exactly.
 */
/** Opaque timer handle; only clearTimeout(handle) touches it. */
export type TimerToken = number | string | object;

export interface TimerLike {
  setTimeout(callback: () => void, ms: number): TimerToken;
  clearTimeout(handle: TimerToken): void;
}

export const nodeTimers: TimerLike = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
