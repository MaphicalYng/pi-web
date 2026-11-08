/**
 * Composition of the shell: it decides development vs production start, loads
 * the window only after cookie + first-page readiness, routes backend failures
 * to one native recovery dialog, exposes the fixed menu actions, and owns the
 * cleanup that the quit coordinator runs.
 *
 * Electron is injected; this module has no Electron import and no business SDK.
 */
import type { ActivitySnapshot } from "./activity";
import type { BackendFailure, BackendReady } from "./backend-supervisor";
import type { DevSurface } from "./development-server";
import type { PageProbeResult } from "./http-probes";
import type { QuitOutcome, QuitRequest } from "./quit-coordinator";
import type { LogFn } from "./backend-supervisor";
import type { QuitSurface } from "./quit-coordinator";

export type ControllerMode = "development" | "production";

export interface BackendControl {
  start(): Promise<BackendReady>;
  restart(): Promise<BackendReady>;
  stop(): Promise<void>;
  snapshot(): { phase: string; origin: string | null };
}

export interface DevelopmentControl {
  readonly url: string;
  ensureStarted(): Promise<DevSurface>;
  stop(): Promise<void>;
  killAllNow(): void;
  snapshot(): { surface: DevSurface | "idle"; owned: boolean; origin: string | null };
}

export interface WindowControl {
  readonly currentOrigin: string | null;
  readonly windowCount: number;
  loadBackend(origin: string, session: string | null): Promise<PageProbeResult>;
  loadOrigin(origin: string): Promise<void>;
  clearCookie(origin?: string | null): Promise<void>;
  ensureMainWindow(): void;
  focusMainWindow(): boolean;
  reload(): boolean;
  destroyAll(): void;
  showFatalDialog(failure: BackendFailure): Promise<"retry" | "logs" | "quit" | null>;
}

export interface QuitControl {
  requestQuit(request: QuitRequest): Promise<QuitOutcome>;
  readonly isApproved: boolean;
  readonly snapshot?: () => unknown;
}

export interface AppControllerOptions {
  mode: ControllerMode;
  log: LogFn;
  windows: WindowControl;
  supervisor?: BackendControl | null;
  development?: DevelopmentControl | null;
  readActivity: () => Promise<ActivitySnapshot>;
  quit: QuitControl;
  openLogs: () => Promise<boolean>;
}

export class AppController {
  private readonly options: AppControllerOptions;
  private started = false;
  private starting: Promise<boolean> | null = null;
  private retrying = false;
  private failureFlow = false;
  private origin: string | null = null;

  constructor(options: AppControllerOptions) {
    this.options = options;
  }

  get isQuitApproved(): boolean {
    return this.options.quit.isApproved;
  }

  get lastFailure(): BackendFailure | null {
    return this.currentFailure;
  }

  private currentFailure: BackendFailure | null = null;

