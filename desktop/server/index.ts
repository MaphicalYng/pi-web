// The desktop backend's entry point, forked by Electron's main process as a
// utilityProcess (Node) or, in integration tests, `child_process.fork`.
//
// Order matters:
//   parent port -> launch config (session copied to auth context, deleted from
//   the environment) -> redactor -> standalone checks -> listener + Next ->
//   ready -> session handoff (when it did not arrive in the environment) ->
//   serve until `shutdown`, SIGTERM/SIGINT or a lost host.
//
// Nothing in this file imports `next/server` or `proxy.ts`: those pull in the
// request-time auth context, and the session must be gone from the environment
// before they are loaded. Agent, terminal and Next modules load later, lazily.

import {
  DesktopConfigError,
  assertStandaloneRoot,
  consumeDesktopLaunch,
  enterServerDir,
  installDesktopSession,
} from "./config";
import { DESKTOP_SESSION_ENV } from "../../lib/desktop-env";
import { createLifecycle, type Lifecycle } from "./lifecycle";
import { setDesktopAuthOrigin } from "../../lib/desktop-auth";
import { startDesktopHttpServer, type DesktopHttpServer } from "./next-server";
import {
  createMessageSender,
  parseMainMessage,
  readParentPort,
  type BackendMessage,
  type DesktopMessagePort,
} from "./protocol";
import {
  FATAL_MESSAGE_MAX_CHARS,
  createRedactor,
  installConsoleRedaction,
  type Redactor,
} from "./redaction";

/** How long the shell may take to hand a session over after `ready`. */
export const HANDOFF_TIMEOUT_MS = 30_000;

export interface DesktopBackendOptions {
  /** Defaults to `process.parentPort` or the forked child's channel. */
  readonly port?: DesktopMessagePort;
  readonly env?: NodeJS.ProcessEnv & Record<string, string | undefined>;
  readonly exit?: (code: number) => void;
}

function sendFatal(redact: Redactor, send: (message: BackendMessage) => boolean, error: unknown): void {
  const message = redact.fatal(error).slice(0, FATAL_MESSAGE_MAX_CHARS);
  const code = error instanceof DesktopConfigError ? error.code : "desktop.fatal";
  send({ type: "fatal", code, message });
}

/** Keeps the process alive while the handoff message is awaited. */
function waitForHandoff(): { promise: Promise<void>; done: () => void } {
  let done: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    done = resolve;
  });
  return { promise, done };
}

/**
 * Starts the backend and resolves once it serves (or rejects before it does).
 * The returned promise never rejects on shutdown: cleanup returns an exit code
 * through `options.exit`.
 */
