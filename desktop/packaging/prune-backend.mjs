// SIZE-1B: precise backend pruning.
//
// Deletes files the packaged backend never loads, from
// `<backendRoot>/next-standalone/node_modules` only. Rules are exact
// name/suffix matches (plan: 按文件名/目录名精确匹配，不用模糊包含):
//
//   files   *.map                              -> delete
//   files   *.d.ts / *.d.mts / *.d.cts          -> delete
//   files   readme.md / changelog.md / history.md (case-insensitive) -> delete
//   dirs    test / tests / __tests__ / example / examples / docs     -> delete
//   dirs    node-pty/prebuilds/* except darwin-arm64                 -> delete
//   files   LICENSE* / LICENCE* / NOTICE*                            -> always keep
//
// Directory-name rules only apply INSIDE a package root (node_modules/<pkg> or
// node_modules/@<scope>/<pkg>), never to the package itself — a package named
// `docs` or `@scope/docs` survives. Symlinks are never followed or deleted.
//
// dropSwc (SIZE-1B §3.1 experiment) additionally removes
// node_modules/@next/swc-darwin-arm64; default off.

import { readdir, lstat, rm, stat } from "node:fs/promises";
import { join } from "node:path";

const DOC_FILE_NAMES = new Set(["readme.md", "changelog.md", "history.md"]);
const PRUNE_DIR_NAMES = new Set(["test", "tests", "__tests__", "example", "examples", "docs"]);
const KEEP_PREFIXES = ["license", "licence", "notice"];

async function fileSize(path) {
  const info = await lstat(path);
  return info.size;
}

function isKeptFileName(name) {
  const lower = name.toLowerCase();
  return KEEP_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

function isPrunedFileName(name) {
  if (isKeptFileName(name)) return false;
  const lower = name.toLowerCase();
  if (lower.endsWith(".map")) return true;
  if (lower.endsWith(".d.ts") || lower.endsWith(".d.mts") || lower.endsWith(".d.cts")) return true;
  return DOC_FILE_NAMES.has(lower);
}

// A directory is name-prunable only strictly inside a package root:
// node_modules/<pkg>/... (segments after 1) or node_modules/@<scope>/<pkg>/...
// (segments after 2). This keeps a package literally named `docs` alive.
function isPackageRootPath(segments) {
  return segments.length === 1 || (segments.length === 2 && segments[0].startsWith("@"));
}

async function measureTree(path) {
  // bytes of a whole tree, symlinks skipped (they are never deleted).
  let bytes = 0;
  let files = 0;
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      const sub = await measureTree(child);
      bytes += sub.bytes;
      files += sub.files;
    } else if (entry.isFile()) {
      bytes += await fileSize(child);
      files += 1;
    }
  }
  return { bytes, files };
}

/**
 * Deletes files the packaged backend never loads. Returns { files, bytes }.
 */
export async function pruneBackend(backendRoot, { dryRun = false, dropSwc = false } = {}) {
  const nodeModulesRoot = join(backendRoot, "next-standalone", "node_modules");
  const totals = { files: 0, bytes: 0 };

  async function deleteTree(path) {
    const measured = await measureTree(path);
    if (!dryRun) await rm(path, { recursive: true, force: true });
    totals.files += measured.files;
    totals.bytes += measured.bytes;
  }

  async function deleteFile(path, size) {
    if (!dryRun) await rm(path, { force: true });
    totals.files += 1;
    totals.bytes += size;
  }

  async function walk(dir, segments) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(dir, entry.name);
      const childSegments = [...segments, entry.name];
      if (entry.isSymbolicLink()) continue; // never follow, never delete
      if (entry.isDirectory()) {
        if (!isPackageRootPath(childSegments) && PRUNE_DIR_NAMES.has(entry.name.toLowerCase())) {
          await deleteTree(path);
          continue;
        }
        // node-pty ships every platform's prebuilds; the bundle needs darwin-arm64 only.
        if (childSegments.length === 3 && childSegments[0] === "node-pty" && childSegments[1] === "prebuilds" && entry.name !== "darwin-arm64") {
          await deleteTree(path);
          continue;
        }
        await walk(path, childSegments);
      } else if (entry.isFile() && isPrunedFileName(entry.name)) {
        await deleteFile(path, await fileSize(path));
      }
    }
  }

  try {
    await stat(nodeModulesRoot);
  } catch {
    return totals;
  }
  await walk(nodeModulesRoot, []);

  if (dropSwc) {
    const swcDir = join(nodeModulesRoot, "@next", "swc-darwin-arm64");
    try {
      await stat(swcDir);
    } catch {
      return totals; // already absent — nothing to do
    }
    await deleteTree(swcDir);
  }
  return totals;
}