  /** Startup is idempotent: concurrent callers share one attempt. */
  start(): Promise<boolean> {
    if (this.starting) return this.starting;
    if (this.started) return Promise.resolve(true);
    this.starting = this.startOnce().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async startOnce(): Promise<boolean> {
    if (this.options.mode === "development") return this.startDevelopment();
    return this.startProduction();
  }

  private async startDevelopment(): Promise<boolean> {
    const development = this.requireDevelopment();
    try {
      await development.ensureStarted();
      const probe = await this.options.windows.loadBackend(development.url, null);
      if (!probe.ok) {
        await development.stop();
        await this.reportFailure({
          reason: `The development page did not become usable (${probe.failure ?? "unknown"}).`,
          code: null,
          exitCode: null,
          signal: null,
        });
        return false;
      }
      this.origin = development.url;
      this.started = true;
      this.options.log("info", "app.started", { mode: "development", surface: development.snapshot().surface });
      return true;
    } catch (error) {
      await this.reportFailure({
        reason: errorText(error),
        code: null,
        exitCode: null,
        signal: null,
      });
      return false;
    }
  }

  private async startProduction(): Promise<boolean> {
    const supervisor = this.requireSupervisor();
    try {
      const ready = await supervisor.start();
      const probe = await this.options.windows.loadBackend(ready.origin, ready.session);
      if (!probe.ok) {
        await supervisor.stop();
        await this.options.windows.clearCookie(ready.origin);
        await this.reportFailure({
          reason: `The backend page did not become usable (${probe.failure ?? "unknown"}).`,
          code: null,
          exitCode: null,
          signal: null,
        });
        return false;
      }
      this.origin = ready.origin;
      this.started = true;
      this.options.log("info", "app.started", { mode: "production" });
      return true;
    } catch (error) {
      await this.reportFailure({
        reason: errorText(error),
        code: null,
        exitCode: null,
        signal: null,
      });
      return false;
    }
  }

  /**
   * One native failure flow. While the dialog is open additional failures are
   * ignored; "open logs" returns to the same dialog; "retry" fully stops the old
   * attempt and starts a new one; anything else quits without another prompt.
   */
  async reportFailure(failure: BackendFailure): Promise<void> {
    this.currentFailure = failure;
    if (this.failureFlow || this.options.quit.isApproved) return;
    this.failureFlow = true;
    try {
      for (;;) {
        const shown = this.currentFailure ?? failure;
        let choice = await this.options.windows.showFatalDialog(shown);
        while (choice === "logs") {
          await this.openLogs();
          choice = await this.options.windows.showFatalDialog(shown);
        }
        if (choice === "retry") {
          const recovered = await this.retryBackend();
          if (recovered || this.options.quit.isApproved) return;
          // The retry failed: show the same failure flow again with the new reason
          // instead of leaving the user with a blank window and no dialog.
          continue;
        }
        if (choice === null) return;
        await this.options.quit.requestQuit({ interactive: false, reason: "fatal" });
        return;
      }
    } finally {
      this.failureFlow = false;
    }
  }

  /** Manual recovery: stop the old attempt completely, invalidate its cookie, then start once. */
  async retryBackend(): Promise<boolean> {
    if (this.retrying || this.options.quit.isApproved) return false;
    this.retrying = true;
    this.options.log("info", "app.retry_requested", { mode: this.options.mode });
    try {
      this.started = false;
      await this.options.windows.clearCookie(this.origin ?? this.options.windows.currentOrigin);
      if (this.options.mode === "development") {
        const development = this.requireDevelopment();
        await development.stop();
        await development.ensureStarted();
        const probe = await this.options.windows.loadBackend(development.url, null);
        if (!probe.ok) throw new Error(`development page failed (${probe.failure ?? "unknown"})`);
        this.origin = development.url;
      } else {
        const supervisor = this.requireSupervisor();
        const ready = await supervisor.restart();
        const probe = await this.options.windows.loadBackend(ready.origin, ready.session);
        if (!probe.ok) throw new Error(`backend page failed (${probe.failure ?? "unknown"})`);
        this.origin = ready.origin;
      }
      this.started = true;
      this.options.log("info", "app.retry_succeeded", { mode: this.options.mode });
      return true;
    } catch (error) {
      this.options.log("error", "app.retry_failed", { reason: errorText(error) });
      await this.reportFailure({
        reason: errorText(error),
        code: null,
        exitCode: null,
        signal: null,
      });
      return false;
    } finally {
      this.retrying = false;
    }
  }

  /** Menu "Open Logs": only the fixed directory; the renderer cannot supply a path. */
  async openLogs(): Promise<boolean> {
    try {
      const opened = await this.options.openLogs();
      if (!opened) this.options.log("warn", "app.open_logs_failed");
      return opened;
    } catch (error) {
      this.options.log("warn", "app.open_logs_failed", { reason: errorText(error) });
      return false;
    }
  }

  reload(): boolean {
    const reloaded = this.options.windows.reload();
    if (!reloaded) this.options.log("warn", "app.reload_skipped");
    return reloaded;
  }

  /** `activate`: focus an existing window, or recreate one only when work is ready. */
  activate(): boolean {
    if (this.options.quit.isApproved) return false;
    if (this.options.windows.windowCount > 0) return this.options.windows.focusMainWindow();
    if (!this.started || !this.origin) return false;
    this.options.windows.ensureMainWindow();
    void this.options.windows
      .loadOrigin(this.origin)
      .catch((error: unknown) => this.options.log("warn", "app.activate_load_failed", { reason: errorText(error) }));
    return true;
  }

  /** Last main window close: prevent it until the quit coordinator approves. */
  handleLastWindowClose(event: { preventDefault(): void }): void {
    if (this.options.quit.isApproved) return;
    event.preventDefault();
    void this.options.quit.requestQuit({ interactive: true, reason: "window-close" });
  }

  requestQuit(request: QuitRequest): Promise<QuitOutcome> {
    return this.options.quit.requestQuit(request);
  }

  surface(): QuitSurface {
    if (this.options.mode === "production") return "production";
    const snapshot = this.options.development?.snapshot();
    return snapshot?.surface === "attached" ? "development-attached" : "development-owned";
  }

  readActivity(): Promise<ActivitySnapshot> {
    return this.options.readActivity();
  }

  /**
   * Fixed cleanup order: stop the owned backend/dev server, then remove the
   * production cookie, then destroy windows. Reused dev servers are untouched.
   */
  async cleanup(): Promise<void> {
    this.options.log("info", "app.cleanup_begin", { mode: this.options.mode });
    if (this.options.mode === "production") {
      try {
        await this.options.supervisor?.stop();
      } catch (error) {
        this.options.log("warn", "app.backend_stop_failed", { reason: errorText(error) });
      }
    } else {
      const development = this.options.development;
      if (development) {
        try {
          if (development.snapshot().owned) await development.stop();
        } catch (error) {
          this.options.log("warn", "app.dev_stop_failed", { reason: errorText(error) });
        } finally {
          development.killAllNow();
        }
      }
    }

    await this.options.windows.clearCookie(this.origin ?? undefined);
    this.options.windows.destroyAll();
    this.options.log("info", "app.cleanup_end");
  }

  private requireSupervisor(): BackendControl {
    if (!this.options.supervisor) throw new Error("production mode requires a backend supervisor");
    return this.options.supervisor;
  }

  private requireDevelopment(): DevelopmentControl {
    if (!this.options.development) throw new Error("development mode requires a development server");
    return this.options.development;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
