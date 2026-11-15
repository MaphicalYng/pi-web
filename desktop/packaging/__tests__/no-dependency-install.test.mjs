import assert from "node:assert/strict";
import { test } from "node:test";

import beforeBuild from "../no-dependency-install.mjs";

test("beforeBuild returns false — node_modules handled outside electron-builder", async () => {
  // False is the contract: it skips install/rebuild AND disables the
  // node-module collection that would pack the repo root tree into the asar.
  assert.equal(await beforeBuild({ appDir: "/unused", electronVersion: "0", platform: "mac", arch: 0 }), false);
});
