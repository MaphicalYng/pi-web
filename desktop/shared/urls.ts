/**
 * Origin and link policy for the desktop shell. Pure functions only: the main
 * process, the window manager and the navigation guards all derive their
 * decisions here so a second window cannot drift from the main window's rules.
 */

export const BACKEND_HOST = "127.0.0.1";

export type LinkTarget = "same-origin" | "external" | "blocked";

/**
 * Strict loopback origin: `http://127.0.0.1:<port>` and nothing else.
 * `localhost`, `::1`, `0.0.0.0`, https, a missing port and any path, query,
 * fragment or userinfo are rejected — the backend only ever reports the exact
 * origin it listens on.
 */
export function parseLoopbackOrigin(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:") return null;
  if (parsed.hostname !== BACKEND_HOST) return null;
  if (parsed.username !== "" || parsed.password !== "") return null;
  if (parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") return null;
  if (value !== parsed.origin) return null;
  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return parsed.origin;
}

/** Navigation and window hrefs may carry a path, query and hash but stay on the backend origin. */
export function isAllowedBackendUrl(candidate: unknown, origin: string | null): boolean {
  if (typeof origin !== "string" || parseLoopbackOrigin(origin) === null) return false;
  if (typeof candidate !== "string" || candidate.length === 0 || candidate.length > 8192) return false;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:") return false;
  if (parsed.username !== "" || parsed.password !== "") return false;
  if (parsed.hostname !== BACKEND_HOST) return false;
  return parsed.origin === origin;
}

/** Any http URL on 127.0.0.1, regardless of port: it belongs to the app, never a browser tab. */
export function isLoopbackHttpUrl(candidate: unknown): boolean {
  if (typeof candidate !== "string" || candidate.length === 0 || candidate.length > 8192) return false;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:") return false;
  if (parsed.username !== "" || parsed.password !== "") return false;
  return parsed.hostname === BACKEND_HOST;
}

/**
 * Only credential-free http(s) URLs are ever handed to the system browser.
 * `mailto:`, `file:`, `javascript:`, custom schemes and URLs with userinfo are
 * blocked outright: none of them may reach `shell.openExternal`.
 */
export function isExternalHttpUrl(candidate: unknown): boolean {
  if (typeof candidate !== "string" || candidate.length === 0 || candidate.length > 8192) return false;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (parsed.username !== "" || parsed.password !== "") return false;
  return parsed.hostname.length > 0;
}

/** Same-origin stays in an app window, valid http(s) opens externally, everything else is blocked. */
export function classifyLink(candidate: unknown, origin: string | null): LinkTarget {
  if (isAllowedBackendUrl(candidate, origin)) return "same-origin";
  if (isExternalHttpUrl(candidate)) return "external";
  return "blocked";
}

/** True for the backend origin itself and for any URL that navigation must refuse. */
export function isNavigationAllowed(candidate: unknown, origin: string | null): boolean {
  return isAllowedBackendUrl(candidate, origin);
}

/**
 * Builds a same-origin URL from a path. The path policy is intentionally narrow:
 * it must be absolute, must not start with `//`, must contain no backslash, no
 * control characters, no whitespace and no scheme-like first segment — that
 * keeps `javascript:`, `//evil`, `/%5C..` and pasted absolute URLs out of
 * `loadURL` even when a caller passes user-controlled text.
 */
export function buildAppUrl(origin: string | null, appPath = "/"): string | null {
  const parsedOrigin = parseLoopbackOrigin(origin);
  if (parsedOrigin === null) return null;
  if (typeof appPath !== "string" || appPath.length === 0 || appPath.length > 8192) return null;
  if (!appPath.startsWith("/") || appPath.startsWith("//")) return null;
  if (appPath.includes("\\") || /[\u0000-\u0020\u007f]/.test(appPath)) return null;
  const firstSegment = appPath.split(/[/?#]/, 2)[1] ?? "";
  if (firstSegment.includes(":")) return null;
  const candidate = `${parsedOrigin}${appPath}`;
  return isAllowedBackendUrl(candidate, parsedOrigin) ? candidate : null;
}

/**
 * Accepts what the renderer hands over for `will-navigate`: a relative app path
 * or an absolute URL that already points at the backend origin. Anything else
 * (about:blank, data:, file:, other origins) yields null.
 */
export function appUrlFromInput(input: unknown, origin: string | null): string | null {
  if (typeof input !== "string") return null;
  const parsedOrigin = parseLoopbackOrigin(origin);
  if (parsedOrigin === null) return null;
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  if (trimmed === parsedOrigin) return buildAppUrl(parsedOrigin, "/");
  if (trimmed.startsWith(`${parsedOrigin}/`)) {
    return buildAppUrl(parsedOrigin, trimmed.slice(parsedOrigin.length));
  }
  return buildAppUrl(parsedOrigin, trimmed);
}
