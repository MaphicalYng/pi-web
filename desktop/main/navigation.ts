/**
 * One navigation and permission policy for every window, including windows
 * opened through `window.open`. Pure decisions live here so tests can assert
 * them without Electron; `install*` helpers only wire those decisions in.
 */
import type { LogFn } from "./backend-supervisor";
import { classifyLink, isAllowedBackendUrl } from "../shared/urls";

export type LinkAction = "navigate" | "external" | "deny";

export function linkAction(candidate: unknown, origin: string | null): LinkAction {
  const target = classifyLink(candidate, origin);
  if (target === "same-origin") return "navigate";
  // Another loopback port is not "one of ours", but it is still a real http(s)
  // URL the user asked for: an agent link to a local page (a preview server,
  // another Pi Web instance) opens in the default browser exactly like any
  // other external link. The window itself never leaves the backend origin.
  if (target === "external") return "external";
  return "deny";
}

export interface NavigationGuardDeps {
  origin: () => string | null;
  openExternal: (url: string) => void;
  /** Same-origin `window.open` targets are opened by main with the same secure options. */
  createSecureWindow: (url: string) => void;
  log: LogFn;
}

export interface WebContentsEventsLike {
  setWindowOpenHandler(handler: (details: { url: string }) => { action: "deny" }): void;
  on(event: "will-navigate", listener: (event: { preventDefault(): void }, url: string) => void): void;
  on(event: "will-redirect", listener: (event: { preventDefault(): void }, url: string) => void): void;
  on(event: "will-attach-webview", listener: (event: { preventDefault(): void }) => void): void;
}

/**
 * - same-origin navigations stay in the window they started in,
 * - credential-free http(s) links open in the system browser exactly once,
 *   including loopback URLs on another port,
 * - everything else (custom schemes, file:, data:, javascript:, userinfo URLs)
 *   is dropped with a scheme-only log line,
 * - `window.open` always returns deny; same-origin targets go through
 *   `createSecureWindow` so no window is ever created with Electron defaults,
 * - attaching a webview is refused.
 */
export function installNavigationGuards(contents: WebContentsEventsLike, deps: NavigationGuardDeps): void {
  contents.setWindowOpenHandler((details) => {
    const action = linkAction(details.url, deps.origin());
    if (action === "external") deps.openExternal(details.url);
    else if (action === "navigate") deps.createSecureWindow(details.url);
    else deps.log("warn", "window.open_blocked", { scheme: safeScheme(details.url) });
    return { action: "deny" };
  });

  const guard = (url: string): boolean => {
    const action = linkAction(url, deps.origin());
    if (action === "navigate") return false;
    if (action === "external") {
      deps.openExternal(url);
      deps.log("info", "window.external_opened", { scheme: safeScheme(url) });
    } else {
      deps.log("warn", "window.navigation_blocked", { scheme: safeScheme(url) });
    }
    return true;
  };

  contents.on("will-navigate", (event, url) => {
    if (guard(url)) event.preventDefault();
  });
  contents.on("will-redirect", (event, url) => {
    if (guard(url)) event.preventDefault();
  });
  contents.on("will-attach-webview", (event) => {
    deps.log("warn", "window.webview_blocked");
    event.preventDefault();
  });
}

/** Permissions the product may grant — and only to the current backend origin. */
export const ALLOWED_PERMISSIONS: readonly string[] = [
  "notifications",
  "fullscreen",
  "clipboard-sanitized-write",
];

/**
 * Default deny. The allow-list entry still requires a same-origin requesting
 * URL, so an embedded external document can never inherit a grant.
 */
export function permissionAllowed(
  permission: string,
  requestingUrl: string | null | undefined,
  origin: string | null,
): boolean {
  if (!ALLOWED_PERMISSIONS.includes(permission)) return false;
  if (!isAllowedBackendUrl(requestingUrl, origin)) return false;
  return true;
}

export interface SessionLike {
  setPermissionRequestHandler(
    handler: (contents: unknown, permission: string, callback: (granted: boolean) => void, details?: unknown) => void,
  ): void;
  setPermissionCheckHandler(
    handler: (contents: unknown, permission: string, requestingOrigin: string, details?: unknown) => boolean,
  ): void;
}

/**
 * One policy for permission requests and checks. `requestingOrigin` may be a
 * bare origin (Electron's check handler) or a full URL; both are compared to the
 * backend origin by the same strict origin parser.
 */
export function installSessionGuards(session: SessionLike, deps: { origin: () => string | null; log: LogFn }): void {
  session.setPermissionRequestHandler((_contents, permission, callback, details) => {
    const url = requestingUrlFrom(details);
    const granted = permissionAllowed(permission, url, deps.origin());
    if (granted) deps.log("info", "permission.granted", { permission });
    else deps.log("warn", "permission.denied", { permission, scheme: url ? safeScheme(url) : "?" });
    callback(granted);
  });

  session.setPermissionCheckHandler((_contents, permission, requestingOrigin) => {
    const granted = permissionAllowed(permission, requestingOrigin, deps.origin());
    if (!granted) deps.log("debug", "permission.check_denied", { permission });
    return granted;
  });
}

function requestingUrlFrom(details: unknown): string | null {
  if (typeof details === "object" && details !== null && "requestingUrl" in details) {
    const url = (details as { requestingUrl?: unknown }).requestingUrl;
    if (typeof url === "string") return url;
  }
  if (typeof details === "object" && details !== null && "requestingOrigin" in details) {
    const origin = (details as { requestingOrigin?: unknown }).requestingOrigin;
    if (typeof origin === "string") return origin;
  }
  return null;
}

/** Scheme only: logged URLs must never carry paths, queries or credentials. */
export function safeScheme(candidate: string): string {
  try {
    const parsed = new URL(candidate);
    return `${parsed.protocol.replace(/:$/, "")}:`;
  } catch {
    return "invalid:";
  }
}
