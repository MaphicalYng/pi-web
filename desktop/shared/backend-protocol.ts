/**
 * Wire contract between the Electron main process and the desktop backend
 * (utilityProcess). Shared on purpose: the backend imports this module instead
 * of re-declaring strings, and it must stay free of Electron and Next imports.
 *
 * Messages travel over the utilityProcess IPC channel (child.postMessage /
 * process.parentPort), never over argv, env or files. The desktop secret is
 * handed over in a single session message before the backend boots; it must
 * never appear in a URL, an environment variable or a log line.
 */
import { randomBytes } from "node:crypto";

/** Single well-known channel tag, so both processes agree without sharing values. */
export const DESKTOP_CHANNEL = Symbol.for("pi.web.desktop");

/** Host-only session cookie the main process sets for the backend origin. */
export const DESKTOP_SESSION_COOKIE = "__pi-web-session";

/** Host variables the desktop shell owns. */
export const DESKTOP_ENV = {
  mode: "PI_WEB_DESKTOP",
  session: "PI_WEB_DESKTOP_SESSION",
  logDir: "PI_WEB_DESKTOP_LOG_DIR",
} as const;

/** Every `PI_WEB_DESKTOP_*` key the shell strips from inherited environments. */
export const DESKTOP_ENV_PREFIX = "PI_WEB_DESKTOP_";

export const SESSION_SECRET_BYTES = 32;
export const SESSION_SECRET_LENGTH = SESSION_SECRET_BYTES * 2;
export const SESSION_SECRET_PATTERN = /^[0-9a-f]{64}$/;

export const SHUTDOWN_TIMEOUT_MIN_MS = 30_000;
export const SHUTDOWN_TIMEOUT_MAX_MS = 120_000;
export const SHUTDOWN_TIMEOUT_DEFAULT_MS = 60_000;

export type ReadyMessage = { readonly type: "ready"; readonly origin: string };
export type FatalMessage = {
  readonly type: "fatal";
  readonly code: string;
  readonly message: string;
};
export type ShutdownMessage = {
  readonly type: "shutdown";
  readonly timeoutMs?: number;
};
export type StoppedMessage = { readonly type: "stopped"; readonly code: number };
/** Main -> backend hand-off of the per-attempt secret (utilityProcess IPC). */
export type SessionHandoffMessage = {
  readonly type: "session";
  readonly session: string;
};

export type BackendMessage = ReadyMessage | FatalMessage | StoppedMessage;
export type MainMessage = ShutdownMessage | SessionHandoffMessage;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(record);
  if (actual.length !== keys.length) return false;
  return keys.every((key) => Object.hasOwn(record, key));
}

function isNonEmptyText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

function isLoopbackOriginText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

export function isSessionSecret(value: unknown): value is string {
  return typeof value === "string" && SESSION_SECRET_PATTERN.test(value);
}

/** 32 random bytes, hex encoded: exactly 64 lowercase hex characters. */
export function generateSessionSecret(): string {
  return randomBytes(SESSION_SECRET_BYTES).toString("hex");
}

export function isReadyMessage(value: unknown): value is ReadyMessage {
  return isRecord(value) && hasExactKeys(value, ["type", "origin"]) && value.type === "ready" && isLoopbackOriginText(value.origin);
}

export function isFatalMessage(value: unknown): value is FatalMessage {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["type", "code", "message"]) &&
    value.type === "fatal" &&
    isNonEmptyText(value.code, 128) &&
    typeof value.message === "string"
  );
}

export function isStoppedMessage(value: unknown): value is StoppedMessage {
  return isRecord(value) && hasExactKeys(value, ["type", "code"]) && value.type === "stopped" && typeof value.code === "number" && Number.isInteger(value.code);
}

export function isShutdownMessage(value: unknown): value is ShutdownMessage {
  if (!isRecord(value) || value.type !== "shutdown") return false;
  if (hasExactKeys(value, ["type"])) return true;
  if (!hasExactKeys(value, ["type", "timeoutMs"])) return false;
  return normalizeShutdownTimeout(value.timeoutMs) !== null && normalizeShutdownTimeout(value.timeoutMs) === value.timeoutMs;
}

export function isSessionHandoffMessage(value: unknown): value is SessionHandoffMessage {
  return isRecord(value) && hasExactKeys(value, ["type", "session"]) && value.type === "session" && isSessionSecret(value.session);
}

/** Parses any backend -> main message; anything else is reported as null. */
export function parseBackendMessage(value: unknown): BackendMessage | null {
  if (isReadyMessage(value)) return value;
  if (isFatalMessage(value)) return value;
  if (isStoppedMessage(value)) return value;
  return null;
}

/** Clamps a requested shutdown budget into the frozen 30s..120s window. */
export function normalizeShutdownTimeout(value: unknown): number | null {
  if (value === undefined) return SHUTDOWN_TIMEOUT_DEFAULT_MS;
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  if (value < SHUTDOWN_TIMEOUT_MIN_MS || value > SHUTDOWN_TIMEOUT_MAX_MS) return null;
  return value;
}

export function createSessionHandoff(secret: string): SessionHandoffMessage {
  if (!isSessionSecret(secret)) throw new Error("invalid desktop session secret");
  return { type: "session", session: secret };
}

export function createShutdownMessage(timeoutMs: number = SHUTDOWN_TIMEOUT_DEFAULT_MS): ShutdownMessage {
  const normalized = normalizeShutdownTimeout(timeoutMs);
  if (normalized === null) throw new Error("invalid shutdown timeout");
  return { type: "shutdown", timeoutMs: normalized };
}
