/**
 * Startup timing marks (MEASURE-1). Opt-in through `PI_WEB_PERF=1`: without it
 * the marker records nothing and never emits, so a default launch pays only a
 * boolean check per phase. Each mark is `performance.now()` at the phase (ms
 * since process start); the emitted report is one structured log line after the
 * first page finishes loading. Never includes origins, paths or secrets — only
 * phase names and numbers.
 */

export const STARTUP_MARK_NAMES = [
  "app-ready",
  "window-created",
  "env-resolved",
  "backend-ready",
  "cookie-set",
  "first-load-finished",
] as const;

export type StartupMarkName = (typeof STARTUP_MARK_NAMES)[number];

export type StartupMarks = Partial<Record<StartupMarkName, number>>;

/** `PI_WEB_PERF=1` enables startup (and server) perf logging. */
export function startupPerfEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.PI_WEB_PERF === "1";
}

export interface StartupMarker {
  mark(name: StartupMarkName): void;
}

/**
 * One-shot marker: the first `mark(name)` wins (retries do not rewrite a
 * phase), and exactly one `emit` fires after `first-load-finished` carrying
 * whatever phases happened — development mode never sets the cookie, so its
 * report legitimately has five marks.
 */
export function createStartupMarker(options: {
  enabled: boolean;
  now?: () => number;
  emit: (marks: StartupMarks) => void;
}): StartupMarker {
  const now = options.now ?? (() => performance.now());
  const marks: StartupMarks = {};
  return {
    mark(name: StartupMarkName): void {
      if (!options.enabled) return;
      if (marks[name] !== undefined) return;
      marks[name] = Math.round(now() * 10) / 10;
      if (name === "first-load-finished") {
        options.emit({ ...marks });
      }
    },
  };
}
