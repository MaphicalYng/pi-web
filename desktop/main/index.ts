/**
 * Electron entry point. It owns the single-instance lock, app ready, the
 * concrete adapters (utilityProcess, net.fetch, session cookies, dialogs,
 * shell, menu) and the lifecycle events; all policy lives in the injected
 * controllers. No `ipcMain` handler exists anywhere in the shell.
 */
import { execFile, spawn } from "node:child_process";
import path from "node:path";

import { AppController } from "./app-controller";
import { fetchActivity } from "./activity";
import { BackendSupervisor } from "./backend-supervisor";
import { DEV_ORIGIN } from "./constants";
import { DevelopmentServer } from "./development-server";
import { loadElectron } from "./electron-runtime";
import { resolveGuiEnvironment, type ExecFileLike } from "./environment";
import { probeDevelopmentServer, probeFirstPage } from "./http-probes";
import { developmentProbeOptions, firstPageProbeOptions } from "./probe-options";
import { collectSensitiveEnvValues, createLogger, openLogsDirectory, toLogFields } from "./logger";
import type { LogFn } from "./backend-supervisor";
import { installApplicationMenu } from "./menu";
import { installSessionGuards } from "./navigation";
import { QuitCoordinator } from "./quit-coordinator";
import { WindowManager } from "./window-manager";
import { DESKTOP_ENV } from "../shared/backend-protocol";

const electron = loadElectron();
const { app } = electron;

if (!app.requestSingleInstanceLock()) {
  // A second instance must not start a backend, a dev server or a window.
  app.quit();
} else {
  void bootstrap().catch((error: unknown) => {
    const reason = error instanceof Error ? error.message : String(error);
    try {
      electron.dialog.showErrorBox("Pi Web could not start", reason.slice(0, 2048));
    } catch {
      // Last resort only; the process still exits.
    }
    app.exit(1);
  });
}

/** Electron's packaged resources directory; only reached in a packaged app. */
function packagedResourcesPath(): string {
  const resourcesPath = process.resourcesPath;
  if (typeof resourcesPath !== "string" || resourcesPath.length === 0) {
    throw new Error("process.resourcesPath is unavailable in this Electron build");
  }
  return resourcesPath;
}

/**
 * Adapts Node's `execFile` to the shell's narrow probe contract. Next augments
 * `NodeJS.ProcessEnv` with a required `NODE_ENV`, which a sanitized environment
 * cannot provide, so the boundary supplies the current (or a production) value.
 */
const execFileForProbe: ExecFileLike = (file, args, options, callback) => {
  const env: NodeJS.ProcessEnv = {
    ...options.env,
    NODE_ENV: process.env.NODE_ENV ?? "production",
  };
  execFile(file, [...args], { ...options, env }, (error, stdout) => {
    callback(error, stdout);
  });
};

