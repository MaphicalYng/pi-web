// Desktop-host environment names and the filtering/redaction helpers built on
// them. No Next or pi SDK imports: the desktop entry reads this before anything
// else touches the environment, and the terminal and MCP layers use it to keep
// the desktop host's secrets out of child processes.
//
// Only explicitly listed host variables are hidden. A generic `*_KEY` /
// `*_TOKEN` sweep would break the provider credentials the pi SDK reads.

/** `1` in a desktop backend process. */
export const DESKTOP_MODE_ENV = "PI_WEB_DESKTOP";
/** The run's desktop session secret; consumed (deleted) by `desktop/server/config.ts`. */
export const DESKTOP_SESSION_ENV = "PI_WEB_DESKTOP_SESSION";
/** Where the shell keeps desktop logs; the backend only passes it on to the shell's log file. */
export const DESKTOP_LOG_DIR_ENV = "PI_WEB_DESKTOP_LOG_DIR";
/** The browser password: guards this server, never a child process. */
export const WEB_PASSWORD_ENV = "PI_WEB_PASSWORD";

/** Variables this process sets for itself and never hands to a shell or MCP server. */
const DESKTOP_PRIVATE_ENV_NAMES: readonly string[] = [
  DESKTOP_MODE_ENV,
  DESKTOP_SESSION_ENV,
  DESKTOP_LOG_DIR_ENV,
  WEB_PASSWORD_ENV,
];

/** The values whose appearance in a log line, fatal message or stack must be redacted. */
const DESKTOP_SECRET_ENV_NAMES: readonly string[] = [DESKTOP_SESSION_ENV, WEB_PASSWORD_ENV];

/** Secrets shorter than this are not used for text redaction: replacing them would mangle unrelated text. */
const MIN_REDACTABLE_LENGTH = 4;

/** A process-like environment: the value type both `process.env` and a literal copy satisfy. */
export type DesktopEnvironment = Readonly<Record<string, string | undefined>>;

function comparable(name: string, platform: string): string {
  // Windows resolves environment names case-insensitively.
  return platform === "win32" ? name.toUpperCase() : name;
}

function matches(name: string, candidates: readonly string[], platform: string): boolean {
  const key = comparable(name, platform);
  return candidates.some((candidate) => comparable(candidate, platform) === key);
}

/** `PI_WEB_DESKTOP` / `PI_WEB_DESKTOP_SESSION` / `PI_WEB_DESKTOP_LOG_DIR` / `PI_WEB_PASSWORD`. */
export function isDesktopPrivateEnvName(name: string, platform: string = process.platform): boolean {
  return matches(name, DESKTOP_PRIVATE_ENV_NAMES, platform);
}

/** The desktop session and the browser password, for redaction. */
export function isDesktopSecretEnvName(name: string, platform: string = process.platform): boolean {
  return matches(name, DESKTOP_SECRET_ENV_NAMES, platform);
}

export function desktopPrivateEnvNames(): readonly string[] {
  return DESKTOP_PRIVATE_ENV_NAMES;
}

/** A copy of `env` without the variables this host never passes to children. */
export function desktopEnvWithoutSecrets(
  env: DesktopEnvironment = process.env,
  platform: string = process.platform,
): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (isDesktopPrivateEnvName(name, platform)) continue;
    clean[name] = value;
  }
  return clean;
}

/** The values redaction replaces; empty or very short values are skipped. */
export function desktopSecretValues(
  env: DesktopEnvironment = process.env,
  platform: string = process.platform,
): string[] {
  const values = new Set<string>();
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || value.length < MIN_REDACTABLE_LENGTH) continue;
    if (!isDesktopSecretEnvName(name, platform)) continue;
    values.add(value);
  }
  return [...values];
}

/** The encodings a secret can take in a URL, a log line or a JSON message. */
function secretVariants(secret: string): string[] {
  const variants = [secret];
  for (const encode of [encodeURIComponent, encodeURI]) {
    const encoded = encode(secret);
    if (!variants.includes(encoded)) variants.push(encoded);
  }
  return variants;
}

/** Replaces every occurrence of each secret (and its URL encodings) with `[redacted]`. */
export function redactSecretValues(text: string, secrets: readonly string[]): string {
  let redacted = text;
  // Longest first, so a secret containing another is replaced whole.
  const ordered = [...new Set(secrets.filter((secret) => secret.length >= MIN_REDACTABLE_LENGTH))]
    .sort((a, b) => b.length - a.length);
  for (const secret of ordered) {
    for (const variant of secretVariants(secret)) {
      if (variant) redacted = redacted.split(variant).join("[redacted]");
    }
  }
  return redacted;
}
