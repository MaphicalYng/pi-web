import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import {
  boundPlainText,
  buildFatalDialog,
  buildQuitPrompt,
  desktopCookieDetails,
  secureWindowOptions,
  WindowManager,
} from "../window-manager.ts";
import { DESKTOP_SESSION_COOKIE } from "../../shared/backend-protocol.ts";

const ORIGIN = "http://127.0.0.1:30141";
const SECRET = "a".repeat(64);

class FakeWindow extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.loaded = [];
    this.shown = 0;
    this.focused = 0;
    this.closed = 0;
    this.webContents = {
      loadURL: async (url) => {
        this.loaded.push(url);
      },
      on: () => undefined,
      setWindowOpenHandler: () => undefined,
    };
  }
  loadURL(url) {
    this.loaded.push(url);
    return Promise.resolve();
  }
  show() {
    this.shown += 1;
  }
  focus() {
    this.focused += 1;
  }
  isDestroyed() {
    return this.destroyed;
  }
  close() {
    this.closed += 1;
  }
  destroy() {
    this.destroyed = true;
  }
}

function makeManager(overrides = {}) {
  const windows = [];
  const cookies = { set: [], removed: [], failRemove: false };
  const dialogs = [];
  const logs = [];
  const manager = new WindowManager({
    createWindow: () => {
      const window = new FakeWindow();
      windows.push(window);
      return window;
    },
    cookies: {
      set: async (details) => {
        cookies.set.push(details);
      },
      remove: async (url, name) => {
        if (cookies.failRemove) throw new Error("cookie store locked");
        cookies.removed.push({ url, name });
      },
    },
    dialog: {
      showMessageBox: async (_window, options) => {
        dialogs.push(options);
        return { response: overrides.response ?? 1 };
      },
    },
    log: (level, event, fields) => logs.push({ level, event, fields }),
    preloadPath: "/app/desktop/preload/index.js",
    devTools: false,
    probeFirstPage: async () => ({ ok: true, reachable: true, status: 200 }),
    openExternal: () => undefined,
    ...overrides,
  });
  return { manager, windows, cookies, dialogs, logs };
}

test("secure window options keep every renderer capability off", () => {
  const options = secureWindowOptions({ preloadPath: "/app/desktop/preload/index.js", devTools: false });
  assert.equal(options.webPreferences.nodeIntegration, false);
  assert.equal(options.webPreferences.nodeIntegrationInWorker, false);
  assert.equal(options.webPreferences.contextIsolation, true);
  assert.equal(options.webPreferences.sandbox, true);
  assert.equal(options.webPreferences.webSecurity, true);
  assert.equal(options.webPreferences.allowRunningInsecureContent, false);
  assert.equal(options.webPreferences.experimentalFeatures, false);
  assert.equal(options.webPreferences.webviewTag, false);
  assert.equal(options.webPreferences.navigateOnDragDrop, false);
  assert.equal(options.webPreferences.devTools, false);
  assert.equal(options.webPreferences.preload, "/app/desktop/preload/index.js");
  assert.equal(options.show, false);
  assert.throws(() => secureWindowOptions({ preloadPath: "/app/preload", devTools: false }));
});

test("the session cookie is host-only, httpOnly, secure and strict", () => {
  const cookie = desktopCookieDetails(ORIGIN, SECRET);
  assert.equal(cookie.url, ORIGIN);
  assert.equal(cookie.name, DESKTOP_SESSION_COOKIE);
  assert.equal(cookie.value, SECRET);
  assert.equal(cookie.path, "/");
  assert.equal(cookie.httpOnly, true);
  assert.equal(cookie.secure, true);
  assert.equal(cookie.sameSite, "strict");
  assert.equal("domain" in cookie, false);
  assert.equal("expirationDate" in cookie, false);
});

test("loadBackend sets the cookie, probes the page, then loads the origin", async () => {
  const { manager, windows, cookies } = makeManager();
  const probe = await manager.loadBackend(ORIGIN, SECRET);
  assert.equal(probe.ok, true);
  assert.equal(cookies.set.length, 1);
  assert.equal(cookies.set[0].value, SECRET);
  assert.equal(windows.length, 1);
  assert.deepEqual(windows[0].loaded, [ORIGIN]);
  assert.equal(manager.currentOrigin, ORIGIN);
});

test("a failed first page never loads the origin and reports the failure", async () => {
  const { manager, windows, logs } = makeManager({
    probeFirstPage: async () => ({ ok: false, reachable: true, status: 500, failure: "http-status" }),
  });
  const probe = await manager.loadBackend(ORIGIN, SECRET);
  assert.equal(probe.ok, false);
  assert.equal(windows.length, 0);
  assert.equal(manager.currentOrigin, ORIGIN);
  assert.ok(logs.some((entry) => entry.event === "window.first_page_failed"));
});

