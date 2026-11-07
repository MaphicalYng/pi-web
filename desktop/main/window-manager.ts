/**
 * BrowserWindow lifecycle, the production session cookie, page loading and the
 * native dialogs. Electron objects are injected, so no Electron import lives
 * here and the cookie/load ordering stays unit-testable.
 *
 * Invariants:
 * - every window (main or `window.open`) is built by `secureWindowOptions()`,
 * - the desktop cookie is set and awaited before the first backend request,
 * - the first page probe must pass before `loadURL`, so a `ready` backend never
 *   shows a blank or half-rendered page,
 * - fatal/quit/quit-crash dialogs are plain text, modal to the main window and
 *   de-duplicated.
 */
import type { LogFn } from "./backend-supervisor";
import type { BackendFailure } from "./backend-supervisor";
import type { ActivitySnapshot } from "./activity";
import { APP_WINDOW_BACKGROUND, APP_WINDOW_TITLE, FATAL_TEXT_MAX_CHARS } from "./constants";
import type { PageProbeResult } from "./http-probes";
import { DESKTOP_SESSION_COOKIE } from "../shared/backend-protocol";
import { installNavigationGuards } from "./navigation";

export interface WebPreferencesLike {
  preload: string;
  nodeIntegration: false;
  nodeIntegrationInWorker: false;
  contextIsolation: true;
  sandbox: true;
  webSecurity: true;
  allowRunningInsecureContent: false;
  experimentalFeatures: false;
  webviewTag: false;
  spellcheck: boolean;
  devTools: boolean;
  navigateOnDragDrop: false;
  safeDialogs: true;
}

export interface WindowOptionsLike {
  title: string;
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
  show: boolean;
  backgroundColor: string;
  autoHideMenuBar: true;
  webPreferences: WebPreferencesLike;
}

export function secureWindowOptions(input: { preloadPath: string; devTools: boolean }): WindowOptionsLike {
  if (typeof input.preloadPath !== "string" || !input.preloadPath.endsWith(".js")) {
    throw new Error("preload path must point at the compiled preload script");
  }
  return {
    title: APP_WINDOW_TITLE,
    width: 1280,
    height: 840,
    minWidth: 720,
    minHeight: 480,
    show: false,
    backgroundColor: APP_WINDOW_BACKGROUND,
    autoHideMenuBar: true,
    webPreferences: {
      preload: input.preloadPath,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      webviewTag: false,
      spellcheck: false,
      devTools: input.devTools,
      navigateOnDragDrop: false,
      safeDialogs: true,
    },
  };
}

export interface CookieDetailsLike {
  url: string;
  name: string;
  value: string;
  path: string;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "strict";
}

/** Frozen cookie shape: host-only (no domain), session-only (no expiration), path `/`. */
export function desktopCookieDetails(origin: string, secret: string): CookieDetailsLike {
  return {
    url: origin,
    name: DESKTOP_SESSION_COOKIE,
    value: secret,
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "strict",
  };
}

export interface CookieStoreLike {
  set(details: CookieDetailsLike): Promise<void>;
  remove(url: string, name: string): Promise<void>;
}

export interface WebContentsLike {
  loadURL(url: string): Promise<void>;
  on(event: "render-process-gone", listener: (event: unknown, details: unknown) => void): void;
  on(event: "will-navigate", listener: (event: { preventDefault(): void }, url: string) => void): void;
  on(event: "will-redirect", listener: (event: { preventDefault(): void }, url: string) => void): void;
  on(event: "will-attach-webview", listener: (event: { preventDefault(): void }) => void): void;
  setWindowOpenHandler(handler: (details: { url: string }) => { action: "deny" }): void;
}

export interface BrowserWindowLike {
  readonly webContents: WebContentsLike;
  loadURL(url: string): Promise<void>;
  show(): void;
  focus(): void;
  isDestroyed(): boolean;
  isMinimized?(): boolean;
  restore?(): void;
  close(): void;
  destroy?(): void;
  on(event: string, listener: (...args: unknown[]) => void): void;
}

