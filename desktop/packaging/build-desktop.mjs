#!/usr/bin/env node
// Desktop packaging orchestration.
//
//   1. Next standalone build into an isolated distDir (never `.next`, which the
//      running dev server owns through `.next/dev/lock`).
//   2. Compile the Electron shell (main / preload / server / shared) plus the
//      every compiled `dist/lib` module (shims into `next-standalone/lib`), which
//      is what the backend's lazy `../../lib/*` imports need on shutdown.
//   3. Assemble two trees with the frozen layout:
//        dist/desktop/app      asar source: package.json + main + preload + shared
//        dist/desktop/backend  extraResources, keeps real paths:
//                                backend/desktop/server/index.js
//                                backend/lib/*.js
//                                backend/next-standalone/
//   4. Hand the result to electron-builder.
//
// Flags: --skip-next (reuse an existing distDir), --dir (unpacked .app only,
// no DMG), --skip-pack (stop after staging).

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const distRoot = join(repoRoot, "dist");
const staging = join(distRoot, "desktop");
const nextDistDir = join(staging, "next");
const standaloneRoot = join(nextDistDir, "standalone");
const appDir = join(staging, "app");
const backendDir = join(staging, "backend");

const argv = new Set(process.argv.slice(2));
const skipNext = argv.has("--skip-next");
const skipPack = argv.has("--skip-pack");
const dirOnly = argv.has("--dir");

function log(message) {
  process.stdout.write(`[build-desktop] ${message}\n`);
}

