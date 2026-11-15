#!/usr/bin/env node
// Read-only size report for packaged artifacts (MEASURE-1). It never modifies
// the trees it measures; the JSON report lands in `release/size-report.json`
// and a human table goes to stdout. Baselines live outside the repository —
// copy the JSON somewhere like ~/pi-web-perf/, never commit it.
//
// Usage: node desktop/packaging/report-size.mjs [release-dir-or-.app]

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Recursive byte sum. Symlinks are skipped entirely (never followed): a link
 * into an already-counted tree would otherwise be counted twice.
 */
export async function directoryBytes(root) {
  let total = 0;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        stack.push(path);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        total += (await lstat(path)).size;
      } catch {
        // Vanished between readdir and lstat; skip.
      }
    }
  }
  return total;
}

/** Pure Top-N sort: bytes descending, path ascending as a stable tie-break. */
export function selectTop(entries, n) {
  return [...entries]
    .sort((a, b) => b.bytes - a.bytes || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .slice(0, n);
}

/**
 * Package sizes under a node_modules root: one level, plus `@scope/pkg` two
 * levels. The reported path is the package name (`@scope/pkg`), not a fs path.
 */
export async function packageSizes(nodeModulesRoot) {
  const results = [];
  let top;
  try {
    top = await readdir(nodeModulesRoot, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of top) {
    if (entry.isSymbolicLink()) continue;
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith("@")) {
      let scoped;
      try {
        scoped = await readdir(join(nodeModulesRoot, entry.name), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const child of scoped) {
        if (child.isSymbolicLink()) continue;
        if (!child.isDirectory()) continue;
        const name = `${entry.name}/${child.name}`;
        results.push({ path: name, bytes: await directoryBytes(join(nodeModulesRoot, entry.name, child.name)) });
      }
      continue;
    }
    results.push({ path: entry.name, bytes: await directoryBytes(join(nodeModulesRoot, entry.name)) });
  }
  return results;
}

/**
 * Files SIZE-1B will prune inside the backend's node_modules: source maps,
 * type declarations and README/CHANGELOG/HISTORY docs. LICENSE/NOTICE files
 * are never counted here — they stay in the artifact.
 */
export function isMapDtsMd(name) {
  const lower = name.toLowerCase();
  if (lower.endsWith(".map")) return true;
  if (lower.endsWith(".d.ts") || lower.endsWith(".d.mts") || lower.endsWith(".d.cts")) return true;
  return /^(readme|changelog|history)[^/]*\.md$/.test(lower);
}

/** Recursive sum of `isMapDtsMd` files, symlinks skipped. */
export async function mapDtsMdBytes(root) {
  let total = 0;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        stack.push(path);
        continue;
      }
      if (!entry.isFile() || !isMapDtsMd(entry.name)) continue;
      try {
        total += (await lstat(path)).size;
      } catch {
        // Vanished; skip.
      }
    }
  }
  return total;
}

export function formatBytes(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

/** `git rev-parse --short HEAD`, or "unknown" outside a checkout. */
export function gitCommit(cwd) {
  try {
    const result = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd, encoding: "utf8" });
    if (result.status === 0) return result.stdout.trim();
  } catch {
    // Not fatal: the report just records "unknown".
  }
  return "unknown";
}

/**
 * Collects every field of the size report. `appPath` must be a `.app` bundle;
 * `dmgPath` is optional (a `--dir` build has none).
 */
