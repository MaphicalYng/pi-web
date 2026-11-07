import type { McpConfigFieldRef } from "./api-types";

// Which values of an `mcp.json` entry pi resolves before it connects, and the
// PI_WEB_PASSWORD rule over them. Client-safe, with no runtime imports: the
// add pane (`components/mcp-add-helpers.ts`) previews and pre-blocks with the
// same walk the server-side reader, the transport and the routes use
// (re-exported by `lib/mcp-transport.ts`), so a change to which fields pi
// resolves is made once.

export const WEB_PASSWORD_VARIABLE = "PI_WEB_PASSWORD";
/**
 * The desktop backend's per-run IPC secret (`desktop/server/config.ts` deletes
 * it from the environment before any SDK module loads). A reference in
 * `mcp.json` is refused before connecting: the SDK resolves `${VAR}`, `$VAR`
 * and `!command` against this process, and `!printenv` can read names too.
 */
export const DESKTOP_SECRET_VARIABLE = "PI_WEB_DESKTOP_SESSION";

export interface McpResolvedConfigValue extends McpConfigFieldRef {
  value: string;
}

/** The SDK's value parsers `findWebPasswordField()` needs; the browser passes its port of them. */
export interface McpConfigValueParsers {
  isCommandConfigValue(value: string): boolean;
  getConfigValueEnvVarNames(value: string): string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringEntries(value: unknown): [string, string][] {
  return isRecord(value)
    ? Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string")
    : [];
}

/**
 * The values pi resolves in this process before it connects: `${NAME}`,
 * `$NAME`, `!command`. The SDK's transport resolves a stdio entry's `env`, and
 * an HTTP entry's headers and `oauth.clientSecret`, telling them apart by
 * whether `url` is present. Anything else is used as written. Accepts an
 * entry the SDK has not validated: values that are not strings are skipped.
 */
export function resolvedConfigValues(config: unknown): McpResolvedConfigValue[] {
  if (!isRecord(config)) return [];
  if (!("url" in config)) {
    return stringEntries(config.env).map(([name, value]) => ({ kind: "env", name, value }));
  }
  const values: McpResolvedConfigValue[] = stringEntries(config.headers).map(([name, value]) => ({
    kind: "header",
    name,
    value,
  }));
  const clientSecret = isRecord(config.oauth) ? config.oauth.clientSecret : undefined;
  if (typeof clientSecret === "string") values.push({ kind: "oauth-client-secret", value: clientSecret });
  return values;
}

/**
 * The value of `config` that references `PI_WEB_PASSWORD`, or undefined.
 * Values resolve against this process's environment, which still holds the
 * password, so removing it from the server's environment is not enough. Names
 * compare case-insensitively, as Windows resolves them. A `!command` can read
 * the variable without a `$` reference, so any mention counts; the SDK still
 * runs it with this process's whole environment.
 */
export function findWebPasswordField(config: unknown, parsers: McpConfigValueParsers): McpConfigFieldRef | undefined {
  return findReferencedVariableField(config, WEB_PASSWORD_VARIABLE, parsers);
}

/**
 * The value of `config` that references the desktop backend's IPC secret, or
 * undefined. Same walk and rules as `findWebPasswordField()`: a `!command` can
 * read the variable without a `$` reference, names compare upper-cased as
 * Windows resolves them.
 */
export function findDesktopSecretField(config: unknown, parsers: McpConfigValueParsers): McpConfigFieldRef | undefined {
  return findReferencedVariableField(config, DESKTOP_SECRET_VARIABLE, parsers);
}

function findReferencedVariableField(
  config: unknown,
  variable: string,
  parsers: McpConfigValueParsers,
): McpConfigFieldRef | undefined {
  for (const { value, ...field } of resolvedConfigValues(config)) {
    const references = parsers.isCommandConfigValue(value)
      ? value.toUpperCase().includes(variable)
      : parsers.getConfigValueEnvVarNames(value).some((name) => name.toUpperCase() === variable);
    if (references) return field;
  }
  return undefined;
}
