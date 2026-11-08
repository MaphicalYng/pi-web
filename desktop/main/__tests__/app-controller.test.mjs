import assert from "node:assert/strict";
import { test } from "node:test";

import { AppController } from "../app-controller.ts";

const ORIGIN = "http://127.0.0.1:30141";
const SECRET = "b".repeat(64);
const idle = { activity: "idle", running: 0, awaitingInput: 0, subagentsActive: 0 };

function makeController({ mode = "production", loadBackend, showFatalDialog, supervisorStart, devSurface } = {}) {
  const calls = {
    start: 0,
    restart: 0,
    stop: 0,
    devStart: 0,
    devStop: 0,
    killAll: 0,
    load: [],
    clearCookie: [],
    dialogs: [],
    quit: [],
    openLogs: 0,
    reload: 0,
  };
  let approved = false;
  const supervisor = {
    start: async () => {
      calls.start += 1;
      if (supervisorStart) return supervisorStart();
      return { origin: ORIGIN, session: SECRET };
    },
    restart: async () => {
      calls.restart += 1;
      return { origin: ORIGIN, session: SECRET };
    },
    stop: async () => {
      calls.stop += 1;
    },
    snapshot: () => ({ phase: "ready", origin: ORIGIN }),
  };
  const development = {
    url: ORIGIN,
    ensureStarted: async () => {
      calls.devStart += 1;
      return devSurface ?? "spawned";
    },
    stop: async () => {
      calls.devStop += 1;
    },
    killAllNow: () => {
      calls.killAll += 1;
    },
    snapshot: () => ({
      surface: devSurface ?? "spawned",
      owned: (devSurface ?? "spawned") === "spawned",
      origin: ORIGIN,
    }),
  };
  const windows = {
    currentOrigin: ORIGIN,
    windowCount: 0,
    loadBackend: async (origin, session) => {
      calls.load.push({ origin, session });
      if (loadBackend) return loadBackend(origin, session);
      return { ok: true, reachable: true, status: 200 };
    },
    loadOrigin: async () => undefined,
    clearCookie: async (origin) => {
      calls.clearCookie.push(origin);
    },
    ensureMainWindow: () => undefined,
    focusMainWindow: () => true,
    reload: () => true,
    destroyAll: () => undefined,
    showFatalDialog: async (failure) => {
      calls.dialogs.push(failure);
      if (showFatalDialog) return showFatalDialog(failure);
      return "quit";
    },
  };
  const quit = {
    get isApproved() {
      return approved;
    },
    requestQuit: async (request) => {
      calls.quit.push(request);
      approved = true;
      return "quit";
    },
  };
  const controller = new AppController({
    mode,
    log: () => undefined,
    windows,
    supervisor,
    development,
    readActivity: async () => idle,
    quit,
    openLogs: async () => {
      calls.openLogs += 1;
      return true;
    },
  });
  return { controller, calls, quit, deps: { windows, supervisor, development } };
}

test("production start loads the backend page with its per-attempt secret", async () => {
  const { controller, calls } = makeController();
  assert.equal(await controller.start(), true);
  assert.deepEqual(calls.load, [{ origin: ORIGIN, session: SECRET }]);
  assert.equal(calls.start, 1);
  assert.equal(await controller.start(), true);
  assert.equal(calls.start, 1);
});

test("a failed first page stops the backend, clears the cookie and reports failure", async () => {
  const { controller, calls } = makeController({
    loadBackend: async () => ({ ok: false, reachable: true, status: 500, failure: "http-status" }),
  });
  assert.equal(await controller.start(), false);
  assert.equal(calls.stop, 1);
  assert.deepEqual(calls.clearCookie, [ORIGIN]);
  assert.equal(calls.dialogs.length, 1);
  assert.equal(calls.quit.length, 1);
  assert.deepEqual(calls.quit[0], { interactive: false, reason: "fatal" });
});

