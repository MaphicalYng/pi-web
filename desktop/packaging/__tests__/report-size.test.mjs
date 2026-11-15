import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { directoryBytes, formatBytes, isMapDtsMd, mapDtsMdBytes, selectTop } from "../report-size.mjs";

const tempRoots = [];

async function tempTree() {
  const root = await mkdtemp(join(tmpdir(), "report-size-"));
  tempRoots.push(root);
  return root;
}

after(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

test("directoryBytes sums nested files and counts empty dirs as zero", async () => {
  const root = await tempTree();
  await mkdir(join(root, "a", "b"), { recursive: true });
  await writeFile(join(root, "one.txt"), "12345");
  await writeFile(join(root, "a", "two.txt"), "123");
  await writeFile(join(root, "a", "b", "three.txt"), "12345678");
  assert.equal(await directoryBytes(root), 5 + 3 + 8);
});

test("directoryBytes skips symlinks instead of following them", async () => {
  const root = await tempTree();
  await writeFile(join(root, "real.bin"), Buffer.alloc(1024));
  await mkdir(join(root, "elsewhere"));
  await symlink(join(root, "real.bin"), join(root, "elsewhere", "link.bin"));
  await symlink(root, join(root, "loop"));
  // Only the real file counts; the link and the directory loop add nothing.
  assert.equal(await directoryBytes(root), 1024);
});

test("directoryBytes tolerates a missing root", async () => {
  assert.equal(await directoryBytes(join(await tempTree(), "absent")), 0);
});

test("selectTop sorts by bytes descending with a stable path tie-break", () => {
  const entries = [
    { path: "b", bytes: 10 },
    { path: "a", bytes: 10 },
    { path: "c", bytes: 30 },
    { path: "d", bytes: 5 },
  ];
  assert.deepEqual(
    selectTop(entries, 3).map((entry) => entry.path),
    ["c", "a", "b"],
  );
  // The input array is never mutated.
  assert.deepEqual(
    entries.map((entry) => entry.path),
    ["b", "a", "c", "d"],
  );
});

test("isMapDtsMd matches maps, declarations and doc files but never LICENSE", () => {
  for (const name of ["index.js.map", "types.d.ts", "mod.d.mts", "mod.d.cts", "README.md", "CHANGELOG.md", "History.md"]) {
    assert.equal(isMapDtsMd(name), true, name);
  }
  for (const name of ["index.js", "LICENSE", "LICENSE.md", "NOTICE", "package.json", "readme.txt"]) {
    assert.equal(isMapDtsMd(name), false, name);
  }
});

test("mapDtsMdBytes sums only matching files", async () => {
  const root = await tempTree();
  await writeFile(join(root, "index.js"), "x".repeat(100));
  await writeFile(join(root, "index.js.map"), "x".repeat(50));
  await writeFile(join(root, "types.d.ts"), "x".repeat(20));
  await writeFile(join(root, "README.md"), "x".repeat(10));
  await writeFile(join(root, "LICENSE"), "x".repeat(1000));
  assert.equal(await mapDtsMdBytes(root), 50 + 20 + 10);
});

test("formatBytes scales units", () => {
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(2048), "2.0 KB");
  assert.equal(formatBytes(3 * 1024 * 1024), "3.0 MB");
  assert.equal(formatBytes(1.5 * 1024 * 1024 * 1024), "1.50 GB");
});
