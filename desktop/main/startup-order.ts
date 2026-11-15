/**
 * START-1 startup order: show the blank native window first, run the GUI
 * environment probe behind it, and report a quit that began while the probe
 * was pending so the caller never starts the app.
 *
 * Pure orchestration — the window and the probe are injected, so the ordering
 * and the quit race are testable without Electron.
 */

export interface ProbeBehindWindowDeps<E> {
  /** Show the blank native window (no backend URL yet). Runs before the probe. */
  showWindow: () => void;
  /** The GUI environment probe; resolves to a fallback environment on failure. */
  resolveEnvironment: () => Promise<E>;
  /** True once a quit flow has begun; checked after the probe resolves. */
  quitStarted: () => boolean;
}

export type ProbeBehindWindowResult<E> = { ok: true; environment: E } | { ok: false };

export async function probeBehindWindow<E>(
  deps: ProbeBehindWindowDeps<E>,
): Promise<ProbeBehindWindowResult<E>> {
  deps.showWindow();
  const environment = await deps.resolveEnvironment();
  if (deps.quitStarted()) return { ok: false };
  return { ok: true, environment };
}
