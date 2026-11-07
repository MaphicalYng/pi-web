/**
 * The single quit state machine. The last window's close, Cmd+Q, the native
 * menu, backend failure and SIGINT/SIGTERM all enter here.
 *
 * Order is fixed: read activity (bounded) → maybe show one confirmation →
 * bounded cleanup (backend stop, owned dev stop, cookie removal, window
 * destruction) → approve quit. Re-entry shares the same promise, so at most one
 * cleanup and one shutdown can ever run. A hung backend cannot hold the app
 * forever: every wait has a deadline.
 */
import type { LogFn } from "./backend-supervisor";
import type { ActivitySnapshot } from "./activity";
import { nodeTimers, type TimerLike } from "../shared/timers";

export type QuitSurface = "production" | "development-attached" | "development-owned";

export type QuitReason = "window-close" | "app-quit" | "menu-quit" | "signal" | "fatal";

export type QuitPhase = "running" | "checking" | "stopping" | "approved";

export type QuitOutcome = "quit" | "cancelled";

export interface QuitRequest {
  /** Signals never prompt; the user already interrupted the process. */
  interactive: boolean;
  reason?: QuitReason;
}

export interface QuitCoordinatorOptions {
  /** Reads `/api/agent/running`; must be side-effect free and already bounded by its own timeout. */
  readActivity: () => Promise<ActivitySnapshot>;
  /** Modal, plain-text confirmation. Cancel must be the default button. */
  prompt: (activity: ActivitySnapshot, surface: QuitSurface) => Promise<"confirmed" | "cancelled">;
  surface: () => QuitSurface;
  /** Backend stop, owned dev shutdown, cookie removal, window destruction. */
  cleanup: () => Promise<void>;
  /** Called once cleanup finished or timed out; the entry point calls `app.quit()`. */
  quit: () => void;
  log: LogFn;
  timers?: TimerLike;
  activityTimeoutMs?: number;
  cleanupTimeoutMs?: number;
  onPhaseChange?: (phase: QuitPhase) => void;
}

export interface QuitSnapshot {
  phase: QuitPhase;
  approved: boolean;
}

export class QuitCoordinator {
  private readonly options: QuitCoordinatorOptions;
  private readonly timers: TimerLike;
  private readonly activityTimeoutMs: number;
  private readonly cleanupTimeoutMs: number;
  private phase: QuitPhase = "running";
  private approved = false;
  private quitPromise: Promise<QuitOutcome> | null = null;
  private preempted = false;
  private preemptWaiters: Array<() => void> = [];

  constructor(options: QuitCoordinatorOptions) {
    this.options = options;
    this.timers = options.timers ?? nodeTimers;
    this.activityTimeoutMs = options.activityTimeoutMs ?? 3_500;
    this.cleanupTimeoutMs = options.cleanupTimeoutMs ?? 75_000;
  }

  snapshot(): QuitSnapshot {
    return { phase: this.phase, approved: this.approved };
  }

  get isApproved(): boolean {
    return this.approved;
  }

  /**
   * `quit` means cleanup finished and `quit()` was called; `cancelled` means the
   * window must stay open. Concurrent calls share one flow and never prompt or
   * shut down twice.
   */
  requestQuit(request: QuitRequest): Promise<QuitOutcome> {
    if (this.approved) return Promise.resolve("quit");
    // SIGINT/SIGTERM (or a fatal backend failure) must never wait for a human:
    // preempt a confirmation dialog that is already open and continue with the
    // same bounded cleanup. The shared promise below keeps a single cleanup.
    if (!request.interactive) this.preempt(request.reason ?? "noninteractive");
    if (this.quitPromise) {
      this.options.log("debug", "quit.reentry_shared", { reason: request.reason ?? "unknown" });
      return this.quitPromise;
    }
    const run = this.performQuit(request).finally(() => {
      if (!this.approved) this.quitPromise = null;
    });
    this.quitPromise = run;
    return run;
  }

  /** Stops waiting for an interactive answer; cleanup still runs exactly once. */
  private preempt(reason: string): void {
    if (this.approved || this.preempted) return;
    // The flow may still be in its first microtask (phase "running") while the
    // activity read is already outstanding; an active promise is enough.
    if (!this.quitPromise) return;
    this.preempted = true;
    this.options.log("info", "quit.preempted", { reason, phase: this.phase });
    const waiters = this.preemptWaiters;
    this.preemptWaiters = [];
    for (const resolve of waiters) resolve();
  }