export type BrowserWindowFactory = (options: WindowOptionsLike) => BrowserWindowLike;

export interface DialogLike {
  showMessageBox(
    window: BrowserWindowLike | null,
    options: {
      type: "question" | "warning" | "error" | "info";
      buttons: string[];
      defaultId: number;
      cancelId: number;
      noLink?: boolean;
      title: string;
      message: string;
      detail?: string;
    },
  ): Promise<{ response: number }>;
}

export interface WindowManagerDeps {
  createWindow: BrowserWindowFactory;
  cookies: CookieStoreLike;
  dialog: DialogLike;
  log: LogFn;
  preloadPath: string;
  devTools: boolean;
  /** Bounded first-page probe; must resolve, never throw. */
  probeFirstPage: (origin: string) => Promise<PageProbeResult>;
  openExternal: (url: string) => void;
  onWindowClosed?: () => void;
  /** Last window close: the entry point may preventDefault and run the quit flow. */
  onLastWindowCloseRequest?: (event: { preventDefault(): void }) => void;
  now?: () => number;
}

export interface QuitPromptText {
  title: string;
  message: string;
  detail: string;
  buttons: [string, string];
  defaultId: number;
  cancelId: number;
}

/**
 * Quit copy depends on the surface: stopping an owned dev server also stops its
 * tasks, while a reused `npm run dev` keeps running after the window closes.
 */
export function buildQuitPrompt(
  activity: ActivitySnapshot,
  surface: "production" | "development-attached" | "development-owned",
  unknownActivity = activity.activity === "unknown",
): QuitPromptText {
  const sessions = activity.running;
  const subagents = activity.subagentsActive;
  const awaiting = activity.awaitingInput;
  const detailParts: string[] = [];
  if (unknownActivity) {
    detailParts.push("Pi Web could not determine whether sessions are still running.");
  } else {
    detailParts.push(`Running sessions: ${sessions}. Active sub-agents: ${subagents}.`);
    if (awaiting > 0) detailParts.push(`Sessions waiting for input: ${awaiting}.`);
  }
  if (surface === "development-attached") {
    detailParts.push("The reused development server and its tasks keep running after this window closes.");
  } else if (surface === "development-owned") {
    detailParts.push("The development server started by this window (and its tasks) will be stopped.");
  } else {
    detailParts.push("The desktop backend and its running work will be stopped.");
  }
  return {
    title: APP_WINDOW_TITLE,
    message: unknownActivity ? "Quit Pi Web?" : "Quit Pi Web while work is in progress?",
    detail: detailParts.join(" "),
    buttons: ["Cancel", "Quit"],
    // Cancel is the default and the escape target: never discard work by Enter.
    defaultId: 0,
    cancelId: 0,
  };
}

export interface FatalChoice {
  retry: boolean;
  openLogs: boolean;
  quit: boolean;
}

export function buildFatalDialog(failure: BackendFailure): {
  title: string;
  message: string;
  detail: string;
  buttons: [string, string, string];
  defaultId: number;
  cancelId: number;
} {
  const reason = boundPlainText(failure.reason);
  return {
    title: APP_WINDOW_TITLE,
    message: "Pi Web's desktop backend stopped",
    detail: reason.length > 0 ? reason : "The backend exited without a message.",
    buttons: ["Retry Backend", "Open Logs", "Quit"],
    defaultId: 0,
    cancelId: 2,
  };
}

/** Plain text only: backend messages are never parsed as HTML. */
export function boundPlainText(text: string, maxChars: number = FATAL_TEXT_MAX_CHARS): string {
  const value = typeof text === "string" ? text : String(text);
  const stripped = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
  return stripped.length <= maxChars ? stripped : `${stripped.slice(0, Math.max(0, maxChars - 1))}…`;
}

