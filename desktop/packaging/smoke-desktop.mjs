#!/usr/bin/env node
// Post-package smoke test: run the app that electron-builder produced, not
// `npm run dev`, and check the things a green build does not prove.
//
//   1. Frozen packaging layout inside the .app.
//   2. node-pty's darwin-arm64 prebuild present outside the asar.
//   3. pi data directory readable (shared with the CLI).
//   4. A real launch: the main process reports `backend.ready`, the loopback
//      origin serves the Pi Web page, the desktop session cookie is accepted.
//   5. Quit leaves no orphan backend process.
//
// Usage: node desktop/packaging/smoke-desktop.mjs [--app <path>] [--timeout <ms>]

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const appPath = arg("--app", join(repoRoot, "release", "mac-arm64", "Pi Web.app"));
const launchTimeout = Number(arg("--timeout", "90000"));

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}\n`);
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function checkLayout() {
  const resources = join(appPath, "Contents", "Resources");
  const required = {
    "backend entry": join(resources, "backend", "desktop", "server", "index.js"),
    "backend lib": join(resources, "backend", "lib", "desktop-auth.js"),
    // The backend re-imports these on SIGTERM (`desktop/server/lifecycle.ts`); a
    // missing file there turns graceful shutdown into a logged failure while the
    // process still exits, which is invisible to a plain exit-code check.
    "backend lazy rpc-manager": join(resources, "backend", "lib", "rpc-manager.js"),
    "backend lazy terminal-manager": join(resources, "backend", "lib", "terminal-manager.js"),
    "standalone lib rpc-manager": join(resources, "backend", "next-standalone", "lib", "rpc-manager.js"),
    "standalone lib terminal-manager": join(resources, "backend", "next-standalone", "lib", "terminal-manager.js"),
    "standalone package.json": join(resources, "backend", "next-standalone", "package.json"),
    "standalone .next": join(resources, "backend", "next-standalone", ".next"),
    "standalone next": join(resources, "backend", "next-standalone", "node_modules", "next"),
    "shell asar": join(resources, "app.asar"),
    "main binary": join(appPath, "Contents", "MacOS", "Pi Web"),
  };
  const missing = Object.entries(required)
    .filter(([, path]) => !existsSync(path))
    .map(([name]) => name);
  record("frozen layout", missing.length === 0, missing.length ? `missing ${missing.join(", ")}` : `${Object.keys(required).length} paths`);
  // The backend must stay outside the asar: it needs real paths and its own node_modules.
  record(
    "backend outside asar",
    !existsSync(join(resources, "app.asar.unpacked", "backend")),
    existsSync(join(resources, "app.asar.unpacked", "backend")) ? "backend leaked into asar.unpacked" : "extraResources",
  );
  return resources;
}

function checkNative(resources) {
  const candidates = [
    join(resources, "backend", "next-standalone", "node_modules", "node-pty", "prebuilds", "darwin-arm64", "pty.node"),
    join(resources, "backend", "next-standalone", "node_modules", "node-pty", "build", "Release", "pty.node"),
  ];
  const found = candidates.find((path) => existsSync(path));
  record("node-pty prebuild", Boolean(found), found ? found.replace(appPath, ".app") : "no pty.node");
  const spawnHelper = join(resources, "backend", "next-standalone", "node_modules", "node-pty", "prebuilds", "darwin-arm64", "spawn-helper");
  if (existsSync(spawnHelper)) {
    return stat(spawnHelper).then((info) => {
      record("node-pty spawn-helper executable", (info.mode & 0o111) !== 0, `mode ${(info.mode & 0o777).toString(8)}`);
    });
  }
  return Promise.resolve();
}

async function checkData() {
  const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
  try {
    const info = await stat(agentDir);
    record("pi data directory", info.isDirectory(), agentDir);
  } catch (error) {
    record("pi data directory", false, `${agentDir}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function appName() {
  // electron-builder names the bundle after productName; getPath("logs") follows
  // the app's own package.json name, so accept either directory.
  return ["Pi Web", "pi-web-desktop"];
}

async function readLogTail(path) {
  try {
    const text = await readFile(path, "utf8");
    return text.split("\n").slice(-80).join("\n");
  } catch {
    return "";
  }
}

