import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * The hook only needs `useState` and `useEffect`, and this suite drives the
 * component's render passes itself, so a tiny stand-in replaces React and keeps
 * its hook slots on `globalThis` where the harness can reach them.
 */
const shimPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-hook-")), "react-shim.mjs");
fs.writeFileSync(shimPath, `
const H = () => (globalThis.__hookHarness ??= {
  index: 0,
  slots: new Map(),
  effects: new Map(),
  pending: [],
  rerender: null,
});

export function useState(initial) {
  const h = H();
  const slot = h.index++;
  if (!h.slots.has(slot)) h.slots.set(slot, typeof initial === "function" ? initial() : initial);
  const set = (value) => {
    const previous = h.slots.get(slot);
    const next = typeof value === "function" ? value(previous) : value;
    if (Object.is(next, previous)) return;
    h.slots.set(slot, next);
    // React ignores an update after unmount; the harness does the same.
    if (!h.rerender) return;
    h.rerender();
  };
  return [h.slots.get(slot), set];
}

export function useEffect(setup, deps) {
  const h = H();
  const slot = h.index++;
  const previous = h.effects.get(slot);
  const same = previous && deps && previous.deps
    && deps.length === previous.deps.length
    && deps.every((entry, i) => Object.is(entry, previous.deps[i]));
  if (same) return;
  if (previous) {
    previous.cleanup?.();
    h.effects.set(slot, { deps, cleanup: undefined });
  }
  h.pending.push({ slot, deps, setup });
}

export default { useState, useEffect };
`);

const jiti = createJiti(import.meta.url, { tsconfigPaths: true, alias: { react: shimPath } });
const { useBackgroundTaskList, readBackgroundTaskDetails } = await jiti.import("./useBackgroundTaskList.ts");
const { BACKGROUND_TASK_POLL_MS } = await jiti.import("../lib/background-task-host-types.ts");

const harness = globalThis.__hookHarness ?? (globalThis.__hookHarness = {
  index: 0,
  slots: new Map(),
  effects: new Map(),
  pending: [],
  rerender: null,
});

function render(run) {
  // Installed for the whole life of the render, effects included: a read that
  // lands later must still be able to set state.
  harness.rerender = () => render(run);
  harness.index = 0;
  harness.pending = [];
  const result = run();
  for (const pending of harness.pending.splice(0)) {
    const cleanup = pending.setup();
    harness.effects.set(pending.slot, { deps: pending.deps, cleanup });
  }
  return result;
}

function unmount() {
  harness.rerender = null;
  for (const effect of harness.effects.values()) effect.cleanup?.();
  harness.effects.clear();
  harness.slots.clear();
  harness.index = 0;
}

const flush = async () => {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
};

/** Timers and the page, both driven by the test. */
const timers = [];
const page = {
  visibilityState: "visible",
  listeners: new Set(),
  addEventListener(_type, fn) {
    this.listeners.add(fn);
  },
  removeEventListener(_type, fn) {
    this.listeners.delete(fn);
  },
  setVisibility(next) {
    this.visibilityState = next;
    if (next === "visible") for (const fn of [...this.listeners]) fn();
  },
};

function installEnvironment(responses) {
  timers.length = 0;
  // Every test starts on a fresh component.
  harness.slots.clear();
  harness.effects.clear();
  harness.pending = [];
  harness.index = 0;
  harness.rerender = null;
  page.visibilityState = "visible";
  page.listeners.clear();
  const calls = [];
  const queue = [...responses];
  const nextResponse = () => (typeof queue[0] === "function" ? queue.shift()() : queue.shift());

  globalThis.document = page;
  globalThis.setInterval = (fn, ms) => {
    const timer = { fn, ms, repeating: true, cleared: false };
    timers.push(timer);
    return timer;
  };
  globalThis.clearInterval = (timer) => {
    if (timer) timer.cleared = true;
  };
  globalThis.setTimeout = (fn, ms) => {
    const timer = { fn, ms, repeating: false, cleared: false };
    timers.push(timer);
    return timer;
  };
  globalThis.clearTimeout = (timer) => {
    if (timer) timer.cleared = true;
  };
  globalThis.fetch = (url, init) => {
    const call = { url, init, aborted: false };
    calls.push(call);
    return new Promise((resolve, reject) => {
      init?.signal?.addEventListener?.("abort", () => {
        call.aborted = true;
        reject(new DOMException("aborted", "AbortError"));
      });
      resolve(nextResponse());
    });
  };
  return { calls, timers };
}