export class WindowManager {
  private readonly deps: WindowManagerDeps;
  private mainWindow: BrowserWindowLike | null = null;
  private origin: string | null = null;
  private fatalDialogOpen = false;
  private readonly windows = new Set<BrowserWindowLike>();

  constructor(deps: WindowManagerDeps) {
    this.deps = deps;
  }

  get currentOrigin(): string | null {
    return this.origin;
  }

  get windowCount(): number {
    return this.windows.size;
  }

  get main(): BrowserWindowLike | null {
    return this.mainWindow;
  }

  /** A blank native window; no `file:`/`data:` page is ever loaded into it. */
  ensureMainWindow(): BrowserWindowLike {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) return this.mainWindow;
    const window = this.createWindow();
    this.mainWindow = window;
    window.on("ready-to-show", () => {
      if (!window.isDestroyed()) window.show();
    });
    window.on("closed", () => {
      this.windows.delete(window);
      if (this.mainWindow === window) this.mainWindow = null;
      this.deps.onWindowClosed?.();
    });
    return window;
  }

  focusMainWindow(): boolean {
    const window = this.mainWindow;
    if (!window || window.isDestroyed()) return false;
    if (window.isMinimized?.()) window.restore?.();
    window.focus();
    return true;
  }

  /**
   * Production load order: await cookie set, probe the full first page, then
   * point the window at the backend. A failed probe leaves the window blank and
   * reports the failure instead of loading a known-broken origin.
   */
  async loadBackend(origin: string, session: string | null): Promise<PageProbeResult> {
    this.origin = origin;
    if (session !== null) {
      await this.deps.cookies.set(desktopCookieDetails(origin, session));
      this.deps.log("info", "window.cookie_set", { origin });
    }
    const probe = await this.deps.probeFirstPage(origin);
    if (!probe.ok) {
      this.deps.log("error", "window.first_page_failed", {
        failure: probe.failure ?? "unknown",
        status: probe.status ?? null,
      });
      return probe;
    }
    const window = this.ensureMainWindow();
    await window.loadURL(origin);
    this.deps.log("info", "window.loaded", { origin });
    return probe;
  }

  /** Old origin must stop being trusted and carrying credentials before retry. */
  async clearCookie(origin: string | null = this.origin): Promise<void> {
    this.origin = null;
    if (!origin) return;
    try {
      await this.deps.cookies.remove(origin, DESKTOP_SESSION_COOKIE);
      this.deps.log("info", "window.cookie_cleared", { origin });
    } catch (error) {
      this.deps.log("warn", "window.cookie_clear_failed", {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Loads a known-good origin without re-probing (activate / manual retry after probe). */
  async loadOrigin(origin: string): Promise<void> {
    this.origin = origin;
    const window = this.ensureMainWindow();
    await window.loadURL(origin);
    this.deps.log("info", "window.loaded", { origin });
  }

  /** Reloads the current backend origin in the main window; no other URL is accepted. */
  reload(): boolean {
    const window = this.mainWindow;
    if (!window || window.isDestroyed() || !this.origin) return false;
    void window.webContents.loadURL(this.origin).catch((error: unknown) => {
      this.deps.log("warn", "window.reload_failed", {
        reason: error instanceof Error ? error.message : String(error),
      });
    });
    return true;
  }

  /** Same-origin `window.open`: main builds the window with the same secure options. */
  createSecureWindow(url: string): BrowserWindowLike {
    const window = this.createWindow();
    window.on("ready-to-show", () => {
      if (!window.isDestroyed()) window.show();
    });
    void window.loadURL(url).catch((error: unknown) => {
      this.deps.log("warn", "window.secondary_load_failed", {
        reason: error instanceof Error ? error.message : String(error),
      });
    });
    return window;
  }

  destroyAll(): void {
    for (const window of this.windows) {
      try {
        if (window.isDestroyed()) continue;
        if (typeof window.destroy === "function") {
          window.destroy();
        } else {
          window.close();
        }
      } catch {
        // Destroy is best effort; quit must not be blocked by a dead window.
      }
    }
    this.windows.clear();
    this.mainWindow = null;
  }

  async showQuitPrompt(
    activity: ActivitySnapshot,
    surface: "production" | "development-attached" | "development-owned",
  ): Promise<"confirmed" | "cancelled"> {
    const text = buildQuitPrompt(activity, surface);
    try {
      const result = await this.deps.dialog.showMessageBox(this.mainWindow, {
        type: "question",
        ...text,
        noLink: true,
      });
      return result.response === 1 ? "confirmed" : "cancelled";
    } catch (error) {
      this.deps.log("warn", "window.quit_dialog_failed", {
        reason: error instanceof Error ? error.message : String(error),
      });
      // An unshowable dialog must not discard work silently.
      return "cancelled";
    }
  }

  /** De-duplicated native failure dialog. Returns null while another one is open. */
  async showFatalDialog(failure: BackendFailure): Promise<"retry" | "logs" | "quit" | null> {
    if (this.fatalDialogOpen) return null;
    this.fatalDialogOpen = true;
    try {
      const text = buildFatalDialog(failure);
      const window = this.mainWindow && !this.mainWindow.isDestroyed() ? this.mainWindow : null;
      const result = await this.deps.dialog.showMessageBox(window, {
        type: "error",
        ...text,
        noLink: true,
      });
      if (result.response === 0) return "retry";
      if (result.response === 1) return "logs";
      return "quit";
    } catch (error) {
      this.deps.log("warn", "window.fatal_dialog_failed", {
        reason: error instanceof Error ? error.message : String(error),
      });
      return "quit";
    } finally {
      this.fatalDialogOpen = false;
    }
  }

  /** Renderer crash: backend is untouched; offer a page reload only. */
  installRenderCrashRecovery(window: BrowserWindowLike): void {
    window.webContents.on("render-process-gone", (_event, details) => {
      const reason =
        typeof details === "object" && details !== null && "reason" in details
          ? String((details as { reason?: unknown }).reason ?? "unknown")
          : "unknown";
      this.deps.log("error", "window.renderer_gone", { reason });
      if (window.isDestroyed()) return;
      void this.deps.dialog
        .showMessageBox(window, {
          type: "warning",
          buttons: ["Reload Page", "Quit"],
          defaultId: 0,
          cancelId: 1,
          noLink: true,
          title: APP_WINDOW_TITLE,
          message: "The page stopped responding",
          detail: "Reload the page. The backend and running sessions are not restarted.",
        })
        .then((result) => {
          if (window.isDestroyed()) return;
          if (result.response === 0) {
            if (!this.reload()) window.close();
          } else {
            window.close();
          }
        })
        .catch(() => undefined);
    });
  }

  private createWindow(): BrowserWindowLike {
    const window = this.deps.createWindow(
      secureWindowOptions({ preloadPath: this.deps.preloadPath, devTools: this.deps.devTools }),
    );
    this.windows.add(window);
    window.on("close", (event?: unknown) => {
      // Only the last window may start an application quit; closing a secondary
      // window never does. The entry point prevents the close until approved.
      if (this.windows.size > 1) return;
      const closeEvent = event as { preventDefault?: () => void } | undefined;
      if (closeEvent && typeof closeEvent.preventDefault === "function") {
        this.deps.onLastWindowCloseRequest?.(closeEvent as { preventDefault(): void });
      }
    });
    installNavigationGuards(window.webContents, {
      origin: () => this.origin,
      openExternal: this.deps.openExternal,
      createSecureWindow: (url) => this.createSecureWindow(url),
      log: this.deps.log,
    });
    this.installRenderCrashRecovery(window);
    return window;
  }
}
