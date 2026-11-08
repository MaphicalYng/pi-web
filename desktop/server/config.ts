// The desktop backend's startup contract: the launch environment the shell
// hands over, the standalone root, and the one-time session installation.
//
// The session arrives either in `PI_WEB_DESKTOP_SESSION` (tests and a direct
// spawn) or in the shell's `session` handoff message; either way its value is
// copied into the process's auth context and removed from the environment
// before any Next or pi SDK module is loaded.

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { setDesktopAuthContext, type DesktopAuthContext } from "../../lib/desktop-auth";
import {
  DESKTOP_MODE_ENV,
  DESKTOP_SESSION_ENV,
  desktopSecretValues,
  type DesktopEnvironment,
} from "../../lib/desktop-env";

export const DESKTOP_HOSTNAME = "127.0.0.1" as const;
/** Build and integration-test override; an installed app uses the resources layout. */
export const DESKTOP_SERVER_DIR_ENV = "PI_WEB_DESKTOP_SERVER_DIR";
/** The shell's 32 random bytes, hex encoded. */
export const DESKTOP_SESSION_PATTERN = /^[0-9a-f]{64}$/;

export class DesktopConfigError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "DesktopConfigError";
    this.code = code;
  }
}

export interface DesktopLaunch {
  readonly serverDir: string;
  readonly hostname: typeof DESKTOP_HOSTNAME;
  readonly port: 0;
  /** The session that arrived with the environment, if any; the handoff message covers the rest. */
  readonly sessionFromEnv?: string;
  /** Values redaction must replace, captured before the environment is cleaned. */
  readonly secrets: readonly string[];
}

function defaultResourcesPath(): string | undefined {
  // SAFETY: Electron adds `resourcesPath` to the global process; the Node
  // typings do not describe it, and this backend must not require electron.
  const value = (process as NodeJS.Process & { resourcesPath?: unknown }).resourcesPath;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Exactly 64 lowercase hex characters. */
export function isDesktopSessionSecret(value: unknown): value is string {
  return typeof value === "string" && DESKTOP_SESSION_PATTERN.test(value);
}

/**
 * `resourcesPath/backend/next-standalone`, unless the build names another root.
 * Never derived from `__dirname`, which points into a development checkout.
 */
export function resolveServerDir(
  env: DesktopEnvironment = process.env,
  resourcesPath: string | undefined = defaultResourcesPath(),
): string {
  const override = env[DESKTOP_SERVER_DIR_ENV];
  if (typeof override === "string" && override.trim().length > 0) return resolve(override.trim());
  if (!resourcesPath) {
    throw new DesktopConfigError("desktop.resources", "the desktop resources directory is unavailable");
  }
  return join(resourcesPath, "backend", "next-standalone");
}

/** The parts of a standalone root the backend needs; names only, so fatal messages carry no paths. */
export function missingStandaloneParts(serverDir: string): string[] {
  const missing: string[] = [];
  if (!existsSync(join(serverDir, "package.json"))) missing.push("package.json");
  if (!existsSync(join(serverDir, ".next"))) missing.push(".next");
  if (!existsSync(join(serverDir, "node_modules", "next"))) missing.push("node_modules/next");
  return missing;
}

/** Throws a path-free `DesktopConfigError` when the root cannot serve a Next app. */
export function assertStandaloneRoot(serverDir: string): void {
  const missing = missingStandaloneParts(serverDir);
  if (missing.length > 0) {
    throw new DesktopConfigError(
      "desktop.resources",
      `the Next standalone root is incomplete (missing ${missing.join(", ")})`,
    );
  }
}

/**
 * Validates the launch, copies the session value into the process's auth
 * context and deletes it from `env`. The shell's mode flag or a session value
 * is required: a plain Web process must never reach this entry.
 */
export function consumeDesktopLaunch(
  options: { env?: DesktopEnvironment & Record<string, string | undefined>; resourcesPath?: string } = {},
): DesktopLaunch {
  const env = options.env ?? process.env;
  const session = env[DESKTOP_SESSION_ENV];
  if (env[DESKTOP_MODE_ENV] !== "1" && !session) {
    throw new DesktopConfigError("desktop.mode", "the desktop backend must start with PI_WEB_DESKTOP=1");
  }
  if (session !== undefined && !isDesktopSessionSecret(session)) {
    throw new DesktopConfigError("desktop.session", "the desktop session is not 64 hex characters");
  }

  // Captured before the variable is deleted, so later redaction covers it.
  const secrets = desktopSecretValues(env);
  delete env[DESKTOP_SESSION_ENV];

  const serverDir = resolveServerDir(env, options.resourcesPath ?? defaultResourcesPath());
  return { serverDir, hostname: DESKTOP_HOSTNAME, port: 0, sessionFromEnv: session, secrets };
}

/** Installs the run's session; every later request compares against it. */
export function installDesktopSession(secret: string): DesktopAuthContext {
  if (!isDesktopSessionSecret(secret)) {
    throw new DesktopConfigError("desktop.session", "the desktop session is not 64 hex characters");
  }
  const auth: DesktopAuthContext = { enabled: true, secret };
  setDesktopAuthContext(auth);
  return auth;
}

/**
 * Enters the standalone root, as its own `server.js` does, so Next resolves
 * relative dynamic assets. pi's data directory is untouched.
 */
export function enterServerDir(serverDir: string): void {
  process.chdir(serverDir);
}
