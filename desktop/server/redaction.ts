// Secret redaction for everything this backend prints: its own log lines, the
// bounded `fatal` message, console output from the process and uncaught errors.
//
// Only the exact values the desktop host generated are replaced. A generic
// token/API-key sweep is out of scope here: provider credentials must keep
// working, and the shell's secrets simply never enter a child environment.

import { desktopSecretValues, redactSecretValues } from "../../lib/desktop-env";

/** The shell's fatal text is capped at 2 KiB; stay under it after redaction. */
export const FATAL_MESSAGE_MAX_CHARS = 2000;
const LOG_LINE_MAX_CHARS = 8 * 1024;

export interface Redactor {
  /** Registers another secret discovered after startup (the session handoff). */
  add(secret: string): void;
  /** The values currently replaced; for tests, never logged. */
  secrets(): readonly string[];
  redact(text: string): string;
  /** A one-line, redacted log write. */
  log(line: string): void;
  /** A bounded, redacted fatal message; a non-Error value keeps its string form. */
  fatal(error: unknown): string;
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ? `${error.name}: ${error.message}\n${error.stack}` : `${error.name}: ${error.message}`;
  }
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

/** A redactor seeded from the process environment, then extended with the handoff session. */
export function createRedactor(initial: readonly string[] = []): Redactor {
  const secrets = new Set<string>();
  const add = (secret: string): void => {
    if (typeof secret === "string" && secret.length >= 4) secrets.add(secret);
  };
  for (const secret of initial) add(secret);

  const redact = (text: string): string => {
    const values = [...secrets];
    return values.length === 0 ? text : redactSecretValues(text, values);
  };

  return {
    add,
    secrets: () => [...secrets],
    redact,
    log: (line) => {
      const bounded = line.length > LOG_LINE_MAX_CHARS ? `${line.slice(0, LOG_LINE_MAX_CHARS)}…` : line;
      console.error(redact(bounded));
    },
    fatal: (error) => {
      const text = redact(errorText(error));
      return text.length > FATAL_MESSAGE_MAX_CHARS ? `${text.slice(0, FATAL_MESSAGE_MAX_CHARS)}…` : text;
    },
  };
}

/** Values the launch environment already holds, for a redactor created before the handoff. */
export function launchSecrets(env: NodeJS.ProcessEnv = process.env): string[] {
  return desktopSecretValues(env);
}

/**
 * Wraps the global console writers so every line passes through redaction.
 * Returns the restore function; a second install is a no-op wrapper over the
 * first, so restoring in reverse order is safe.
 */
export function installConsoleRedaction(redactor: Redactor): () => void {
  const original = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
  } as const;
  const wrap = (write: (...args: unknown[]) => void) =>
    (...args: unknown[]): void => {
      write(...args.map((arg) => (typeof arg === "string" ? redactor.redact(arg) : arg)));
    };
  console.log = wrap(original.log);
  console.info = wrap(original.info);
  console.warn = wrap(original.warn);
  console.error = wrap(original.error);
  console.debug = wrap(original.debug);
  return () => {
    console.log = original.log;
    console.info = original.info;
    console.warn = original.warn;
    console.error = original.error;
    console.debug = original.debug;
  };
}
