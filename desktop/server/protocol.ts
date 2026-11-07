// The shell <-> backend messages. Types and validators come from the frozen
// cross-module contract (`desktop/shared/backend-protocol.ts`, read-only here);
// this module adds the process-channel plumbing Electron and a forked child
// each provide, plus the one place a `shutdown` is normalized.
//
//   main -> backend: session { session }, shutdown { timeoutMs? }
//   backend -> main: ready { origin }, fatal { code, message }, stopped { code }
//
// Nothing here carries a filesystem path; fatal messages are already redacted.

import {
  SHUTDOWN_TIMEOUT_DEFAULT_MS,
  SHUTDOWN_TIMEOUT_MAX_MS,
  SHUTDOWN_TIMEOUT_MIN_MS,
  isSessionHandoffMessage,
  type BackendMessage,
  type MainMessage,
  type SessionHandoffMessage,
  type ShutdownMessage,
} from "../shared/backend-protocol";

export {
  SHUTDOWN_TIMEOUT_DEFAULT_MS,
  SHUTDOWN_TIMEOUT_MAX_MS,
  SHUTDOWN_TIMEOUT_MIN_MS,
  type BackendMessage,
  type MainMessage,
  type SessionHandoffMessage,
  type ShutdownMessage,
};

/**
 * The frozen `normalizeShutdownTimeout` rule (`desktop/shared/backend-protocol.ts`):
 * an absent value means the default; anything else must be an integer inside
 * 30–120 s, so an out-of-range budget rejects the message instead of being
 * silently clamped (a shell asking for 20 s must not believe it got 30 s).
 */
export function normalizeShutdownTimeoutMs(value: unknown): number | null {
  if (value === undefined) return SHUTDOWN_TIMEOUT_DEFAULT_MS;
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  if (value < SHUTDOWN_TIMEOUT_MIN_MS || value > SHUTDOWN_TIMEOUT_MAX_MS) return null;
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Reads one main-process message. `shutdown` carries the shell's cleanup
 * budget (default 60 s, 30–120 s allowed); an invalid budget rejects the whole
 * message, and `session` must be the exact 64 hex string.
 */
export function parseMainMessage(raw: unknown): MainMessage | undefined {
  if (!isRecord(raw)) return undefined;
  // Electron wraps the payload in `{ data }`; a forked child does not.
  const value = isRecord(raw.data) ? raw.data : raw;
  if (isSessionHandoffMessage(value)) return value;
  if (value.type !== "shutdown") return undefined;
  const timeoutMs = normalizeShutdownTimeoutMs(value.timeoutMs);
  if (timeoutMs === null) return undefined;
  return { type: "shutdown", timeoutMs };
}

/** One side of the IPC pipe: Electron's `process.parentPort`, or a forked child's channel. */
export interface DesktopMessagePort {
  postMessage(message: unknown): void;
  onMessage(listener: (message: unknown) => void): void;
  onClose?(listener: () => void): void;
}

interface EventedChannel {
  on(event: string, listener: (event: { data?: unknown }) => void): void;
  postMessage?(message: unknown): void;
  send?(message: unknown, callback?: (error: Error | null) => void): boolean;
}

/**
 * The process's host channel. Electron utility processes expose
 * `process.parentPort`; a `child_process.fork()` child (integration tests) has
 * `process.on("message")` and `process.send`. Undefined when neither exists.
 */
export function readParentPort(proc: NodeJS.Process = process): DesktopMessagePort | undefined {
  // SAFETY: Electron injects `parentPort` onto the utility process object; the
  // Node typings describe only the standard process. The shape is checked below.
  const parentPort = (proc as unknown as { parentPort?: EventedChannel }).parentPort;
  if (parentPort && typeof parentPort.on === "function" && typeof parentPort.postMessage === "function") {
    return {
      postMessage: (message) => parentPort.postMessage?.(message),
      onMessage: (listener) => {
        parentPort.on("message", (event) => listener(event?.data));
      },
      onClose: (listener) => {
        parentPort.on("close", () => listener());
      },
    };
  }
  if (typeof proc.on !== "function") return undefined;
  // SAFETY: a `child_process.fork()` child has the channel's `send`; the base
  // process typings omit it, and the runtime check below proves it exists.
  const send = (proc as unknown as { send?: (message: unknown, callback?: (error: Error | null) => void) => boolean }).send;
  if (typeof send !== "function") return undefined;
  return {
    postMessage: (message) => {
      send.call(proc, message);
    },
    onMessage: (listener) => {
      proc.on("message", (message: unknown) => listener(message));
    },
    onClose: (listener) => {
      proc.on("disconnect", () => listener());
    },
  };
}

export type MessageSender = (message: BackendMessage) => boolean;

/** A sender that never throws: a broken pipe must not take the backend down mid-shutdown. */
export function createMessageSender(port: Pick<DesktopMessagePort, "postMessage">): MessageSender {
  return (message) => {
    try {
      port.postMessage(message);
      return true;
    } catch {
      return false;
    }
  };
}
