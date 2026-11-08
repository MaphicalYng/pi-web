// The desktop backend's run-scoped session: the cookie the Electron main
// process sets, and the in-memory copy the backend compares it against. Only
// server code reads this; nothing here is exported to the browser bundle, a
// response body or `NEXT_PUBLIC_*`.
//
// The secret lives on `globalThis` under `Symbol.for(...)` because the desktop
// entry, `proxy.ts` and the route handlers can each end up in a different
// bundle. Next 16 runs `proxy.ts` on the Node.js runtime (the Edge sandbox,
// whose `process.env` is a filtered copy, is no longer used for it), so those
// bundles share one `globalThis` in this process.

import { createHash, timingSafeEqual } from "node:crypto";
import { DESKTOP_MODE_ENV } from "./desktop-env";

/** Set by the Electron main process for the loopback origin, never by page script. */
export const DESKTOP_SESSION_COOKIE = "__pi-web-session";

const DESKTOP_AUTH_KEY = Symbol.for("pi-web.desktop-auth");

export interface DesktopAuthContext {
  readonly enabled: true;
  /** This run's session secret; compared, never returned. */
  readonly secret: string;
  /** `http://127.0.0.1:<port>`, once the listener is up. */
  readonly origin?: string;
}

type SymbolIndexedGlobal = { [key: symbol]: DesktopAuthContext | undefined };

function authSlot(): SymbolIndexedGlobal {
  // SAFETY: the key is a module-private `Symbol.for`, so nothing else writes it;
  // this cast only teaches TypeScript about our own non-enumerable slot.
  return globalThis as unknown as SymbolIndexedGlobal;
}

export function getDesktopAuthContext(): DesktopAuthContext | undefined {
  const context = authSlot()[DESKTOP_AUTH_KEY];
  return context?.enabled === true && typeof context.secret === "string" && context.secret.length > 0
    ? context
    : undefined;
}

/** Installs (or replaces) this process's desktop auth context. Not enumerable, so no dump shows it. */
export function setDesktopAuthContext(context: DesktopAuthContext): void {
  Object.defineProperty(globalThis, DESKTOP_AUTH_KEY, {
    value: Object.freeze({ ...context }),
    configurable: true,
    enumerable: false,
    writable: false,
  });
}

/** Records the origin once the listener has its port; the proxy itself does not need it. */
export function setDesktopAuthOrigin(origin: string): void {
  const context = getDesktopAuthContext();
  if (!context) return;
  setDesktopAuthContext({ ...context, origin });
}

/** Tests only: forget the context so a later case starts from plain Web mode. */
export function clearDesktopAuthContext(): void {
  delete authSlot()[DESKTOP_AUTH_KEY];
}

/**
 * Desktop mode is on when this process installed a context. The environment
 * flag is the fallback for a bundle that could not see the context: such a
 * bundle cannot validate the cookie, so it fails closed instead of trusting it.
 */
export function isDesktopMode(): boolean {
  if (getDesktopAuthContext()) return true;
  return process.env[DESKTOP_MODE_ENV] === "1";
}

/** Anything with request headers; keeps this module free of a `next/server` import. */
export interface DesktopCookieRequest {
  headers: { get(name: string): string | null };
}

/**
 * Every value the `Cookie` header gives `__pi-web-session`. A malformed header
 * yields what it can parse; callers reject anything but exactly one value.
 */
export function readDesktopSessionCookieValues(request: DesktopCookieRequest): string[] {
  const header = request.headers.get("cookie");
  if (!header) return [];
  const values: string[] = [];
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== DESKTOP_SESSION_COOKIE) continue;
    values.push(part.slice(separator + 1).trim().replace(/^"(.*)"$/, "$1"));
  }
  return values;
}

/** Whether the request carries the cookie at all (the transport guard accepted it). */
export function hasDesktopSessionCookie(request: DesktopCookieRequest): boolean {
  return readDesktopSessionCookieValues(request).length === 1;
}

/** Constant-time comparison of two secrets, independent of the supplied length. */
export function secretsEqual(expected: string, supplied: string): boolean {
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  const suppliedDigest = createHash("sha256").update(supplied, "utf8").digest();
  return timingSafeEqual(expectedDigest, suppliedDigest);
}

/**
 * The request carries exactly one `__pi-web-session` value equal to this run's
 * secret. Missing context, duplicate cookies and malformed values all fail.
 */
export function hasValidDesktopSession(
  request: DesktopCookieRequest,
  context: DesktopAuthContext | undefined = getDesktopAuthContext(),
): boolean {
  if (!context?.enabled || !context.secret) return false;
  const values = readDesktopSessionCookieValues(request);
  if (values.length !== 1) return false;
  return secretsEqual(context.secret, values[0]);
}