test("development start reuses a healthy page and loads without a cookie", async () => {
  const { controller, calls } = makeController({ mode: "development" });
  assert.equal(await controller.start(), true);
  assert.equal(calls.devStart, 1);
  assert.deepEqual(calls.load, [{ origin: ORIGIN, session: null }]);
});

test("a failed development page stops only the owned server before reporting", async () => {
  const { controller, calls } = makeController({
    mode: "development",
    loadBackend: async () => ({ ok: false, failure: "not-pi-web" }),
  });
  assert.equal(await controller.start(), false);
  assert.equal(calls.devStop, 1);
  assert.equal(calls.dialogs.length, 1);
});

test("a failed retry loops back to the fatal dialog instead of leaving a blank window", async () => {
  let dialogs = 0;
  const { controller, calls } = makeController({
    showFatalDialog: async () => {
      dialogs += 1;
      return dialogs === 1 ? "retry" : "quit";
    },
    loadBackend: async () => ({ ok: false, failure: "network" }),
  });
  await controller.reportFailure({ reason: "backend crashed", code: null, exitCode: 1, signal: null });
  assert.equal(dialogs, 2);
  assert.equal(calls.restart, 1);
  assert.equal(calls.load.length, 1);
  assert.equal(calls.quit.length, 1);
});

test("Open Logs loops back to the same fatal dialog and calls no backend method", async () => {
  let dialogs = 0;
  const { controller, calls } = makeController({
    showFatalDialog: async () => {
      dialogs += 1;
      return dialogs === 1 ? "logs" : "quit";
    },
  });
  await controller.reportFailure({ reason: "boom", code: "E", exitCode: null, signal: null });
  assert.equal(dialogs, 2);
  assert.equal(calls.openLogs, 1);
  assert.equal(calls.start, 0);
  assert.equal(calls.quit.length, 1);
});

test("cleanup stops the backend, then removes the cookie and destroys windows", async () => {
  const { controller, deps } = makeController();
  const order = [];
  deps.supervisor.stop = async () => {
    order.push("backend");
  };
  deps.windows.clearCookie = async () => {
    order.push("cookie");
  };
  deps.windows.destroyAll = () => {
    order.push("windows");
  };
  await controller.cleanup();
  assert.deepEqual(order, ["backend", "cookie", "windows"]);
});

test("development cleanup stops an owned server and kills leftovers", async () => {
  const { controller, calls } = makeController({ mode: "development" });
  await controller.cleanup();
  assert.equal(calls.devStop, 1);
  assert.equal(calls.killAll, 1);
});

test("an attached development server is left running but leftovers are reaped", async () => {
  const { controller, calls } = makeController({ mode: "development", devSurface: "attached" });
  await controller.cleanup();
  assert.equal(calls.devStop, 0);
  assert.equal(calls.killAll, 1);
});

test("surface, last-window close and approval delegate to the quit coordinator", async () => {
  const { controller, calls, quit } = makeController({ mode: "development" });
  assert.equal(controller.surface(), "development-owned");
  const attached = makeController({ mode: "development", devSurface: "attached" });
  assert.equal(attached.controller.surface(), "development-attached");

  let prevented = 0;
  controller.handleLastWindowClose({ preventDefault: () => (prevented += 1) });
  assert.equal(prevented, 1);
  assert.deepEqual(calls.quit[0], { interactive: true, reason: "window-close" });
  assert.equal(quit.isApproved, true);
  controller.handleLastWindowClose({ preventDefault: () => (prevented += 1) });
  assert.equal(prevented, 1);
});

test("start failures report once and never leave a half-open window", async () => {
  const { controller, calls } = makeController({
    supervisorStart: async () => {
      throw new Error("backend did not start");
    },
  });
  assert.equal(await controller.start(), false);
  assert.equal(calls.load.length, 0);
  assert.equal(calls.dialogs.length, 1);
});

test("reload and Open Logs expose their outcomes", async () => {
  const { controller, calls } = makeController();
  assert.equal(controller.reload(), true);
  assert.equal(await controller.openLogs(), true);
  assert.equal(calls.openLogs, 1);
});
