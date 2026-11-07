/**
 * Development backend ownership. A healthy `http://127.0.0.1:30141` is reused
 * untouched; only an absent port is filled by `npm run dev`. A port occupied by
 * something that is not Pi Web is a hard failure — never a second server on
 * another port, never a silent kill of something we did not start.
 */
import {
  DEV_HEALTH_POLL_INTERVAL_MS,
  DEV_ORIGIN,
  DEV_READY_TIMEOUT_MS,
  DEV_STOP_GRACE_MS,
} from "./constants";
import type { LogFn } from "./backend-supervisor";
import { nodeTimers, type TimerLike } from "../shared/timers";

export type DevSurface = "attached" | "spawned";

export interface DevelopmentProbe {
  reachable: boolean;
  isPiWeb: boolean;
}

export type DevelopmentClassification = "attached" | "absent" | "occupied";

export function classifyDevelopmentProbe(probe: DevelopmentProbe): DevelopmentClassification {
  if (!probe.reachable) return "absent";
  return probe.isPiWeb ? "attached" : "occupied";
}

export interface SpawnOptionsLike {
  cwd: string;
  env: Record<string, string>;
  shell: false;
  stdio: ["ignore", "pipe", "pipe"];
}

export interface DevelopmentSpawnSpec {
  command: "npm";
  args: readonly string[];
  options: SpawnOptionsLike;
}

/** The exact, shell-free `npm run dev` invocation the plan freezes. */
export function buildDevelopmentSpawn(cwd: string, env: Record<string, string>): DevelopmentSpawnSpec {
  if (typeof cwd !== "string" || cwd.length === 0) throw new Error("development cwd is required");
  return {
    command: "npm",
    args: ["run", "dev"],
    options: { cwd, env, shell: false, stdio: ["ignore", "pipe", "pipe"] },
  };
}

export interface DevChildLike {
  readonly pid?: number;
  readonly stdout?: { on(event: "data", listener: (chunk: unknown) => void): void } | null;
  readonly stderr?: { on(event: "data", listener: (chunk: unknown) => void): void } | null;
  kill(signal?: "SIGTERM" | "SIGKILL"): boolean | void;
  on(event: "exit", listener: (code: number | null, signal?: string) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
}

export class DevelopmentStartError extends Error {
  readonly code: "occupied" | "not-ready" | "spawn-failed";

  constructor(code: "occupied" | "not-ready" | "spawn-failed", message: string) {
    super(message);
    this.name = "DevelopmentStartError";
    this.code = code;
  }
}

export interface DevelopmentServerOptions {
  origin?: string;
  log: LogFn;
  probe: () => Promise<DevelopmentProbe>;
  spawn: (spec: DevelopmentSpawnSpec) => DevChildLike;
  cwd: string;
  environment: () => Record<string, string>;
  onOutput?: (stream: "stdout" | "stderr", text: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  timers?: TimerLike;
  healthTimeoutMs?: number;
  pollIntervalMs?: number;
  stopGraceMs?: number;
}

export interface DevelopmentSnapshot {
  surface: DevSurface | "idle";
  pid: number | null;
  owned: boolean;
  origin: string | null;
}

export class DevelopmentServer {
  private readonly options: DevelopmentServerOptions;
  private readonly origin: string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly timers: TimerLike;
  private readonly healthTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly stopGraceMs: number;

  private surface: DevSurface | "idle" = "idle";
  private child: DevChildLike | null = null;
  private stopChildren = new Set<DevChildLike>();

  constructor(options: DevelopmentServerOptions) {
    this.options = options;
    this.origin = options.origin ?? DEV_ORIGIN;
    this.timers = options.timers ?? nodeTimers;
    this.sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => this.timers.setTimeout(resolve, ms)));
    this.now = options.now ?? (() => Date.now());
    this.healthTimeoutMs = options.healthTimeoutMs ?? DEV_READY_TIMEOUT_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEV_HEALTH_POLL_INTERVAL_MS;
    this.stopGraceMs = options.stopGraceMs ?? DEV_STOP_GRACE_MS;
  }

  get url(): string {
    return this.origin;
  }

