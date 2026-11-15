import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { pruneBackend } from "../prune-backend.mjs";

const roots = [];
async function makeBackend() {
  const root = await mkdtemp(join(tmpdir(), "prune-backend-"));
  roots.push(root);
  return join(root, "backend");
}
after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function write(root, relative, content = "x".repeat(10)) {
  const path = join(root, "next-standalone", "node_modules", relative);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content);
  return path;
}

function exists(root, relative) {
  return existsSync(join(root, "next-standalone", "node_modules", relative));
}

test("file rules delete maps, declarations and doc files; LICENSE always stays", async () => {
  const root = await makeBackend();
  await write(root, "pkg/a.js.map");
  await write(root, "pkg/b.d.ts");
  await write(root, "pkg/c.d.mts");
  await write(root, "pkg/d.d.cts");
  await write(root, "pkg/README.md");
  await write(root, "pkg/CHANGELOG.MD");
  await write(root, "pkg/history.md");
  await write(root, "pkg/LICENSE.d.ts"); // matches a delete rule, must still stay
  await write(root, "pkg/LICENCE-MIT");
  await write(root, "pkg/NOTICE.md");
  await write(root, "pkg/keep.js");

  const result = await pruneBackend(root);

  for (const gone of ["pkg/a.js.map", "pkg/b.d.ts", "pkg/c.d.mts", "pkg/d.d.cts", "pkg/README.md", "pkg/CHANGELOG.MD", "pkg/history.md"]) {
    assert.equal(exists(root, gone), false, `${gone} should be deleted`);
  }
  for (const kept of ["pkg/LICENSE.d.ts", "pkg/LICENCE-MIT", "pkg/NOTICE.md", "pkg/keep.js"]) {
    assert.equal(exists(root, kept), true, `${kept} must be kept`);
  }
  assert.equal(result.files, 7);
  assert.equal(result.bytes, 70);
});

test("directory-name rules only fire inside a package, never on the package root", async () => {
  const root = await makeBackend();
  await write(root, "pkg/test/deep.js");
  await write(root, "pkg/tests/deep.js");
  await write(root, "pkg/__tests__/deep.js");
  await write(root, "pkg/example/deep.js");
  await write(root, "pkg/examples/deep.js");
  await write(root, "pkg/docs/deep.js");
  await write(root, "pkg/sub/nested/docs/deep.js");
  // packages whose NAME matches a prune rule must survive wholesale at the root
  await write(root, "docs/keep.js");
  await write(root, "@scope/docs/keep.js");
  await write(root, "@scope/pkg/docs/deep.js");
  await write(root, "@scope/pkg/keep.js");

  await pruneBackend(root);

  for (const gone of ["pkg/test/deep.js", "pkg/tests/deep.js", "pkg/__tests__/deep.js", "pkg/example/deep.js", "pkg/examples/deep.js", "pkg/docs/deep.js", "pkg/sub/nested/docs/deep.js", "@scope/pkg/docs/deep.js"]) {
    assert.equal(exists(root, gone), false, `${gone} should be deleted`);
  }
  for (const kept of ["docs/keep.js", "@scope/docs/keep.js", "@scope/pkg/keep.js"]) {
    assert.equal(exists(root, kept), true, `${kept} must be kept`);
  }
});

test("node-pty prebuilds keep only darwin-arm64; other packages' prebuilds are untouched", async () => {
  const root = await makeBackend();
  await write(root, "node-pty/prebuilds/darwin-arm64/pty.node");
  await write(root, "node-pty/prebuilds/linux-x64/pty.node");
  await write(root, "node-pty/prebuilds/win32-x64/pty.node");
  await write(root, "other/prebuilds/linux-x64/file.bin");

  await pruneBackend(root);

  assert.equal(exists(root, "node-pty/prebuilds/darwin-arm64/pty.node"), true);
  assert.equal(exists(root, "node-pty/prebuilds/linux-x64/pty.node"), false);
  assert.equal(exists(root, "node-pty/prebuilds/win32-x64/pty.node"), false);
  assert.equal(exists(root, "other/prebuilds/linux-x64/file.bin"), true);
});

test("symlinks are neither followed nor deleted", async () => {
  const root = await makeBackend();
  await write(root, "pkg/keep.js");
  const nm = join(root, "next-standalone", "node_modules");
  await symlink(join(nm, "pkg", "keep.js"), join(nm, "pkg", "link.d.ts")); // delete-rule name, but a symlink
  await symlink(join(nm, "pkg"), join(nm, "pkg", "docs")); // would be delete-rule dir, but a symlink

  await pruneBackend(root);

  assert.equal(exists(root, "pkg/link.d.ts"), true);
  assert.equal(exists(root, "pkg/docs"), true);
});

test("dryRun reports without deleting", async () => {
  const root = await makeBackend();
  await write(root, "pkg/a.js.map");
  await write(root, "pkg/keep.js");

  const result = await pruneBackend(root, { dryRun: true });

  assert.equal(result.files, 1);
  assert.equal(result.bytes, 10);
  assert.equal(exists(root, "pkg/a.js.map"), true, "dryRun must not delete");
});

test("dropSwc removes @next/swc-darwin-arm64 only when asked", async () => {
  const root = await makeBackend();
  await write(root, "@next/swc-darwin-arm64/swc.node");
  await write(root, "pkg/keep.js");

  await pruneBackend(root);
  assert.equal(exists(root, "@next/swc-darwin-arm64/swc.node"), true, "off by default");

  await pruneBackend(root, { dropSwc: true });
  assert.equal(exists(root, "@next/swc-darwin-arm64/swc.node"), false);
  assert.equal(exists(root, "pkg/keep.js"), true);
});

test("missing node_modules root is a no-op", async () => {
  const root = await makeBackend();
  const result = await pruneBackend(root);
  assert.deepEqual(result, { files: 0, bytes: 0 });
});

test("rules only apply under next-standalone/node_modules", async () => {
  const root = await makeBackend();
  const outside = join(root, "lib", "index.d.ts");
  await mkdir(join(root, "lib"), { recursive: true });
  await writeFile(outside, "types");

  await pruneBackend(root);

  assert.equal((await stat(outside)).size, 5);
});