  private async performQuit(request: QuitRequest): Promise<QuitOutcome> {
    const reason = request.reason ?? "app-quit";
    this.setPhase("checking");
    this.options.log("info", "quit.requested", { reason, interactive: request.interactive });

    const activity = await this.readActivityBounded();
    const surface = this.options.surface();

    if (request.interactive) {
      const needsPrompt = activity.activity !== "idle" || activity.running > 0 || activity.subagentsActive > 0;
      if (needsPrompt) {
        const decision = await this.promptBounded(activity, surface);
        if (decision !== "confirmed") {
          this.options.log("info", "quit.cancelled", { reason, activity: activity.activity });
          this.setPhase("running");
          return "cancelled";
        }
        this.options.log("info", "quit.confirmed", { reason, activity: activity.activity });
      }
    } else {
      this.options.log("info", "quit.noninteractive", { reason, activity: activity.activity });
    }

    this.setPhase("stopping");
    const cleaned = await this.runCleanupBounded();
    if (!cleaned) {
      this.options.log("warn", "quit.cleanup_timeout", { timeoutMs: this.cleanupTimeoutMs });
    }

    this.approved = true;
    this.setPhase("approved");
    try {
      this.options.quit();
    } catch (error) {
      this.options.log("error", "quit.call_failed", { reason: errorText(error) });
    }
    return "quit";
  }

  /**
   * Races the modal prompt against a preemption signal. A confirmation that was
   * already answered wins; a signal switches the flow to the non-interactive
   * path (treated as confirmed) without waiting for the dialog to close.
   */
  private async promptBounded(
    activity: ActivitySnapshot,
    surface: QuitSurface,
  ): Promise<"confirmed" | "cancelled"> {
    // A signal that arrived during the activity read must not open a dialog at
    // all, so check before calling into the (modal) prompt.
    if (this.preempted) return "confirmed";
    let removeWaiter = (): void => undefined;
    const answer = this.options.prompt(activity, surface).then(
      (value) => value,
      (error: unknown) => {
        this.options.log("warn", "quit.prompt_failed", { reason: errorText(error) });
        return "cancelled" as const;
      },
    );
    const preempted = new Promise<"preempted">((resolve) => {
      removeWaiter = () => {
        this.preemptWaiters = this.preemptWaiters.filter((entry) => entry !== waiter);
      };
      const waiter = () => {
        removeWaiter();
        resolve("preempted");
      };
      this.preemptWaiters.push(waiter);
    });
    const decision = await Promise.race([answer, preempted]);
    if (decision === "preempted") {
      this.options.log("info", "quit.preempted_prompt");
      return "confirmed";
    }
    removeWaiter();
    return decision;
  }

  private async runCleanupBounded(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const settle = (value: boolean): void => {
        if (settled) return;
        settled = true;
        this.timers.clearTimeout(timer);
        resolve(value);
      };
      const timer = this.timers.setTimeout(() => settle(false), this.cleanupTimeoutMs);
      let cleanup: Promise<void>;
      try {
        cleanup = this.options.cleanup();
      } catch (error) {
        this.options.log("warn", "quit.cleanup_failed", { reason: errorText(error) });
        settle(true);
        return;
      }
      cleanup.then(
        () => settle(true),
        (error: unknown) => {
          this.options.log("warn", "quit.cleanup_failed", { reason: errorText(error) });
          settle(true);
        },
      );
    });
  }

  private async readActivityBounded(): Promise<ActivitySnapshot> {
    const unknown: ActivitySnapshot = {
      activity: "unknown",
      running: 0,
      subagentsActive: 0,
      awaitingInput: 0,
    };
    return new Promise<ActivitySnapshot>((resolve) => {
      let settled = false;
      const settle = (value: ActivitySnapshot): void => {
        if (settled) return;
        settled = true;
        this.timers.clearTimeout(timer);
        resolve(value);
      };
      const timer = this.timers.setTimeout(() => {
        this.options.log("warn", "quit.activity_timeout", { timeoutMs: this.activityTimeoutMs });
        settle(unknown);
      }, this.activityTimeoutMs);
      let reading: Promise<ActivitySnapshot>;
      try {
        reading = this.options.readActivity();
      } catch {
        settle(unknown);
        return;
      }
      reading.then(
        (snapshot) => settle(snapshot),
        () => settle(unknown),
      );
    });
  }

  private setPhase(phase: QuitPhase): void {
    if (this.phase === phase) return;
    this.phase = phase;
    this.options.onPhaseChange?.(phase);
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
