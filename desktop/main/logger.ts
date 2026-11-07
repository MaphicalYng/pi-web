/**
 * Bounded, redacted logging for the desktop main process. Nothing here may log
 * an environment dump, a cookie header, an IPC payload or the desktop secret:
 * every line goes through the redactor and is truncated before it is written.
 */
import { appendFileSync, chmodSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

import { LOG_LINE_MAX_CHARS, LOG_MAX_BYTES } from "./constants";
import { DESKTOP_ENV_PREFIX, DESKTOP_SESSION_COOKIE } from "../shared/backend-protocol";

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogFields = Record<string, string | number | boolean | null | undefined>;

export interface Redactor {
  redact(text: string): string;
  addSecret(secret: string): void;
  secrets(): readonly string[];
}

export interface LoggerLike {
  readonly directory: string;
  readonly filePath: string;
  addSecret(secret: string): void;
  redact(text: string): string;
  log(level: LogLevel, message: string, fields?: LogFields): void;
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

export const REDACTED = "[redacted]";
/** Values shorter than this are too generic to redact without destroying the log. */
const MIN_SECRET_LENGTH = 8;

/** Keys whose env values are treated as secrets when the logger starts. */
const SENSITIVE_KEY_PATTERN = /TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|AUTH/i;

/**
 * Cookie/authorization header fragments are redacted even when the exact value
 * is unknown to this process (for example a backend-set login cookie).
 */
const HEADER_PATTERNS: readonly RegExp[] = [
  new RegExp(`(${DESKTOP_SESSION_COOKIE}=)[^\\s;,"']+`, "gi"),
  /((?:^|[\s;])(?:cookie|set-cookie)\s*:\s*)[^\r\n]+/gi,
  /((?:^|[\s;])authorization\s*:\s*)[^\r\n]+/gi,
];

function secretVariants(secret: string): string[] {
  const variants = new Set<string>([secret]);
  try {
    const encoded = encodeURIComponent(secret);
    variants.add(encoded);
    variants.add(encoded.replace(/%20/g, "+"));
  } catch {
    // Lone surrogates cannot be URI encoded; the raw value is still covered.
  }
  return [...variants];
}

export function createRedactor(initialSecrets: Iterable<string> = []): Redactor {
  const byVariant = new Map<string, string>();
  const currentSecrets: string[] = [];

  const redact = (text: string): string => {
    let output = text;
    for (const variant of [...byVariant.keys()].sort((a, b) => b.length - a.length)) {
      if (variant.length === 0) continue;
      output = output.split(variant).join(REDACTED);
    }
    for (const pattern of HEADER_PATTERNS) {
      pattern.lastIndex = 0;
      output = output.replace(pattern, (_match, prefix: string) => `${prefix}${REDACTED}`);
    }
    return output;
  };

  const addSecret = (secret: string): void => {
    if (typeof secret !== "string" || secret.length < MIN_SECRET_LENGTH) return;
    if (currentSecrets.includes(secret)) return;
    currentSecrets.push(secret);
    for (const variant of secretVariants(secret)) {
      if (variant.length >= MIN_SECRET_LENGTH) byVariant.set(variant, secret);
    }
  };

  for (const secret of initialSecrets) addSecret(secret);

  return {
    redact,
    addSecret,
    secrets: () => currentSecrets.slice(),
  };
}

/** Sensitive values from the main environment; short values are skipped on purpose. */
export function collectSensitiveEnvValues(
  env: Record<string, string | undefined>,
  minLength: number = MIN_SECRET_LENGTH,
): string[] {
  const values: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string") continue;
    if (value.length < minLength) continue;
    if (key.startsWith(DESKTOP_ENV_PREFIX)) continue;
    if (!SENSITIVE_KEY_PATTERN.test(key)) continue;
    if (!values.includes(value)) values.push(value);
  }
  return values;
}

/** Single-line, size-bounded text; never multi-line file content. */
export function boundText(text: string, maxChars: number = LOG_LINE_MAX_CHARS): string {
  const flattened = String(text).replace(/\r\n?/g, "\n").replace(/\n/g, " \\n ");
  if (flattened.length <= maxChars) return flattened;
  return `${flattened.slice(0, Math.max(0, maxChars - 1))}…`;
}

export function formatLogLine(
  entry: { time: Date; pid: number; level: LogLevel; message: string; fields?: LogFields },
  maxChars: number = LOG_LINE_MAX_CHARS,
): string {
  const parts = [entry.time.toISOString(), `pid=${entry.pid}`, entry.level, entry.message];
  for (const [key, value] of Object.entries(entry.fields ?? {})) {
    if (value === undefined) continue;
    parts.push(`${key}=${typeof value === "string" ? JSON.stringify(value) : String(value)}`);
  }
  return boundText(parts.join(" "), maxChars);
}

export interface LoggerFsOps {
  mkdirSync(path: string, options: { recursive: true; mode?: number }): void;
  chmodSync(path: string, mode: number): void;
  statSync(path: string): { size: number };
  renameSync(from: string, to: string): void;
  appendFileSync(path: string, data: string, options: { mode?: number }): void;
}

const defaultFs: LoggerFsOps = {
  mkdirSync,
  chmodSync,
  statSync,
  renameSync,
  appendFileSync,
};

/** Creates the log directory with user-only permissions (best effort). */
export function initializeLogDirectory(directory: string, fsOps: LoggerFsOps = defaultFs): void {
  fsOps.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    fsOps.chmodSync(directory, 0o700);
  } catch {
    // A pre-existing directory owned by the user is fine.
  }
}