test("clearCookie forgets the old origin, by default the current one", async () => {
  const { manager, cookies } = makeManager();
  await manager.loadBackend(ORIGIN, SECRET);
  await manager.clearCookie();
  assert.deepEqual(cookies.removed, [{ url: ORIGIN, name: DESKTOP_SESSION_COOKIE }]);
  assert.equal(manager.currentOrigin, null);
  await manager.clearCookie(null);
  assert.equal(cookies.removed.length, 1);
});

test("reload only targets the known origin and destroyAll dismantles windows", async () => {
  const { manager, windows } = makeManager();
  assert.equal(manager.reload(), false);
  await manager.loadBackend(ORIGIN, SECRET);
  assert.equal(manager.reload(), true);
  assert.deepEqual(windows[0].loaded, [ORIGIN, ORIGIN]);
  manager.destroyAll();
  assert.equal(windows[0].destroyed, true);
  assert.equal(manager.windowCount, 0);
});

test("destroyAll closes a window that cannot destroy and skips destroyed ones", async () => {
  const { manager } = makeManager();
  await manager.loadBackend(ORIGIN, SECRET);
  const closing = { closed: 0, isDestroyed: () => false, close() { this.closed += 1; } };
  const gone = { isDestroyed: () => true, close() { throw new Error("must not close"); } };
  manager.windows.add(closing);
  manager.windows.add(gone);
  manager.destroyAll();
  assert.equal(closing.closed, 1);
  assert.equal(manager.windowCount, 0);
});

test("the quit prompt defaults to Cancel and mentions the surface consequences", () => {
  const active = { activity: "active", running: 2, awaitingInput: 1, subagentsActive: 3 };
  const prompt = buildQuitPrompt(active, "production");
  assert.equal(prompt.defaultId, 0);
  assert.equal(prompt.cancelId, 0);
  assert.deepEqual(prompt.buttons, ["Cancel", "Quit"]);
  assert.match(prompt.message, /work is in progress/);
  assert.match(prompt.detail, /Running sessions: 2/);
  assert.match(prompt.detail, /Active sub-agents: 3/);
  assert.match(prompt.detail, /Sessions waiting for input: 1/);
  assert.match(prompt.detail, /desktop backend/);

  assert.match(buildQuitPrompt(active, "development-attached").detail, /reused development server/);
  assert.match(buildQuitPrompt(active, "development-owned").detail, /will be stopped/);
  assert.match(buildQuitPrompt({ ...active, activity: "unknown" }, "production").detail, /could not determine/);
});

test("fatal dialog copy is bounded plain text with Retry as the default", () => {
  const dialog = buildFatalDialog({ reason: "boom\u0000 <b>x</b>", code: null, exitCode: 1, signal: null });
  assert.deepEqual(dialog.buttons, ["Retry Backend", "Open Logs", "Quit"]);
  assert.equal(dialog.defaultId, 0);
  assert.equal(dialog.cancelId, 2);
  assert.doesNotMatch(dialog.detail, /\u0000/);
  assert.equal(boundPlainText("x".repeat(3_000)).length, 2_048);
  assert.equal(boundPlainText("ok", 10), "ok");
});

test("a cancelled or unavailable quit dialog never approves quitting", async () => {
  const { manager, dialogs } = makeManager({ response: 0 });
  assert.equal(await manager.showQuitPrompt({ activity: "active", running: 1, awaitingInput: 0, subagentsActive: 0 }, "production"), "cancelled");
  assert.equal(dialogs[0].noLink, true);
  const broken = makeManager({
    dialog: {
      showMessageBox: async () => {
        throw new Error("no display");
      },
    },
  });
  assert.equal(
    await broken.manager.showQuitPrompt({ activity: "active", running: 1, awaitingInput: 0, subagentsActive: 0 }, "production"),
    "cancelled",
  );
});

test("the fatal dialog maps responses and never opens twice", async () => {
  const { manager } = makeManager({ response: 0 });
  assert.equal(await manager.showFatalDialog({ reason: "x", code: null, exitCode: 1, signal: null }), "retry");
  const logsChoice = makeManager({ response: 1 });
  assert.equal(await logsChoice.manager.showFatalDialog({ reason: "x", code: null, exitCode: 1, signal: null }), "logs");
  const quit = makeManager({ response: 2 });
  assert.equal(await quit.manager.showFatalDialog({ reason: "x", code: null, exitCode: 1, signal: null }), "quit");
});
