import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "../../preload/index.ts"), "utf8");
const code = source.replace(/\/\*[\s\S]*?\*\//g, "");

test("the preload exposes no capability to the renderer (frozen interface)", () => {
  assert.doesNotMatch(code, /from\s+["']electron["']/);
  assert.doesNotMatch(code, /\bcontextBridge\b/);
  assert.doesNotMatch(code, /\bipcRenderer\b/);
  assert.doesNotMatch(code, /\bwindow\s*\./);
  assert.doesNotMatch(code, /\brequire\s*\(/);
  assert.doesNotMatch(code, /\bprocess\s*\./);
});

test("the preload is a real module file (packaging points BrowserWindow at it)", () => {
  assert.match(source, /export\s*\{\s*\}/);
});
