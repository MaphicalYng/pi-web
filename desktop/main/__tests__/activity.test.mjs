import assert from "node:assert/strict";
import { test } from "node:test";

import { countActivityPayload, fetchActivity } from "../activity.ts";
import { FakeTimers, jsonResponse } from "./helpers.mjs";

const ORIGIN = "http://127.0.0.1:30141";

test("activity counts the running route's real field names", () => {
  assert.deepEqual(
    countActivityPayload({
      runningSessionIds: ["a"],
      awaitingInputSessionIds: [],
      subagentsActiveSessionIds: ["b", "c"],
    }),
    { activity: "active", running: 1, subagentsActive: 2, awaitingInput: 0 },
  );
});

test("activity accepts the older short aliases and unions running with subagents", () => {
  assert.deepEqual(
    countActivityPayload({ running: ["only-running"], subagentsActive: [], awaitingInput: ["x"] }),
    { activity: "active", running: 1, subagentsActive: 0, awaitingInput: 1 },
  );
  assert.deepEqual(countActivityPayload({ running: [], subagentsActive: [], awaitingInput: [] }), {
    activity: "idle",
    running: 0,
    subagentsActive: 0,
    awaitingInput: 0,
  });
});

test("anything unexpected is unknown rather than a silent idle", () => {
  for (const payload of [
    null,
    "idle",
    [],
    {},
    { running: "a" },
    { running: [1] },
    { running: [], subagentsActive: [], awaitingInput: ["x", 2] },
    { running: [], subagentsActive: [] },
  ]) {
    assert.equal(countActivityPayload(payload).activity, "unknown", JSON.stringify(payload));
  }
});

test("fetchActivity reads only /api/agent/running with credentials and no cache", async () => {
  let request;
  const snapshot = await fetchActivity(ORIGIN, {
    fetch: async (url, init) => {
      request = { url, init };
      return jsonResponse(200, { runningSessionIds: ["a"], subagentsActiveSessionIds: [], awaitingInputSessionIds: [] });
    },
  });
  assert.equal(request.url, `${ORIGIN}/api/agent/running`);
  assert.equal(request.init.credentials, "include");
  assert.equal(request.init.cache, "no-store");
  assert.equal(snapshot.activity, "active");
});

test("HTTP failures, invalid JSON and network errors fall back to unknown", async () => {
  const notOk = await fetchActivity(ORIGIN, { fetch: async () => jsonResponse(500, {}) });
  assert.equal(notOk.activity, "unknown");

  const badJson = await fetchActivity(ORIGIN, { fetch: async () => jsonResponse(200, "not json") });
  assert.equal(badJson.activity, "unknown");

  const network = await fetchActivity(ORIGIN, {
    fetch: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  assert.equal(network.activity, "unknown");
});

test("fetchActivity aborts at its timeout", async () => {
  const timers = new FakeTimers();
  const pending = fetchActivity(ORIGIN, {
    timer: timers,
    timeoutMs: 3_000,
    fetch: (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted")));
      }),
  });
  await timers.advance(3_000);
  assert.equal((await pending).activity, "unknown");
});