  snapshot(): DevelopmentSnapshot {
    return {
      surface: this.surface,
      pid: this.child?.pid ?? null,
      owned: this.surface === "spawned",
      origin: this.surface === "idle" ? null : this.origin,
    };
  }

  /**
   * Attach to a healthy Pi Web dev server, or start and wait for one. The
   * returned surface tells the quit coordinator whether shutdown stops it.
   */
  async ensureStarted(): Promise<DevSurface> {
    if (this.surface !== "idle") return this.surface;

    const existing = await this.options.probe();
    const classification = classifyDevelopmentProbe(existing);
    if (classification === "attached") {
      this.surface = "attached";
      this.options.log("info", "dev.attached", { origin: this.origin });
      return "attached";
    }
    if (classification === "occupied") {
      throw new DevelopmentStartError(
        "occupied",
        `The port at ${this.origin} is in use by a server that is not Pi Web. Stop it or change the dev port.`,
      );
    }

    let child: DevChildLike;
    try {
      child = this.options.spawn(
        buildDevelopmentSpawn(this.options.cwd, this.options.environment()),
      );
    } catch (error) {
      throw new DevelopmentStartError("spawn-failed", errorText(error));
    }
    this.child = child;
    this.stopChildren.add(child);
    this.surface = "spawned";
    this.options.log("info", "dev.spawned", { pid: child.pid ?? null });
    this.forward(child.stdout, "stdout");
    this.forward(child.stderr, "stderr");
    child.on("error", (error) => {
      this.options.log("error", "dev.child_error", { reason: errorText(error) });
    });
    child.on("exit", (code, signal) => {
      this.stopChildren.delete(child);
      this.options.log("info", "dev.exit", { pid: child.pid ?? null, code, signal: signal ?? null });
      if (this.child === child) {
        this.child = null;
        if (this.surface === "spawned") this.surface = "idle";
      }
    });

    if (!(await this.waitForHealthy())) {
      await this.stop();
      throw new DevelopmentStartError(
        "not-ready",
        `The development server did not become ready within ${this.healthTimeoutMs}ms.`,
      );
    }
    return "spawned";
  }

  /** Stops only a server this controller spawned; a reused 30141 is left running. */
  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.surface = "idle";
    if (!child) return;
    this.stopChildren.delete(child);
    const exited = this.waitForExit(child);
    try {
      child.kill("SIGTERM");
    } catch (error) {
      this.options.log("warn", "dev.kill_failed", { reason: errorText(error) });
      return;
    }
    if (await exited) {
      this.options.log("info", "dev.stopped", { pid: child.pid ?? null });
      return;
    }
    this.options.log("warn", "dev.stop_timeout", { graceMs: this.stopGraceMs });
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }

  /** SIGKILL fallback for every child still owned at forced shutdown. */
  killAllNow(): void {
    for (const child of this.stopChildren) {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    }
    this.stopChildren.clear();
  }

  private forward(
    stream: { on(event: "data", listener: (chunk: unknown) => void): void } | null | undefined,
    name: "stdout" | "stderr",
  ): void {
    if (!stream || typeof stream.on !== "function") return;
    stream.on("data", (chunk: unknown) => {
      try {
        this.options.onOutput?.(name, typeof chunk === "string" ? chunk : String(chunk));
      } catch {
        // Logging must never take the shell down.
      }
    });
  }

  private async waitForHealthy(): Promise<boolean> {
    const deadline = this.now() + this.healthTimeoutMs;
    for (;;) {
      const probe = await this.options.probe();
      if (probe.reachable && probe.isPiWeb) {
        this.options.log("info", "dev.ready", { origin: this.origin });
        return true;
      }
      if (this.now() >= deadline) return false;
      await this.sleep(this.pollIntervalMs);
      if (this.now() >= deadline) return false;
    }
  }

  private waitForExit(child: DevChildLike): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (exited: boolean): void => {
        if (settled) return;
        settled = true;
        this.timers.clearTimeout(timer);
        resolve(exited);
      };
      const timer = this.timers.setTimeout(() => finish(false), this.stopGraceMs);
      child.on("exit", () => finish(true));
    });
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
