// The shutdown state machine. One promise serves duplicate shutdown messages,
// signals and fatal errors alike:
//
//   refuse new requests -> stop accepting -> shutdownAgentSessions()
//   -> releaseAllTerminals() -> close upgraded sockets -> close Next + HTTP
//   -> force-close whatever is left -> send stopped -> exit(code)
//
// Every step has a deadline; a step that fails or times out is logged (redacted)
// and the remaining steps still run, so one hung session cannot keep node-pty
// children, MCP servers or the listener alive.

import type { DesktopHttpServer } from "./next-server";
import type { Redactor } from "./redaction";
import type { MessageSender } from "./protocol";

export interface LifecycleOptions {
  readonly http: DesktopHttpServer;
  readonly redact: Redactor;
  readonly send: MessageSender;
  /** `process.exit`; injectable so tests observe the code without leaving. */
  readonly exit?: (code: number) => void;
  /** Fallback cleanup budget when the `shutdown` message carries none. */
  readonly timeoutMs?: number;
  /** Real sessions/terminals by default; tests inject fakes and never load the SDK. */
  readonly cleanup?: {
    shutdownAgentSessions: () => Promise<unknown>;
    releaseAllTerminals: () => Promise<unknown>;
  };
}

export interface Lifecycle {
  isShuttingDown(): boolean;
  /**
   * Idempotent: duplicate calls share the first run's promise. The first
   * call's `timeoutMs` (the shell's requested budget) wins for the whole run.
   */
  shutdown(reason: string, timeoutMs?: number): Promise<number>;
}

const DEFAULT_BUDGET_MS = 60_000;
const STEP_MIN_MS = 1_000;
const IPC_FLUSH_MS = 50;

/** One cleanup step's deadline: a quarter of the run's budget, never below 1 s. */
export function shutdownStepMs(budgetMs: number): number {
  const budget = Number.isFinite(budgetMs) && budgetMs > 0 ? Math.floor(budgetMs) : DEFAULT_BUDGET_MS;
  return Math.max(STEP_MIN_MS, Math.floor(budget / 4));
}

async function within<T>(work: Promise<T>, timeoutMs: number, label: string, log: (line: string) => void): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      expired = true;
      resolve(undefined);
    }, timeoutMs);
    (timer as { unref?: () => void }).unref?.();
  });
  try {
    const result = await Promise.race([work, timeout]);
    // A step that legitimately returns `undefined` (a promise of void) is not
    // a timeout: only the timer's own flag may report "exceeded".
    if (expired) log(`[desktop] ${label} exceeded ${timeoutMs} ms; continuing shutdown`);
    return result;
  } catch (error) {
    log(`[desktop] ${label} failed: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function createLifecycle(options: LifecycleOptions): Lifecycle {
  let shuttingDown = false;
  let promise: Promise<number> | null = null;
  const log = options.redact.log;
  const exit = options.exit ?? ((code: number) => process.exit(code));

  async function run(reason: string, requestedBudgetMs?: number): Promise<number> {
    shuttingDown = true;
    log(`[desktop] shutting down (${reason})`);
    const fallbackBudget = options.timeoutMs ?? DEFAULT_BUDGET_MS;
    const budget = requestedBudgetMs ?? fallbackBudget;
    const step = shutdownStepMs(budget);

    // Stop accepting immediately; `close()` also destroys still-open sockets
    // after its own timeout, which is what SSE and upgraded connections need.
    const closed = options.http.close(budget).catch((error: unknown) => {
      log(`[desktop] HTTP close failed: ${error instanceof Error ? error.message : String(error)}`);
    });

    // Real sessions: agents first (their shutdown disposes each MCP host), then
    // the terminal PTYs, then Next's upgraded sockets and render server.
    const sessions = options.cleanup
      ? options.cleanup.shutdownAgentSessions()
      : import("../../lib/rpc-manager").then((rpc) => rpc.shutdownAgentSessions());
    await within(sessions, step, "shutdownAgentSessions", log);
    const terminals = options.cleanup
      ? options.cleanup.releaseAllTerminals()
      : import("../../lib/terminal-manager").then((terminalsModule) => terminalsModule.releaseAllTerminals());
    await within(terminals, step, "releaseAllTerminals", log);
    try {
      options.http.handlers.closeUpgraded();
    } catch (error) {
      log(`[desktop] closeUpgraded failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    await within(
      Promise.allSettled([
        Promise.resolve(options.http.handlers.server.close()),
        closed,
      ]),
      step,
      "Next/HTTP close",
      log,
    );
    options.http.destroyConnections();

    options.send({ type: "stopped", code: 0 });
    // Give the IPC channel one turn to flush before the process leaves; this
    // timer is intentionally referenced, since it is the last thing keeping
    // the process alive after the listeners closed.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, IPC_FLUSH_MS);
    });
    exit(0);
    return 0;
  }

  return {
    isShuttingDown: () => shuttingDown,
    shutdown: (reason, timeoutMs) => {
      if (promise) return promise;
      promise = run(reason, timeoutMs);
      return promise;
    },
  };
}