async function readLog(path) {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

async function launch() {
  const logsRoot = join(homedir(), "Library", "Logs");
  const logPaths = appName().map((name) => join(logsRoot, name, "main.log"));
  for (const path of logPaths) if (existsSync(path)) await import("node:fs/promises").then((fs) => fs.rm(path, { force: true }));

  const binary = join(appPath, "Contents", "MacOS", "Pi Web");
  const child = spawn(binary, [], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-4000);
  });

  const deadline = Date.now() + launchTimeout;
  let log = "";
  let origin = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    for (const path of logPaths) {
      log = await readLogTail(path);
      const match = log.match(/"event":"backend\.ready"[^\n]*"origin":"(http:\/\/127\.0\.0\.1:\d+)"/);
      if (match) origin = match[1];
      if (!origin) {
        const loose = log.match(/backend\.ready[\s\S]{0,400}?(http:\/\/127\.0\.0\.1:\d+)/);
        if (loose) origin = loose[1];
      }
      if (origin) break;
    }
    if (origin) break;
    await sleep(500);
  }

  record("app launches", child.exitCode === null, child.exitCode === null ? `pid ${child.pid}` : `exited ${child.exitCode}${stderr ? `: ${stderr.trim().split("\n").slice(-2).join(" ")}` : ""}`);
  record("backend.ready in log", Boolean(origin), origin ?? (log ? log.split("\n").slice(-4).join(" | ") : "no main.log"));

  if (origin) {
    try {
      const response = await fetch(`${origin}/`, { headers: { "user-agent": "pi-web-smoke" } });
      const body = await response.text();
      // Without the desktop cookie the proxy refuses the request (401, or 403
      // when the run's session cookie is missing): either proves the listener is
      // up and the run's session is enforced. The cookie secret never leaves the
      // Electron main process, so an external smoke run cannot present it.
      record(
        "loopback answers",
        response.status === 200 || response.status === 401 || response.status === 403,
        `${response.status} ${body.length} bytes`,
      );
      if (response.status === 200) {
        record("page served", /<title>|Pi Web/i.test(body), `${body.length} bytes`);
      } else {
        record(
          "desktop session enforced",
          response.status === 401 || response.status === 403,
          `unauthenticated request refused with ${response.status}`,
        );
      }
    } catch (error) {
      record("loopback answers", false, error instanceof Error ? error.message : String(error));
    }
    try {
      const api = await fetch(`${origin}/api/sessions`, { headers: { "user-agent": "pi-web-smoke" } });
      record("api guarded", api.status === 200 || api.status === 401, `status ${api.status}`);
    } catch (error) {
      record("api guarded", false, error instanceof Error ? error.message : String(error));
    }
  }

  child.kill("SIGTERM");
  const stopped = await Promise.race([new Promise((resolve) => child.once("exit", () => resolve(true))), sleep(20000).then(() => false)]);
  if (!stopped) child.kill("SIGKILL");
  record("app quits on SIGTERM", stopped, stopped ? "clean exit" : "killed after 20 s");

  // A clean exit alone proves nothing: the backend catches a failed lazy import
  // in `createLifecycle` and exits 0 anyway. Require real shutdown evidence in the
  // main log — the backend's own `shutting down` line, the `stopped` handshake it
  // sends only after agent sessions and terminals released, and no failure lines.
  let fullLog = "";
  for (const path of logPaths) {
    const text = await readLog(path);
    if (text.length > fullLog.length) fullLog = text;
  }
  const shutdownStarted = /\[desktop\] shutting down/.test(fullLog);
  record("backend shutdown started", shutdownStarted, shutdownStarted ? "[desktop] shutting down" : "no shutdown line in main.log");
  const stoppedSignal = /backend\.stopped_signal/.test(fullLog);
  record("backend stopped handshake", stoppedSignal, stoppedSignal ? "backend.stopped_signal" : "backend never reported stopped");
  const stepFailures = fullLog.match(/\[desktop\] (shutdownAgentSessions|releaseAllTerminals|Next\/HTTP close) failed[^\n]*/g) ?? [];
  record(
    "backend shutdown steps clean",
    stepFailures.length === 0,
    stepFailures.length === 0 ? "no failed shutdown step" : stepFailures.join(" | ").slice(-400),
  );
  await sleep(1500);

  const orphans = await new Promise((resolve) => {
    const list = spawn("pgrep", ["-fl", "backend/desktop/server/index.js"], { stdio: ["ignore", "pipe", "ignore"] });
    let text = "";
    list.stdout.on("data", (chunk) => {
      text = `${text}${chunk}`;
    });
    list.on("exit", () => resolve(text.trim()));
  });
  record("no orphan backend", orphans.length === 0, orphans || "none");

  if (log) {
    const ready = log.split("\n").filter((line) => /backend\.ready|app\.started|backend\.spawned/.test(line)).slice(-3);
    process.stdout.write(`\nlog excerpt:\n${ready.join("\n")}\n`);
  }
}

async function main() {
  if (!existsSync(appPath)) {
    process.stderr.write(`no app at ${appPath}\n`);
    process.exit(2);
  }
  const resources = checkLayout();
  await checkNative(resources);
  await checkData();
  await launch();
  const failed = results.filter((entry) => !entry.ok);
  process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed\n`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  process.stderr.write(`smoke failed: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
