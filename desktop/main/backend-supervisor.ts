/**
 * Production backend supervision against the frozen wire contract in
 * `desktop/shared/backend-protocol.ts`.
 *
 * One `start()` is one attempt: a fresh 32-byte secret, one utilityProcess, one
 * `ready` deadline. An attempt that fails — bad origin, timeout, early exit,
 * `fatal`, or an unexpected exit while running — ends in `failed`; there is no
 * automatic restart and no restart loop. Recovery is a user action through
 * `restart()`, which fully stops the old attempt first. Late messages from an
 * old attempt are ignored by attempt id.
 */
import {
  BACKEND_KILL_GRACE_MS,
  BACKEND_READY_TIMEOUT_MS,
  BACKEND_SHUTDOWN_TIMEOUT_MS,
  BACKEND_STOPPED_EXIT_GRACE_MS,
  FATAL_TEXT_MAX_CHARS,
} from "./constants";
import {
  createSessionHandoff,
  createShutdownMessage,
  generateSessionSecret,
  isSessionSecret,
  parseBackendMessage,
} from "../shared/backend-protocol";
import { parseLoopbackOrigin } from "../shared/urls";
import { nodeTimers, type TimerLike, type TimerToken } from "../shared/timers";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFn = (level: LogLevel, event: string, fields?: Record<string, unknown>) => void;

export type BackendPhase = "idle" | "starting" | "ready" | "stopping" | "stopped" | "failed";

export interface UtilityChildLike {
  readonly pid?: number;
  postMessage(message: unknown): void;
  kill(): void;
  on(event: "exit", listener: (code: number | null, signal?: string) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  on(event: "message", listener: (message: unknown) => void): void;
  readonly stdout?: OutputStreamLike | null;
  readonly stderr?: OutputStreamLike | null;
}

export interface OutputStreamLike {
  on(event: "data", listener: (chunk: unknown) => void): void;
}

export interface SpawnUtilityOptions {
  entry: string;
  serviceName: string;
  env: Record<string, string>;
}

export interface BackendReady {
  origin: string;
  /** The per-attempt secret the window's host-only cookie must carry. */
  session: string;
}

export interface BackendFailure {
  reason: string;
  code: string | null;
  exitCode: number | null;
  signal: string | null;
}

export interface BackendSnapshot {
  attempt: number;
  phase: BackendPhase;
  pid: number | null;
  origin: string | null;
  startedAt: number | null;
  failure: BackendFailure | null;
}

export interface BackendSupervisorOptions {
  entry: string;
  serviceName: string;
  spawnUtility: (options: SpawnUtilityOptions) => UtilityChildLike;
  /** Assembled fresh per attempt; desktop host variables are added by the caller. */
  environment: () => Record<string, string>;
  log: LogFn;
  onSecret?: (secret: string) => void;
  onFailed?: (failure: BackendFailure) => void;
  /** Redacted, bounded stdout/stderr chunks from the utility process. */
  onOutput?: (stream: "stdout" | "stderr", text: string) => void;
  timers?: TimerLike;
  now?: () => number;
  sessionFactory?: () => string;
  readyTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  stoppedExitGraceMs?: number;
  killGraceMs?: number;
}

interface Attempt {
  id: number;
  child: UtilityChildLike;
  secret: string;
  startedAt: number;
  readyTimer: TimerToken | null;
}

export class BackendSupervisor {
  private readonly timers: TimerLike;
  private readonly now: () => number;
  private readonly sessionFactory: () => string;
  private readonly readyTimeoutMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly stoppedExitGraceMs: number;
  private readonly killGraceMs: number;

  private phase: BackendPhase = "idle";
  private attemptId = 0;
  private attempt: Attempt | null = null;
  private origin: string | null = null;
  private failure: BackendFailure | null = null;
  private startWaiter: {
    resolve: (ready: BackendReady) => void;
    reject: (error: Error) => void;
    attemptId: number;
  } | null = null;
  private startPromise: Promise<BackendReady> | null = null;
  private stopPromise: Promise<void> | null = null;
  private restartPromise: Promise<BackendReady> | null = null;
  private stoppedSignal = false;
  private exitedSignal = false;
  private signalWaiters: Array<{ signal: "stopped" | "exit"; settle: (reached: boolean) => void }> = [];

  private readonly options: BackendSupervisorOptions;