export async function startDesktopBackend(options: DesktopBackendOptions = {}): Promise<void> {
  const env = options.env ?? process.env;
  const exit = options.exit ?? ((code: number) => process.exit(code));

  // `parentPort` must exist before anything else runs; a plain Node process has
  // no shell to report to and cannot be served safely.
  const port = options.port ?? readParentPort();
  if (!port) {
    console.error("[desktop] no parent port: the backend must run under the desktop shell");
    exit(1);
    return;
  }
  const send = createMessageSender(port);

  const handoff = waitForHandoff();
  let redact: Redactor = createRedactor();
  let lifecycle: Lifecycle | null = null;
  let http: DesktopHttpServer | null = null;
  let sessionInstalled = false;

  const install = (secret: string): void => {
    if (sessionInstalled) {
      // The shell installed a second session after the first: refuse rather
      // than silently serving a different page context.
      throw new DesktopConfigError("desktop.session", "a session was already installed");
    }
    installDesktopSession(secret);
    redact.add(secret);
    sessionInstalled = true;
    handoff.done();
  };

  const requestShutdown = (reason: string, timeoutMs?: number): void => {
    if (lifecycle) {
      // The shell's own budget (30–120 s, default 60 s) governs every cleanup
      // step; `requestShutdown` before the listener exists has no steps to run.
      void lifecycle.shutdown(reason, timeoutMs);
      return;
    }
    // Before the listener exists there is nothing to tear down.
    handoff.done();
    exit(0);
  };

  port.onMessage((raw) => {
    const message = parseMainMessage(raw);
    if (!message) {
      redact.log("[desktop] ignored a malformed shell message");
      return;
    }
    if (message.type === "shutdown") {
      requestShutdown("shutdown message", message.timeoutMs);
      return;
    }
    try {
      install(message.session);
    } catch (error) {
      sendFatal(redact, send, error);
      requestShutdown("invalid session handoff");
    }
  });
  port.onClose?.(() => {
    redact.log("[desktop] the shell's channel closed");
    requestShutdown("host closed");
  });

  try {
    const launch = consumeDesktopLaunch({ env });
    redact = createRedactor(launch.secrets);
    // Anything Next or the pi SDK prints through `console.*` leaves this
    // process as well; wrap it before those modules can log a secret.
    installConsoleRedaction(redact);
    assertStandaloneRoot(launch.serverDir);
    if (launch.sessionFromEnv !== undefined) install(launch.sessionFromEnv);
    enterServerDir(launch.serverDir);

    // Disposing a session's MCP host sends `session_shutdown` through a process
    // that is exiting anyway; keep that noise (redacted) out of the way.
    process.on("uncaughtException", (error: unknown) => {
      redact.log(`[desktop] uncaught exception: ${redact.fatal(error)}`);
      requestShutdown("uncaught exception");
    });
    process.on("unhandledRejection", (reason: unknown) => {
      redact.log(`[desktop] unhandled rejection: ${redact.fatal(reason)}`);
      requestShutdown("unhandled rejection");
    });
    process.once("SIGTERM", () => requestShutdown("SIGTERM"));
    process.once("SIGINT", () => requestShutdown("SIGINT"));

    http = await startDesktopHttpServer({
      dir: launch.serverDir,
      isShuttingDown: () => lifecycle?.isShuttingDown() ?? false,
      log: redact.log,
    });
    lifecycle = createLifecycle({
      http,
      redact,
      send,
      exit,
    });

    send({ type: "ready", origin: http.guard.origin });
    setDesktopAuthOrigin(http.guard.origin);
    redact.log(`[desktop] serving ${http.guard.origin}`);

    if (!sessionInstalled) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new DesktopConfigError("desktop.session", "no session handoff arrived"));
        }, HANDOFF_TIMEOUT_MS);
        (timer as { unref?: () => void }).unref?.();
      });
      try {
        await Promise.race([handoff.promise, timeout]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (!sessionInstalled) {
        // A shutdown arrived before the handoff: nothing to serve.
        await lifecycle.shutdown("handoff cancelled");
        return;
      }
    }
  } catch (error) {
    if (redact.secrets().length === 0) {
      redact = createRedactor([env[DESKTOP_SESSION_ENV] ?? ""]);
      // The failed launch may still have read the session from the environment;
      // wrap the replacement redactor so that value cannot reach the log either.
      installConsoleRedaction(redact);
    }
    sendFatal(redact, send, error);
    redact.log(`[desktop] failed to start: ${redact.fatal(error)}`);
    if (lifecycle) {
      await lifecycle.shutdown("startup failed");
      return;
    }
    if (http) {
      await http.close(1_000).catch(() => undefined);
    }
    exit(1);
    return;
  }

  // Serving: the listener keeps the event loop busy until shutdown closes it.
}

// Electron's utility process is the only automatic entry: it owns
// `process.parentPort` and expects a `ready` message. A forked integration-test
// child imports `startDesktopBackend` from a small wrapper and starts it itself.
// SAFETY: Electron adds `parentPort` to the process object; the Node typings do
// not describe it, so this reads the field through a minimal structural shape.
const isUtilityProcess = typeof (process as unknown as { parentPort?: unknown }).parentPort !== "undefined";
if (isUtilityProcess) {
  void startDesktopBackend().catch((error: unknown) => {
    console.error(`[desktop] backend crashed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
