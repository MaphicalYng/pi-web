import { strictEqual } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyStandaloneConfigEnv } from "../standalone-config.ts";

const KEY = "__NEXT_PRIVATE_STANDALONE_CONFIG";

function withServerDir(manifest, fn) {
  const root = mkdtempSync(join(tmpdir(), "standalone-config-"));
  const previous = process.env[KEY];
  delete process.env[KEY];
  try {
    if (manifest !== undefined) {
      mkdirSync(join(root, ".next"), { recursive: true });
      writeFileSync(join(root, ".next", "required-server-files.json"), typeof manifest === "string" ? manifest : JSON.stringify(manifest));
    }
    fn(root);
  } finally {
    if (previous === undefined) delete process.env[KEY];
    else process.env[KEY] = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

test("sets the staged config as Next's standalone short-circuit", () => {
  withServerDir({ config: { env: { X: "1" }, trailingSlash: false } }, (root) => {
    strictEqual(applyStandaloneConfigEnv(root), true);
    strictEqual(process.env[KEY], JSON.stringify({ env: { X: "1" }, trailingSlash: false }));
  });
});

test("missing manifest leaves the environment untouched", () => {
  withServerDir(undefined, (root) => {
    strictEqual(applyStandaloneConfigEnv(root), false);
    strictEqual(process.env[KEY], undefined);
  });
});

test("malformed manifest leaves the environment untouched", () => {
  withServerDir("{not json", (root) => {
    strictEqual(applyStandaloneConfigEnv(root), false);
    strictEqual(process.env[KEY], undefined);
  });
});

test("manifest without a config object is refused", () => {
  withServerDir({ config: null }, (root) => {
    strictEqual(applyStandaloneConfigEnv(root), false);
    strictEqual(process.env[KEY], undefined);
  });
});

test("an explicit value is never overridden", () => {
  withServerDir({ config: { env: { X: "1" } } }, (root) => {
    process.env[KEY] = JSON.stringify({ env: { X: "2" } });
    strictEqual(applyStandaloneConfigEnv(root), false);
    strictEqual(process.env[KEY], JSON.stringify({ env: { X: "2" } }));
  });
});