  constructor(options: BackendSupervisorOptions) {
    this.options = options;
    this.timers = options.timers ?? nodeTimers;
    this.now = options.now ?? (() => Date.now());
    this.sessionFactory = options.sessionFactory ?? generateSessionSecret;
    this.readyTimeoutMs = options.readyTimeoutMs ?? BACKEND_READY_TIMEOUT_MS;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? BACKEND_SHUTDOWN_TIMEOUT_MS;
    this.stoppedExitGraceMs = options.stoppedExitGraceMs ?? BACKEND_STOPPED_EXIT_GRACE_MS;
    this.killGraceMs = options.killGraceMs ?? BACKEND_KILL_GRACE_MS;
  }

  snapshot(): BackendSnapshot {
    return {
      attempt: this.attemptId,
      phase: this.phase,
      pid: this.attempt?.child.pid ?? null,
      origin: this.origin,
      startedAt: this.attempt?.startedAt ?? null,
      failure: this.failure,
    };
  }

  /** Starts the one attempt. Rejects if it ends in `failed`; never retries by itself. */
  start(): Promise<BackendReady> {
    if (this.startPromise) return this.startPromise;
    if (this.phase === "ready") {
      return Promise.resolve({ origin: this.origin ?? "", session: this.attempt?.secret ?? "" });
    }
    if (this.phase === "starting") {
      return new Promise<BackendReady>((resolve, reject) => {
        this.startWaiter = { resolve, reject, attemptId: this.attemptId };
      });
    }
    if (this.phase === "stopping" || this.phase === "stopped") {
      return Promise.reject(new Error("backend supervisor is stopped"));
    }
    this.startPromise = this.spawnAttempt();
    return this.startPromise;
  }

  /** Full manual retry: stop the old attempt, invalidate its origin and start a new one. */
  restart(): Promise<BackendReady> {
    if (this.restartPromise) return this.restartPromise;
    this.restartPromise = (async () => {
      await this.stop();
      this.stopPromise = null;
      this.startPromise = null;
      this.phase = "idle";
      this.attempt = null;
      this.origin = null;
      this.failure = null;
      return this.start();
    })().finally(() => {
      this.restartPromise = null;
    });
    return this.restartPromise;
  }

  /** Idempotent, bounded stop. Every call shares one promise and one shutdown message. */
  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.performStop();
    return this.stopPromise;
  }

  private async spawnAttempt(): Promise<BackendReady> {
    const attemptId = ++this.attemptId;
    this.phase = "starting";
    this.failure = null;
    this.origin = null;
    this.stoppedSignal = false;
    this.exitedSignal = false;

    let secret: string;
    try {
      secret = this.sessionFactory();
      if (!isSessionSecret(secret)) throw new Error("session factory returned an invalid secret");
    } catch (error) {
      return this.failNow(attemptId, planReason(error, "session secret generation failed"), null, null, null);
    }
    this.options.onSecret?.(secret);

    let child: UtilityChildLike;
    try {
      child = this.options.spawnUtility({
        entry: this.options.entry,
        serviceName: this.options.serviceName,
        env: this.options.environment(),
      });
    } catch (error) {
      return this.failNow(attemptId, planReason(error, "utility process could not start"), null, null, null);
    }

    const attempt: Attempt = { id: attemptId, child, secret, startedAt: this.now(), readyTimer: null };
    this.attempt = attempt;
    this.options.log("info", "backend.spawned", { attempt: attemptId, pid: child.pid ?? null });

    child.on("message", (message) => this.handleMessage(attempt, message));
    child.on("exit", (code, signal) => this.handleExit(attempt, code, signal));
    child.on("error", (error) => {
      this.options.log("error", "backend.child_error", {
        attempt: attemptId,
        reason: truncate(error.message, FATAL_TEXT_MAX_CHARS),
      });
    });
    this.forwardOutput(child.stdout, "stdout", attemptId);
    this.forwardOutput(child.stderr, "stderr", attemptId);

    return new Promise<BackendReady>((resolve, reject) => {
      this.startWaiter = { resolve, reject, attemptId };
      attempt.readyTimer = this.timers.setTimeout(() => {
        if (this.attempt?.id !== attemptId || this.phase !== "starting") return;
        void this.failAttempt(attempt, {
          reason: `backend did not report ready within ${this.readyTimeoutMs} ms`,
          code: null,
          exitCode: null,
          signal: null,
        });
      }, this.readyTimeoutMs);

      try {
        child.postMessage(createSessionHandoff(secret));
      } catch (error) {
        void this.failAttempt(attempt, {
          reason: planReason(error, "backend session handoff failed"),
          code: null,
          exitCode: null,
          signal: null,
        });
      }
    });
  }