/** Fire the timers a waiting test expects, then let the promise chain settle. */
async function tick(ms) {
  for (const timer of timers.filter((entry) => !entry.cleared && entry.ms <= ms)) {
    if (!timer.repeating) timer.cleared = true;
    timer.fn();
  }
  await flush();
}

const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const task = (id, status = "running") => ({
  id,
  name: `task ${id}`,
  status,
  startTime: 1_000,
  bytesWritten: 0,
});

const overlayBody = (tasks, overrides) => ({
  available: true,
  revision: 1,
  observedAt: 1_000,
  counts: { total: tasks.length, running: tasks.length, completed: 0, failed: 0, killed: 0 },
  tasks,
  hasMore: false,
  ...overrides,
});

test("no session means no request and no panel", async () => {
  const { calls } = installEnvironment([jsonResponse(overlayBody([]))]);
  const seen = [];
  render(() => seen.push(useBackgroundTaskList(undefined, true)));
  await flush();
  unmount();

  assert.equal(calls.length, 0);
  assert.equal(seen.at(-1), null);
});

test("a session reads once, then on the poll interval while the page is visible", async () => {
  const { calls } = installEnvironment([
    jsonResponse(overlayBody([task("a")])),
    jsonResponse(overlayBody([task("b", "completed")])),
    jsonResponse(overlayBody([task("c", "failed")])),
  ]);
  let data;
  render(() => {
    data = useBackgroundTaskList("session-1", true);
    return data;
  });
  await flush();

  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.endsWith("/api/agent/session-1/background-tasks"));
  assert.equal(calls[0].init.cache, "no-store");
  assert.equal(data.tasks[0].id, "a");
  assert.equal(BACKGROUND_TASK_POLL_MS, 2000);

  const interval = timers.find((timer) => timer.repeating);
  assert.equal(interval.ms, BACKGROUND_TASK_POLL_MS);

  // Hidden pages skip the poll.
  page.visibilityState = "hidden";
  await tick(BACKGROUND_TASK_POLL_MS);
  assert.equal(calls.length, 1);

  page.visibilityState = "visible";
  await tick(BACKGROUND_TASK_POLL_MS);
  assert.equal(calls.length, 2);
  assert.equal(data.tasks[0].id, "b");

  // Coming back to the tab refreshes after the short resume wait.
  page.setVisibility("hidden");
  page.setVisibility("visible");
  await tick(400);
  assert.equal(calls.length, 3);
  assert.equal(data.tasks[0].id, "c");
  unmount();
});

test("one read at a time: a slow answer does not stack requests", async () => {
  let release;
  const slow = new Promise((resolve) => {
    release = resolve;
  });
  const { calls } = installEnvironment([
    () => slow,
    jsonResponse(overlayBody([task("late")])),
  ]);
  render(() => useBackgroundTaskList("session-1", true));
  await flush();
  assert.equal(calls.length, 1);

  // The interval and the resume path both fire while the first read is pending.
  page.setVisibility("hidden");
  page.setVisibility("visible");
  await tick(400);
  await tick(BACKGROUND_TASK_POLL_MS);
  assert.equal(calls.length, 1);

  release(jsonResponse(overlayBody([task("first")])));
  await flush();
  await tick(BACKGROUND_TASK_POLL_MS);
  assert.equal(calls.length, 2);
  unmount();
});