function run(command, args, options = {}) {
  log(`$ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: { ...process.env, ...(options.env ?? {}) },
    stdio: "inherit",
    timeout: options.timeout ?? 30 * 60 * 1000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
  }
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`cannot read JSON at ${relative(repoRoot, path)}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Next standalone output, in a distDir the dev server never touches. */
function buildNext() {
  if (skipNext) {
    log("next build skipped (--skip-next)");
  } else {
    run(process.execPath, [join(repoRoot, "node_modules", "next", "dist", "bin", "next"), "build", "--webpack"], {
      env: {
        PI_WEB_DESKTOP_BUILD: "1",
        PI_WEB_DESKTOP_DIST_DIR: "dist/desktop/next",
        NEXT_TELEMETRY_DISABLED: "1",
      },
    });
  }
  if (!existsSync(join(standaloneRoot, "server.js"))) {
    throw new Error(`no standalone output at ${standaloneRoot}`);
  }
}

/** Runs tsc with extra argv; a non-zero exit is fatal, never a warning. */
function runTsc(extraArgs, label) {
  log(`$ tsc ${extraArgs.join(" ")}`);
  const result = spawnSync(
    process.execPath,
    [join(repoRoot, "node_modules", "typescript", "bin", "tsc"), "--project", join(repoRoot, "desktop", "packaging", "tsconfig.build.json"), ...extraArgs],
    { cwd: repoRoot, stdio: "inherit", timeout: 10 * 60 * 1000 },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${label} failed (tsc exit ${result.status}); the desktop build requires a clean compile`);
  }
}

/** The shell compiles to dist/, so `dist/desktop/server/index.js` sits two levels above dist/lib. */
function compileShell() {
  // Two passes over one source set:
  //  1. the type gate — `moduleResolution: bundler`, the resolution the repo's
  //     own tsconfig uses, so the Web files pulled in transitively
  //     (desktop/server -> lib/rpc-manager -> the pi SDK) typecheck exactly as
  //     they do under the root `tsc --noEmit`. Zero errors required.
  //  2. the emit — the config's CommonJS/node10 output for Electron. `--noCheck`
  //     only because pass 1 already checked the same files; it hides no error
  //     from this build.
  runTsc(["--noEmit", "--module", "esnext", "--moduleResolution", "bundler"], "desktop type check");
  runTsc(["--noCheck"], "desktop emit");

  const emitted = [
    join(staging, "main", "index.js"),
    join(staging, "preload", "index.js"),
    join(staging, "server", "index.js"),
  ].filter((path) => existsSync(path));
  if (emitted.length !== 3) {
    throw new Error(`tsc emitted ${emitted.length}/3 shell entries`);
  }
}

async function copyIfMissing(from, to) {
  if (!existsSync(from) || existsSync(to)) return;
  await cp(from, to, { recursive: true });
}

/** Next does not put `.next/static` or `public` inside `standalone`; the backend serves them. */
async function completeStandalone() {
  await copyIfMissing(join(nextDistDir, ".next", "static"), join(standaloneRoot, ".next", "static"));
  await copyIfMissing(join(repoRoot, "public"), join(standaloneRoot, "public"));
}

/**
 * The trace misses dynamically required packages (pi SDK extension loading,
 * node-pty's spawn helpers, bundled CLIs). Copy every non-dev package from the
 * installed tree so the backend never depends on the checkout.
 */
async function topUpProductionDependencies() {
  const hiddenLock = join(repoRoot, "node_modules", ".package-lock.json");
  if (!existsSync(hiddenLock)) {
    log("no node_modules/.package-lock.json; skipping production dependency top-up");
    return { copied: 0, total: 0 };
  }
  const lock = await readJson(hiddenLock);
  let copied = 0;
  let total = 0;
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    if (!key.startsWith("node_modules/")) continue;
    if (entry.dev || entry.link) continue;
    total += 1;
    const source = join(repoRoot, key);
    if (!existsSync(source)) continue;
    const destination = join(standaloneRoot, key);
    // Merge over Next's traced copy: tracing keeps a package's JS but drops what it
    // loads at runtime (node-pty's prebuilds/ and spawn-helper, for one).
    await mkdir(dirname(destination), { recursive: true });
    await cp(source, destination, { recursive: true, force: true, dereference: true });
    copied += 1;
  }
  log(`production dependencies: ${copied} copied, ${total} production packages in the tree`);
  return { copied, total };
}

async function assembleApp(version) {
  await rm(appDir, { recursive: true, force: true });
  await mkdir(appDir, { recursive: true });
  const manifest = await readJson(join(repoRoot, "desktop", "packaging", "app-package.json"));
  manifest.version = version;
  await writeFile(join(appDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const part of ["main", "preload", "shared"]) {
    await cp(join(staging, part), join(appDir, part), { recursive: true });
  }
}

/**
 * The frozen contract wants `<standalone>/.next`. Next names the build dir after
 * its distDir, so the standalone tree carries it nested; the server files are
 * moved to `.next` and their `distDir`/`appDir` are rewritten to match, exactly
 * the way standalone output describes its own layout.
 */
async function installNextBuildOutput() {
  const destination = join(backendDir, "next-standalone", ".next");
  const destinationRoot = join(backendDir, "next-standalone");
  const nested = join(standaloneRoot, "dist", "desktop", "next");
  const source = existsSync(join(nested, "required-server-files.json")) ? nested : nextDistDir;
  await cp(source, destination, {
    recursive: true,
    dereference: true,
    filter: (entry) => {
      const name = entry.slice(source.length + 1).split("/")[0];
      return name !== "standalone" && name !== "cache" && name !== "dev" && name !== "types";
    },
  });
  await copyIfMissing(join(nextDistDir, "static"), join(destination, "static"));

  const serverFiles = join(destination, "required-server-files.json");
  const files = await readJson(serverFiles);
  files.config = { ...files.config, distDir: ".next" };
  files.appDir = destinationRoot;
  await writeFile(serverFiles, `${JSON.stringify(files)}\n`);
}

async function assembleBackend() {
  await rm(backendDir, { recursive: true, force: true });
  await mkdir(backendDir, { recursive: true });
  await cp(join(staging, "server"), join(backendDir, "desktop", "server"), { recursive: true });
  await cp(join(staging, "shared"), join(backendDir, "desktop", "shared"), { recursive: true });
  await cp(standaloneRoot, join(backendDir, "next-standalone"), { recursive: true, dereference: true });
  await installNextBuildOutput();
  await installBackendLib();
  await addCommonJsConditions();
}

/**
 * The backend runs as CommonJS (`desktop/server/index.js` and its lazy imports),
 * but the pi SDK packages are ESM-only: their `exports["."]` lists `import` and no
 * `require`, so `require("@earendil-works/pi-ai")` from the backend fails with
 * `ERR_PACKAGE_PATH_NOT_EXPORTED`. Electron 45 ships a Node that can `require()`
 * an ESM file (no top-level await in these packages), which is what Pi Web's own
 * compiled modules do; the manifest just has to admit the `require` condition.
 *
 * Adding `require` next to `import` is additive — bundlers, `import` and the
 * standalone server's own resolution are untouched.
 */
async function addCommonJsConditions() {
  const modulesRoot = join(backendDir, "next-standalone", "node_modules");
  if (!existsSync(modulesRoot)) throw new Error("standalone node_modules missing before condition patch");
  const patched = [];
  for (const entry of await readdir(modulesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const names = entry.name.startsWith("@")
      ? (await readdir(join(modulesRoot, entry.name), { withFileTypes: true }))
          .filter((child) => child.isDirectory())
          .map((child) => `${entry.name}/${child.name}`)
      : [entry.name];
    for (const name of names) {
      const manifest = join(modulesRoot, name, "package.json");
      if (!existsSync(manifest)) continue;
      let parsed;
      try {
        parsed = await readJson(manifest);
      } catch {
        continue;
      }
      const map = parsed.exports;
      if (!map || typeof map !== "object") continue;
      const root = map["."] ?? map;
      if (!root || typeof root !== "object" || !root.import || root.require) continue;
      const target = typeof root.import === "string" ? root.import : root.import?.default;
      if (typeof target !== "string") continue;
      root.require = target;
      if (map["."]) map["."] = root;
      await writeFile(manifest, `${JSON.stringify(parsed, null, 2)}\n`);
      patched.push(`${name}@${parsed.version ?? "?"}`);
    }
  }
  if (patched.length === 0) throw new Error("no ESM-only package needed a CommonJS condition");
  log(`commonjs conditions: ${patched.join(", ")}`);
}

/**
 * The backend loads application modules lazily: `desktop/server/lifecycle.ts` does
 * `import("../../lib/rpc-manager")` / `import("../../lib/terminal-manager")` on
 * SIGTERM, so `backend/lib/` must hold those compiled modules or the graceful
 * shutdown silently logs a failure. Those modules also `require("next/server")`
 * and the pi SDK, which only exist at `next-standalone/node_modules`.
 *
 * So: every emitted `dist/lib` module lands inside the standalone tree (its own
 * package resolution root) and `backend/lib/<name>.js` becomes a one-line shim
 * into it. A shim keeps a single module instance (a copy would give two).
 */
async function installBackendLib() {
  const source = join(distRoot, "lib");
  const target = join(backendDir, "next-standalone", "lib");
  await cp(source, target, {
    recursive: true,
    filter: (entry) => !entry.endsWith(".d.ts") && !entry.endsWith(".map") && !entry.includes("__fixtures__"),
  });
  await mkdir(join(backendDir, "lib"), { recursive: true });
  const entries = await readdir(source, { withFileTypes: true });
  const names = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".js")).map((entry) => entry.name);
  if (names.length === 0) throw new Error(`no compiled modules in ${relative(repoRoot, source)}`);
  for (const name of names) {
    await writeFile(
      join(backendDir, "lib", name),
      `// Staged shim: the module itself lives inside the standalone tree, where its\n` +
        `// package imports (next, pi SDK) resolve against next-standalone/node_modules.\n` +
        `module.exports = require("../next-standalone/lib/${name}");\n`,
    );
  }
  log(`backend lib: ${names.length} modules (shims into next-standalone/lib)`);
}

function pack() {
  if (skipPack) {
    log("electron-builder skipped (--skip-pack)");
    return;
  }
  const args = ["--mac", "--arm64"];
  if (dirOnly) args.push("--dir");
  run(join(repoRoot, "node_modules", ".bin", "electron-builder"), args, {
    env: {
      CSC_IDENTITY_AUTO_DISCOVERY: "false",
      ELECTRON_MIRROR: process.env.ELECTRON_MIRROR ?? "https://npmmirror.com/mirrors/electron/",
      ELECTRON_BUILDER_BINARIES_MIRROR:
        process.env.ELECTRON_BUILDER_BINARIES_MIRROR ?? "https://npmmirror.com/mirrors/electron-builder-binaries/",
    },
  });
}

async function main() {
  const version = (await readJson(join(repoRoot, "package.json"))).version;
  log(`Pi Web desktop ${version}`);
  await mkdir(staging, { recursive: true });

  buildNext();
  await completeStandalone();
  await topUpProductionDependencies();
  compileShell();
  await assembleApp(version);
  await assembleBackend();

  const check = [
    join(backendDir, "desktop", "server", "index.js"),
    join(backendDir, "lib", "desktop-auth.js"),
    join(backendDir, "lib", "rpc-manager.js"),
    join(backendDir, "lib", "terminal-manager.js"),
    join(backendDir, "next-standalone", "lib", "rpc-manager.js"),
    join(backendDir, "next-standalone", "lib", "terminal-manager.js"),
    join(backendDir, "next-standalone", ".next"),
    join(backendDir, "next-standalone", "node_modules", "next"),
    join(backendDir, "next-standalone", "package.json"),
    join(appDir, "main", "index.js"),
    join(appDir, "preload", "index.js"),
  ];
  const missing = check.filter((path) => !existsSync(path));
  if (missing.length > 0) {
    throw new Error(`staging incomplete: ${missing.map((path) => relative(repoRoot, path)).join(", ")}`);
  }
  log(`staged ${relative(repoRoot, backendDir)} and ${relative(repoRoot, appDir)}`);

  pack();

  const releaseDir = join(repoRoot, "release");
  if (existsSync(releaseDir)) {
    const entries = await readdir(releaseDir);
    log(`release: ${entries.join(", ")}`);
  }
}

main().catch((error) => {
  process.stderr.write(`[build-desktop] failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