  private handleMessage(attempt: Attempt, message: unknown): void {
    if (this.attempt?.id !== attempt.id) {
      this.options.log("debug", "backend.stale_message_ignored", { attempt: attempt.id });
      return;
    }
    const parsed = parseBackendMessage(message);
    if (!parsed) {
      this.options.log("warn", "backend.message_ignored", { attempt: attempt.id, kind: messageKind(message) });
      return;
    }
    if (parsed.type === "ready") {
      if (this.phase !== "starting") {
        this.options.log("warn", "backend.duplicate_ready_ignored", { attempt: attempt.id });
        return;
      }
      const origin = parseLoopbackOrigin(parsed.origin);
      if (origin === null) {
        void this.failAttempt(attempt, {
          reason: "backend reported an invalid loopback origin",
          code: null,
          exitCode: null,
          signal: null,
        });
        return;
      }
      this.clearReadyTimer(attempt);
      this.origin = origin;
      this.phase = "ready";
      this.options.log("info", "backend.ready", { attempt: attempt.id, pid: attempt.child.pid ?? null, origin });
      const ready: BackendReady = { origin, session: attempt.secret };
      const waiter = this.startWaiter;
      this.startWaiter = null;
      this.startPromise = Promise.resolve(ready);
      if (waiter?.attemptId === attempt.id) waiter.resolve(ready);
      return;
    }
    if (parsed.type === "fatal") {
      const reason = truncate(parsed.message, FATAL_TEXT_MAX_CHARS);
      void this.failAttempt(attempt, {
        reason: reason.length > 0 ? reason : `backend fatal ${parsed.code}`,
        code: truncate(parsed.code, 128),
        exitCode: null,
        signal: null,
      });
      return;
    }
    this.stoppedSignal = true;
    this.options.log("info", "backend.stopped_signal", { attempt: attempt.id, code: parsed.code });
    this.notify("stopped");
  }

  private handleExit(attempt: Attempt, code: number | null, signal?: string): void {
    if (this.attempt?.id !== attempt.id) {
      this.options.log("debug", "backend.stale_exit_ignored", { attempt: attempt.id, code });
      return;
    }
    this.exitedSignal = true;
    this.notify("exit");

    if (this.phase === "stopping") {
      this.options.log("info", "backend.exited", { attempt: attempt.id, code, signal: signal ?? null, expected: true });
      return;
    }
    if (this.phase === "failed") return;

    this.clearReadyTimer(attempt);
    void this.failAttempt(attempt, {
      reason: `backend exited unexpectedly (code ${code === null ? "null" : code}${signal ? `, signal ${signal}` : ""})`,
      code: null,
      exitCode: code,
      signal: signal ?? null,
    });
  }

  private async failAttempt(attempt: Attempt, failure: BackendFailure): Promise<void> {
    if (this.attempt?.id !== attempt.id && this.phase === "failed") {
      return;
    }
    this.clearReadyTimer(attempt);
    try {
      attempt.child.kill();
    } catch {
      // Already gone; the exit handler is the only source of truth for exit.
    }
    if (this.attempt?.id === attempt.id) {
      this.attempt = null;
      this.phase = "failed";
      this.origin = null;
      this.failure = failure;
      this.options.log("error", "backend.failed", {
        attempt: attempt.id,
        reason: truncate(failure.reason, FATAL_TEXT_MAX_CHARS),
        code: failure.code,
        exitCode: failure.exitCode,
        signal: failure.signal,
      });
      const waiter = this.startWaiter;
      this.startWaiter = null;
      this.startPromise = null;
      waiter?.reject(new Error(failure.reason));
      this.options.onFailed?.(failure);
    }
  }

  private failNow(
    attemptId: number,
    reason: string,
    code: string | null,
    exitCode: number | null,
    signal: string | null,
  ): never {
    this.failure = { reason, code, exitCode, signal };
    this.attempt = null;
    this.phase = "failed";
    this.options.log("error", "backend.failed", { attempt: attemptId, reason: truncate(reason, FATAL_TEXT_MAX_CHARS) });
    this.startPromise = null;
    const waiter = this.startWaiter;
    this.startWaiter = null;
    waiter?.reject(new Error(reason));
    this.options.onFailed?.(this.failure);
    throw new Error(reason);
  }