test("an absent host, a failure and an empty list read as no details", async () => {
  for (const response of [
    jsonResponse({ available: false, reason: "host-unavailable" }),
    jsonResponse({ nope: true }),
    jsonResponse(overlayBody([]), 500),
    jsonResponse(overlayBody([task("a")]), 404),
  ]) {
    const { calls } = installEnvironment([response]);
    let data = "unset";
    render(() => {
      data = useBackgroundTaskList("session-1", false);
      return data;
    });
    await flush();
    assert.equal(calls.length, 1);
    assert.equal(data, null);
    unmount();
  }
});

test("an empty list still shows while the extension's summary does", async () => {
  const { calls } = installEnvironment([
    jsonResponse(overlayBody([], { counts: { total: 0, running: 0, completed: 0, failed: 0, killed: 0 } })),
    jsonResponse(overlayBody([])),
  ]);
  let data;
  render(() => {
    data = useBackgroundTaskList("session-1", true);
    return data;
  });
  await flush();
  assert.equal(calls.length, 1);
  assert.deepEqual(data.tasks, []);
  unmount();
});

test("a thrown read is swallowed, and the next poll recovers", async () => {
  const { calls } = installEnvironment([
    () => Promise.reject(new TypeError("network down")),
    jsonResponse(overlayBody([task("a")])),
  ]);
  let data;
  render(() => {
    data = useBackgroundTaskList("session-1", true);
    return data;
  });
  await flush();
  assert.equal(data, null);

  await tick(BACKGROUND_TASK_POLL_MS);
  assert.equal(calls.length, 2);
  assert.equal(data.tasks[0].id, "a");
  unmount();
});

test("unmount stops the interval, the listener and the request in flight", async () => {
  const { calls } = installEnvironment([() => new Promise(() => {})]);
  render(() => useBackgroundTaskList("session-1", true));
  await flush();
  assert.equal(page.listeners.size, 1);

  unmount();
  await flush();

  assert.equal(page.listeners.size, 0);
  assert.equal(timers.every((timer) => timer.cleared), true);
  assert.equal(calls[0].aborted, true);
});

test("a different session or summary flag re-reads immediately", async () => {
  const { calls } = installEnvironment([
    jsonResponse(overlayBody([task("a")])),
    jsonResponse(overlayBody([task("b")])),
    jsonResponse(overlayBody([task("c")])),
  ]);
  let session = "session-1";
  let summary = false;
  let data;
  render(() => {
    data = useBackgroundTaskList(session, summary);
    return data;
  });
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.includes("session-1"), true);

  session = "session-2";
  render(() => {
    data = useBackgroundTaskList(session, summary);
    return data;
  });
  await flush();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url.includes("session-2"), true);

  summary = true;
  render(() => {
    data = useBackgroundTaskList(session, summary);
    return data;
  });
  await flush();
  assert.equal(calls.length, 3);
  assert.equal(data.tasks[0].id, "c");
  unmount();
});

test("readBackgroundTaskDetails answers in its documented shape", async () => {
  const { calls } = installEnvironment([
    jsonResponse(overlayBody([task("a")], { hasMore: true })),
    jsonResponse({ available: false, reason: "timeout" }),
    jsonResponse(overlayBody([])),
    jsonResponse(overlayBody([])),
  ]);

  const details = await readBackgroundTaskDetails("session-1", false);
  assert.equal(details.tasks.length, 1);
  assert.equal(details.hasMore, true);
  assert.equal(calls[0].url, "/api/agent/session-1/background-tasks");

  assert.equal(await readBackgroundTaskDetails("session-1", false), null);
  // Empty and without a summary: nothing to show.
  assert.equal(await readBackgroundTaskDetails("session-1", false), null);
  // Empty but the summary exists: the panel stays.
  assert.deepEqual((await readBackgroundTaskDetails("session-1", true)).tasks, []);
});
