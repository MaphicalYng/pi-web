import assert from "node:assert/strict";
import { test } from "node:test";

import { probeBehindWindow } from "../startup-order.ts";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("the window is shown before the probe runs and stays shown while it is pending", async () => {
  const events = [];
  const probe = deferred();
  const outcome = probeBehindWindow({
    showWindow: () => events.push("window"),
    resolveEnvironment: () => {
      events.push("probe-start");
      return probe.promise;
    },
    quitStarted: () => false,
  });
  await Promise.resolve();
  assert.deepEqual(events, ["window", "probe-start"]);
  probe.resolve({ PATH: "/usr/bin" });
  assert.equal((await outcome).ok, true);
  assert.deepEqual(events, ["window", "probe-start"]);
});

test("a quit begun during the probe aborts startup before the app starts", async () => {
  const probe = deferred();
  let quit = false;
  const outcome = probeBehindWindow({
    showWindow: () => {},
    resolveEnvironment: () => probe.promise,
    quitStarted: () => quit,
  });
  quit = true;
  probe.resolve({ PATH: "/usr/bin" });
  assert.deepEqual(await outcome, { ok: false });
});

test("the resolved environment (including the probe's fallback) passes through unchanged", async () => {
  const fallback = { PATH: "/fallback/bin" };
  const outcome = await probeBehindWindow({
    showWindow: () => {},
    resolveEnvironment: async () => fallback,
    quitStarted: () => false,
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.environment, fallback);
});

test("a quit that began before the window still aborts", async () => {
  const outcome = await probeBehindWindow({
    showWindow: () => {},
    resolveEnvironment: async () => ({}),
    quitStarted: () => true,
  });
  assert.deepEqual(outcome, { ok: false });
});