  private async performStop(): Promise<void> {
    if (this.phase === "stopped") return;
    const attempt = this.attempt;
    this.clearReadyTimer(attempt);
    this.phase = attempt ? "stopping" : "stopped";
    const waiter = this.startWaiter;
    this.startWaiter = null;
    waiter?.reject(new Error("backend stopped before it was ready"));

    if (!attempt) {
      this.origin = null;
      this.attempt = null;
      return;
    }

    this.options.log("info", "backend.shutdown_requested", { attempt: attempt.id });
    try {
      attempt.child.postMessage(createShutdownMessage(this.shutdownTimeoutMs));
    } catch (error) {
      this.options.log("warn", "backend.shutdown_post_failed", { attempt: attempt.id, reason: planReason(error, "post failed") });
    }

    // `stopped` is an acknowledgement, not an exit: both are awaited, in order,
    // with fixed deadlines, before and after the hard kill.
    const acknowledged = this.stoppedSignal || (await this.waitFor("stopped", this.shutdownTimeoutMs));
    if (!acknowledged) {
      this.options.log("warn", "backend.stopped_missing", { attempt: attempt.id });
    } else {
      this.options.log("info", "backend.stopped_ack", { attempt: attempt.id });
    }

    if (!this.exitedSignal && !(await this.waitFor("exit", this.stoppedExitGraceMs))) {
      this.options.log("warn", "backend.kill_after_shutdown", { attempt: attempt.id, graceMs: this.stoppedExitGraceMs });
      try {
        attempt.child.kill();
      } catch {
        // Already gone.
      }
      if (!this.exitedSignal && !(await this.waitFor("exit", this.killGraceMs))) {
        this.options.log("error", "backend.exit_unconfirmed", { attempt: attempt.id, graceMs: this.killGraceMs });
      }
    }

    if (this.attempt?.id === attempt.id) this.attempt = null;
    this.origin = null;
    this.phase = "stopped";
    this.wakeSignalWaiters();
  }

  private forwardOutput(stream: OutputStreamLike | null | undefined, name: "stdout" | "stderr", attemptId: number): void {
    if (!stream || typeof stream.on !== "function") return;
    stream.on("data", (chunk: unknown) => {
      try {
        this.options.onOutput?.(name, typeof chunk === "string" ? chunk : String(chunk));
      } catch {
        // A logging failure must never take the shell down.
      }
      this.options.log("debug", "backend.output", { attempt: attemptId, stream: name, bytes: chunkLength(chunk) });
    });
  }

  private clearReadyTimer(attempt: Attempt | null): void {
    if (!attempt || attempt.readyTimer === null) return;
    this.timers.clearTimeout(attempt.readyTimer);
    attempt.readyTimer = null;
  }

  private waitFor(signal: "stopped" | "exit", ms: number): Promise<boolean> {
    if (signal === "stopped" && this.stoppedSignal) return Promise.resolve(true);
    if (signal === "exit" && this.exitedSignal) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      let remove = (): void => undefined;
      const settle = (reached: boolean): void => {
        if (settled) return;
        settled = true;
        this.timers.clearTimeout(timer);
        remove();
        resolve(reached);
      };
      const waiter = { signal, settle };
      remove = () => {
        this.signalWaiters = this.signalWaiters.filter((entry) => entry !== waiter);
      };
      const timer = this.timers.setTimeout(() => settle(false), ms);
      this.signalWaiters.push(waiter);
    });
  }

  private notify(signal: "stopped" | "exit"): void {
    const matching = this.signalWaiters.filter((waiter) => waiter.signal === signal);
    this.signalWaiters = this.signalWaiters.filter((waiter) => waiter.signal !== signal);
    for (const waiter of matching) waiter.settle(true);
  }

  private wakeSignalWaiters(): void {
    const waiters = this.signalWaiters;
    this.signalWaiters = [];
    for (const waiter of waiters) waiter.settle(waiter.signal === "exit");
  }
}

function planReason(error: unknown, fallback: string): string {
  return truncate(error instanceof Error && error.message.length > 0 ? error.message : fallback, FATAL_TEXT_MAX_CHARS);
}

function truncate(text: string, maxChars: number): string {
  const value = typeof text === "string" ? text : String(text);
  return value.length <= maxChars ? value : `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

function messageKind(value: unknown): string {
  if (typeof value === "object" && value !== null && "type" in value) {
    const type = (value as { type?: unknown }).type;
    return typeof type === "string" ? type.slice(0, 32) : "?";
  }
  return "?";
}

function chunkLength(chunk: unknown): number {
  if (typeof chunk === "string") return chunk.length;
  if (chunk instanceof Uint8Array) return chunk.byteLength;
  return 0;
}