async function bootstrap(): Promise<void> {
  await app.whenReady();

  const logDirectory = app.getPath("logs");
  const logger = createLogger({
    directory: logDirectory,
    secrets: collectSensitiveEnvValues(process.env),
  });
  const log: LogFn = (level, event, fields) =>
    logger.log(level, event, fields ? toLogFields(fields) : undefined);
  log("info", "app.start", { packaged: app.isPackaged, version: app.getVersion() });

  const guiEnvironment = await resolveGuiEnvironment({
    env: process.env,
    execFile: execFileForProbe,
    logger: {
      warn: (message: string) => log("warn", "environment.probe_fallback", { message }),
    },
  });

  const preloadPath = path.join(__dirname, "..", "preload", "index.js");
  const appPath = app.getAppPath();
  const backendEntry = app.isPackaged
    ? path.join(packagedResourcesPath(), "backend", "desktop", "server", "index.js")
    : path.join(appPath, "dist", "desktop", "server", "index.js");

  const windows = new WindowManager({
    createWindow: (options) => new electron.BrowserWindow(options),
    cookies: electron.session.defaultSession.cookies,
    dialog: electron.dialog,
    log: log,
    preloadPath,
    devTools: !app.isPackaged,
    probeFirstPage: (origin) => probeFirstPage(origin, firstPageProbeOptions(electron.net.fetch)),
    openExternal: (url) => {
      electron.shell.openExternal(url).catch((error: unknown) => {
        log("warn", "app.open_external_failed", {
          reason: error instanceof Error ? error.message : String(error),
        });
      });
    },
    onLastWindowCloseRequest: (event) => controller.handleLastWindowClose(event),
  });

  installSessionGuards(electron.session.defaultSession, { origin: () => windows.currentOrigin, log: log });

  const backendEnvironment = (): Record<string, string> => ({
    ...guiEnvironment,
    [DESKTOP_ENV.mode]: "1",
    [DESKTOP_ENV.logDir]: logDirectory,
  });

  const supervisor = app.isPackaged
    ? new BackendSupervisor({
        entry: backendEntry,
        serviceName: "Pi Web Backend",
        spawnUtility: ({ entry, serviceName, env }) =>
          electron.utilityProcess.fork(entry, [], {
            cwd: path.dirname(entry),
            env,
            serviceName,
            stdio: "pipe",
          }),
        environment: backendEnvironment,
        log: log,
        onSecret: (secret) => logger.addSecret(secret),
        onFailed: (failure) => void controller.reportFailure(failure),
        onOutput: (stream, text) => log("info", `backend.${stream}`, { text }),
      })
    : null;

  const development = app.isPackaged
    ? null
    : new DevelopmentServer({
        log: log,
        probe: async () => {
          const result = await probeDevelopmentServer(DEV_ORIGIN, developmentProbeOptions(electron.net.fetch));
          return { reachable: result.reachable, isPiWeb: result.isPiWeb };
        },
        spawn: (spec) => {
          // Next requires NODE_ENV; this branch only ever starts the dev server.
          const env: NodeJS.ProcessEnv = { ...spec.options.env, NODE_ENV: "development" };
          return spawn(spec.command, [...spec.args], {
            cwd: spec.options.cwd,
            env,
            shell: false,
            stdio: spec.options.stdio,
          });
        },
        cwd: appPath,
        environment: () => guiEnvironment,
        onOutput: (stream, text) => log("info", `dev.${stream}`, { text }),
      });

  const quit = new QuitCoordinator({
    readActivity: () => controller.readActivity(),
    prompt: (activity, surface) => windows.showQuitPrompt(activity, surface),
    surface: () => controller.surface(),
    cleanup: () => controller.cleanup(),
    quit: () => app.quit(),
    log: log,
  });

  const readActivity = () => {
    if (!app.isPackaged) {
      return fetchActivity(DEV_ORIGIN, { fetch: electron.net.fetch });
    }
    const origin = windows.currentOrigin;
    if (!origin) {
      return Promise.resolve({
        activity: "unknown" as const,
        running: 0,
        subagentsActive: 0,
        awaitingInput: 0,
      });
    }
    return fetchActivity(origin, { fetch: electron.net.fetch });
  };

  const controller: AppController = new AppController({
    mode: app.isPackaged ? "production" : "development",
    log: log,
    windows,
    supervisor,
    development,
    readActivity,
    quit,
    openLogs: () => openLogsDirectory(logDirectory, (target) => electron.shell.openPath(target)),
  });

  installApplicationMenu({
    Menu: electron.Menu,
    appName: "Pi Web",
    isMac: process.platform === "darwin",
    devTools: !app.isPackaged,
    actions: {
      "retry-backend": () => void controller.retryBackend(),
      "open-logs": () => void controller.openLogs(),
      reload: () => controller.reload(),
    },
  });

  app.on("second-instance", () => {
    controller.activate();
    windows.focusMainWindow();
  });

  app.on("activate", () => {
    controller.activate();
  });

  app.on("before-quit", (event: { preventDefault(): void }) => {
    if (controller.isQuitApproved) return;
    event.preventDefault();
    void controller.requestQuit({ interactive: true, reason: "app-quit" });
  });

  app.on("window-all-closed", () => {
    if (controller.isQuitApproved) return;
    void controller.requestQuit({ interactive: true, reason: "window-close" });
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      log("info", "app.signal", { signal });
      void controller.requestQuit({ interactive: false, reason: "signal" });
    });
  }

  // A blank native window appears immediately; no page loads until ready.
  windows.ensureMainWindow();
  await controller.start();
}
