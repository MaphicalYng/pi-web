/**
 * GUI-session environment repair. A macOS app launched from Finder does not
 * inherit the login shell's PATH and provider variables. We run one bounded,
 * non-interactive probe (`zsh -lic 'printf marker; env -0'`) and merge only the
 * missing values into the main process environment.
 *
 * This probe complements the environment; it never wraps a user command and its
 * exit status must never be interpreted as a command failure. The probe output,
 * the full environment and the desktop secret are never logged.
 */
import { GUI_ENV_PROBE_MAX_BYTES, GUI_ENV_PROBE_TIMEOUT_MS } from "./constants";
import { DESKTOP_ENV, DESKTOP_ENV_PREFIX } from "../shared/backend-protocol";

export type EnvironmentMap = Record<string, string>;
export type EnvironmentInput = Record<string, string | undefined>;

export const GUI_ENV_MARKER = "__PI_WEB_GUI_ENV_";
export const LOGIN_SHELL = "/bin/zsh";

const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

const FALLBACK_PATH =
  "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

/** Copies the environment without any desktop host variable (never mutates the input). */
export function stripDesktopVariables(env: EnvironmentInput): EnvironmentMap {
  const copy: EnvironmentMap = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string") continue;
    if (key === DESKTOP_ENV.mode || key.startsWith(DESKTOP_ENV_PREFIX)) continue;
    copy[key] = value;
  }
  return copy;
}

/**
 * Reads the NUL separated `KEY=VALUE` records that follow the marker. Shell
 * startup files may print prompts before the marker; everything before it is
 * ignored. Returns null when the marker is missing.
 */
export function parseProbeOutput(stdout: string): EnvironmentMap | null {
  if (typeof stdout !== "string") return null;
  const markerIndex = stdout.indexOf(GUI_ENV_MARKER);
  if (markerIndex < 0) return null;
  const markerEnd = stdout.indexOf("__", markerIndex + GUI_ENV_MARKER.length);
  if (markerEnd < 0) return null;
  const records = stdout.slice(markerEnd + 2).split("\0");
  const environment: EnvironmentMap = {};
  for (const record of records) {
    if (record.length === 0) continue;
    const separator = record.indexOf("=");
    if (separator <= 0) continue;
    const key = record.slice(0, separator);
    if (!ENV_KEY_PATTERN.test(key)) continue;
    environment[key] = record.slice(separator + 1);
  }
  return Object.keys(environment).length > 0 ? environment : null;
}

/**
 * Prompt junk before the marker is irrelevant, but a marker that appears in a
 * prompt line must not swallow the real environment. We take the last marker.
 */
export function parseProbeOutputFromLastMarker(stdout: string): EnvironmentMap | null {
  if (typeof stdout !== "string") return null;
  const index = stdout.lastIndexOf(GUI_ENV_MARKER);
  if (index < 0) return null;
  return parseProbeOutput(stdout.slice(index));
}

/**
 * Login values only fill gaps; explicitly set main-process values win. The
 * shell's own controlled desktop variables are written later, never here.
 */
export function mergeLoginEnvironment(base: EnvironmentMap, login: EnvironmentMap | null): EnvironmentMap {
  const merged: EnvironmentMap = login ? { ...login } : {};
  for (const [key, value] of Object.entries(base)) {
    merged[key] = value;
  }
  if (!merged.PATH) merged.PATH = FALLBACK_PATH;
  return merged;
}

export function fallbackPath(): string {
  return FALLBACK_PATH;
}

/** Deterministic probe script; the marker carries the shell pid for uniqueness. */
export function buildProbeScript(): string {
  return `printf '${GUI_ENV_MARKER}%s__' "$$"; env -0`;
}

export interface ExecFileOptionsLike {
  env: EnvironmentMap;
  timeout: number;
  killSignal: NodeJS.Signals;
  maxBuffer: number;
  encoding: "utf8";
}

export type ExecFileCallback = (error: Error | null, stdout: string) => void;
export type ExecFileLike = (file: string, args: readonly string[], options: ExecFileOptionsLike, callback: ExecFileCallback) => unknown;

export interface LoginShellProbe {
  command: string;
  args: readonly string[];
  options: ExecFileOptionsLike;
}

export function buildLoginShellProbe(env: EnvironmentInput, maxBuffer: number = GUI_ENV_PROBE_MAX_BYTES): LoginShellProbe {
  return {
    command: LOGIN_SHELL,
    args: ["-lic", buildProbeScript()],
    options: {
      env: stripDesktopVariables(env),
      timeout: GUI_ENV_PROBE_TIMEOUT_MS,
      killSignal: "SIGKILL",
      maxBuffer,
      encoding: "utf8",
    },
  };
}

export interface GuiEnvironmentOptions {
  env: EnvironmentInput;
  execFile: ExecFileLike;
  platform?: "darwin" | "win32" | "linux" | string;
  logger?: { warn(message: string): void };
  maxBuffer?: number;
}

/**
 * Returns a new environment map. Any probe failure (non-zero exit, timeout,
 * buffer overflow, missing marker, non-macOS) falls back to the main process
 * environment instead of blocking the desktop start.
 */
export async function resolveGuiEnvironment(options: GuiEnvironmentOptions): Promise<EnvironmentMap> {
  const base = stripDesktopVariables(options.env);
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") return mergeLoginEnvironment(base, null);

  const probe = buildLoginShellProbe(options.env, options.maxBuffer);
  const login = await new Promise<EnvironmentMap | null>((resolve) => {
    let settled = false;
    const finish = (value: EnvironmentMap | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      options.execFile(probe.command, probe.args, probe.options, (error, stdout) => {
        if (error) {
          options.logger?.warn("gui environment probe failed; using the inherited environment");
          finish(null);
          return;
        }
        const parsed = parseProbeOutputFromLastMarker(stdout);
        if (!parsed) options.logger?.warn("gui environment probe produced no marker; using the inherited environment");
        finish(parsed);
      });
    } catch {
      options.logger?.warn("gui environment probe could not start; using the inherited environment");
      finish(null);
    }
  });

  return mergeLoginEnvironment(base, login);
}