export async function buildReport({ appPath, dmgPath, version, commit, platform, generatedAt, asarList }) {
  const resources = join(appPath, "Contents", "Resources");
  const asarPath = join(resources, "app.asar");
  const asarUnpackedPath = join(resources, "app.asar.unpacked");
  const backendPath = join(resources, "backend");
  const backendNodeModules = join(backendPath, "next-standalone", "node_modules");

  let asarNodeModulesEntries = 0;
  if (asarList && existsSync(asarPath)) {
    for (const entry of asarList(asarPath)) {
      if (entry.startsWith("/node_modules")) asarNodeModulesEntries += 1;
    }
  }

  return {
    version,
    commit,
    platform,
    generatedAt,
    dmgBytes: dmgPath ? (await lstat(dmgPath)).size : 0,
    appBytes: await directoryBytes(appPath),
    resourcesBytes: await directoryBytes(resources),
    asarBytes: existsSync(asarPath) ? (await lstat(asarPath)).size : 0,
    asarUnpackedBytes: existsSync(asarUnpackedPath) ? await directoryBytes(asarUnpackedPath) : 0,
    asarNodeModulesEntries,
    backendBytes: existsSync(backendPath) ? await directoryBytes(backendPath) : 0,
    backendNodeModulesBytes: existsSync(backendNodeModules) ? await directoryBytes(backendNodeModules) : 0,
    backendMapDtsMdBytes: existsSync(backendNodeModules) ? await mapDtsMdBytes(backendNodeModules) : 0,
    top: existsSync(backendNodeModules) ? selectTop(await packageSizes(backendNodeModules), 20) : [],
  };
}

export function formatReport(report) {
  const rows = [
    ["version", report.version],
    ["commit", report.commit],
    ["platform", report.platform],
    ["generatedAt", report.generatedAt],
    ["DMG", formatBytes(report.dmgBytes)],
    ["App (.app)", formatBytes(report.appBytes)],
    ["Contents/Resources", formatBytes(report.resourcesBytes)],
    ["app.asar", formatBytes(report.asarBytes)],
    ["app.asar.unpacked", formatBytes(report.asarUnpackedBytes)],
    ["asar /node_modules entries", String(report.asarNodeModulesEntries)],
    ["backend", formatBytes(report.backendBytes)],
    ["backend node_modules", formatBytes(report.backendNodeModulesBytes)],
    ["backend .map/.d.ts/.md", formatBytes(report.backendMapDtsMdBytes)],
  ];
  const lines = rows.map(([key, value]) => `  ${key.padEnd(26)} ${value}`);
  if (report.top.length > 0) {
    lines.push("", "  top backend packages:");
    for (const entry of report.top) {
      lines.push(`    ${entry.path.padEnd(48)} ${formatBytes(entry.bytes)}`);
    }
  }
  return lines.join("\n");
}

/** Resolves the `.app` and `.dmg` to measure from a release dir or an explicit `.app`. */
export async function resolveArtifacts(input) {
  const appPath = input.endsWith(".app") ? input : findApp(input);
  if (!appPath) throw new Error(`no .app bundle found under ${input}`);
  const dmgPath = input.endsWith(".app") ? await findDmg(dirname(dirname(input))) : await findDmg(input);
  return { appPath, dmgPath };
}

function findApp(releaseDir) {
  const candidates = [
    join(releaseDir, "mac-arm64", "Pi Web.app"),
    join(releaseDir, "mac", "Pi Web.app"),
    join(releaseDir, "Pi Web.app"),
  ];
  return candidates.find((path) => existsSync(path)) ?? null;
}

async function findDmg(dir) {
  try {
    const found = (await readdir(dir)).filter((name) => name.endsWith(".dmg"));
    return found.length > 0 ? join(dir, found[0]) : null;
  } catch {
    return null;
  }
}

async function main() {
  const input = process.argv[2] ?? join(repoRoot, "release");
  const { appPath, dmgPath } = await resolveArtifacts(input);

  let asarList = null;
  try {
    const asar = await import("@electron/asar");
    asarList = (path) => asar.listPackage(path);
  } catch {
    process.stderr.write("[report-size] @electron/asar unavailable; asarNodeModulesEntries=0\n");
  }

  const manifest = await readJson(join(repoRoot, "package.json"));
  const report = await buildReport({
    appPath,
    dmgPath,
    version: manifest.version,
    commit: gitCommit(repoRoot),
    platform: `${process.platform}-${process.arch}`,
    generatedAt: new Date().toISOString(),
    asarList,
  });

  const outPath = join(repoRoot, "release", "size-report.json");
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${formatReport(report)}\n\n  report: ${outPath}\n`);
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`[report-size] failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
