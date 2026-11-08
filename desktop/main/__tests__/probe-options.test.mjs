import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { DEV_PROBE_TIMEOUT_MS, FIRST_PAGE_TIMEOUT_MS } from "../constants.ts";
import { developmentProbeOptions, firstPageProbeOptions } from "../probe-options.ts";

test("production first page gets the full start-up budget, dev identity stays quick", () => {
  const fetch = () => Promise.reject(new Error("not called"));
  assert.deepEqual(firstPageProbeOptions(fetch), { fetch, timeoutMs: FIRST_PAGE_TIMEOUT_MS });
  assert.deepEqual(developmentProbeOptions(fetch), { fetch, timeoutMs: DEV_PROBE_TIMEOUT_MS });
  assert.equal(FIRST_PAGE_TIMEOUT_MS, 30_000);
  assert.equal(DEV_PROBE_TIMEOUT_MS, 2_000);
  assert.notEqual(firstPageProbeOptions(fetch).timeoutMs, developmentProbeOptions(fetch).timeoutMs);
});

test("the Electron entry wires each surface to its own probe options", () => {
  const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
  assert.match(source, /probeFirstPage\(origin, firstPageProbeOptions\(electron\.net\.fetch\)\)/);
  assert.match(source, /probeDevelopmentServer\(DEV_ORIGIN, developmentProbeOptions\(electron\.net\.fetch\)\)/);
  assert.doesNotMatch(source, /probeFirstPage\([^)]*DEV_PROBE_TIMEOUT_MS/);
});