/** One-time rotation at startup: `main.log` -> `main.log.1`, keeping a single old file. */
export function rotateLogFile(filePath: string, maxBytes: number = LOG_MAX_BYTES, fsOps: LoggerFsOps = defaultFs): boolean {
  let size = 0;
  try {
    size = fsOps.statSync(filePath).size;
  } catch {
    return false;
  }
  if (size <= maxBytes) return false;
  try {
    fsOps.renameSync(filePath, `${filePath}.1`);
    return true;
  } catch {
    return false;
  }
}

export interface LoggerOptions {
  directory: string;
  pid?: number;
  now?: () => Date;
  maxBytes?: number;
  maxLineChars?: number;
  secrets?: Iterable<string>;
  fsOps?: LoggerFsOps;
}

export interface Logger extends LoggerLike {
  readonly redactor: Redactor;
}

/**
 * Narrows arbitrary log fields to the JSON-safe primitives the log line format
 * accepts; objects/arrays become bounded text instead of leaking structure.
 */
export function toLogFields(fields: Record<string, unknown>): LogFields {
  const safe: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === null || value === undefined) safe[key] = value;
    else if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") safe[key] = value;
    else safe[key] = boundText(String(value));
  }
  return safe;
}

export function createLogger(options: LoggerOptions): Logger {
  const fsOps = options.fsOps ?? defaultFs;
  const pid = options.pid ?? process.pid;
  const now = options.now ?? (() => new Date());
  const maxBytes = options.maxBytes ?? LOG_MAX_BYTES;
  const maxLineChars = options.maxLineChars ?? LOG_LINE_MAX_CHARS;
  const filePath = join(options.directory, "main.log");
  const redactor = createRedactor(options.secrets ?? []);

  initializeLogDirectory(options.directory, fsOps);
  rotateLogFile(filePath, maxBytes, fsOps);

  const log = (level: LogLevel, message: string, fields?: LogFields): void => {
    const safeMessage = redactor.redact(boundText(message, maxLineChars));
    const safeFields: LogFields = {};
    if (fields) {
      for (const [key, value] of Object.entries(fields)) {
        safeFields[key] = typeof value === "string" ? redactor.redact(boundText(value, maxLineChars)) : value;
      }
    }
    const line = formatLogLine({ time: now(), pid, level, message: safeMessage, fields: safeFields }, maxLineChars);
    try {
      fsOps.appendFileSync(filePath, `${line}\n`, { mode: 0o600 });
    } catch {
      // Logging must never take the app down.
    }
  };

  return {
    directory: options.directory,
    filePath,
    redactor,
    addSecret: (secret: string) => redactor.addSecret(secret),
    redact: (text: string) => redactor.redact(text),
    log,
    debug: (message, fields) => log("debug", message, fields),
    info: (message, fields) => log("info", message, fields),
    warn: (message, fields) => log("warn", message, fields),
    error: (message, fields) => log("error", message, fields),
  };
}

/** Opens the fixed log directory with the OS file manager; never a caller-provided path. */
export async function openLogsDirectory(
  directory: string,
  openPath: (target: string) => Promise<string>,
  fsOps: LoggerFsOps = defaultFs,
): Promise<boolean> {
  try {
    initializeLogDirectory(directory, fsOps);
    const failure = await openPath(directory);
    return failure === "";
  } catch {
    return false;
  }
}
