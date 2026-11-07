import assert from "node:assert/strict";
import { test } from "node:test";

import { QuitCoordinator } from "../quit-coordinator.ts";
import { FakeTimers, deferred, flush } from "./helpers.mjs";

const idle = { activity: "idle", running: 0, awaitingInput: 0, subagentsActive: 0 };
const active = { activity: "active", running: 1, awaitingInput: 0, subagentsActive: 0 };

function makeCoordinator(overrides = {}) {
  const timers = new FakeTimers();
  const logs = [];
  const phases = [];
  const calls = { prompt: 0, cleanup: 0, quit: 0, activity: 0 };
  const prompts = [];
  const coordinator = new QuitCoordinator({
    readActivity: async () => {
      calls.activity += 1;
      return idle;
    },
    prompt: async (activity, surface) => {
      calls.prompt += 1;
      prompts.push({ activity, surface });
      return "cancelled";
    },
    surface: () => "production",
    cleanup: async () => {
      calls.cleanup += 1;
    },
    quit: () => {
      calls.quit += 1;
    },
    log: (level, event, fields) => logs.push({ level, event, fields }),
    onPhaseChange: (phase) => phases.push(phase),
    timers,
    activityTimeoutMs: 3_500,
    cleanupTimeoutMs: 75_000,
    ...overrides,
  });
  return { coordinator, timers, calls, logs, phases, prompts };
}

test("interactive quit with no activity skips the prompt and runs cleanup once", async () => {
  const { coordinator, calls, phases } = makeCoordinator();
  assert.equal(await coordinator.requestQuit({ interactive: true, reason: "window-close" }), "quit");
  assert.equal(calls.prompt, 0);
  assert.equal(calls.cleanup, 1);
  assert.equal(calls.quit, 1);
  assert.equal(coordinator.isApproved, true);
  assert.deepEqual(coordinator.snapshot(), { phase: "approved", approved: true });
  assert.deepEqual(phases, ["checking", "stopping", "approved"]);
});

test("active work prompts with the activity and a cancel keeps the app running", async () => {
  const { coordinator, calls, prompts } = makeCoordinator({
    readActivity: async () => active,
    surface: () => "development-owned",
  });
  assert.equal(await coordinator.requestQuit({ interactive: true, reason: "menu-quit" }), "cancelled");
  assert.equal(calls.prompt, 1);
  assert.deepEqual(prompts[0], { activity: active, surface: "development-owned" });
  assert.equal(calls.cleanup, 0);
  assert.equal(calls.quit, 0);
  assert.deepEqual(coordinator.snapshot(), { phase: "running", approved: false });
});

test("a confirmed prompt runs the bounded cleanup before quitting", async () => {
  const { coordinator, calls } = makeCoordinator({
    readActivity: async () => active,
    prompt: async () => "confirmed",
  });
  assert.equal(await coordinator.requestQuit({ interactive: true }), "quit");
  assert.equal(calls.cleanup, 1);
  assert.equal(calls.quit, 1);
});

test("a prompt failure is a cancel, never a crash", async () => {
  const { coordinator, calls } = makeCoordinator({
    readActivity: async () => active,
    prompt: async () => {
      throw new Error("dialog unavailable");
    },
  });
  assert.equal(await coordinator.requestQuit({ interactive: true }), "cancelled");
  assert.equal(calls.cleanup, 0);
});

test("activity reads fail closed to idle after their timeout and cleanup is bounded", async () => {
  const stuckActivity = deferred();
  const stuckCleanup = deferred();
  const { coordinator, timers, calls, logs } = makeCoordinator({
    readActivity: () => stuckActivity.promise,
    cleanup: () => stuckCleanup.promise,
  });
  const outcome = coordinator.requestQuit({ interactive: false, reason: "fatal" });
  await timers.advance(3_500);
  await timers.advance(75_000);
  assert.equal(await outcome, "quit");
  assert.equal(calls.quit, 1);
  assert.ok(logs.some((entry) => entry.event === "quit.activity_timeout"));
  assert.ok(logs.some((entry) => entry.event === "quit.cleanup_timeout"));
  stuckCleanup.resolve();
});

test("a rejected activity read degrades to unknown and a rejected cleanup still quits", async () => {
  const { coordinator, calls, logs } = makeCoordinator({
    readActivity: async () => {
      throw new Error("backend down");
    },
    cleanup: async () => {
      throw new Error("already gone");
    },
  });
  assert.equal(await coordinator.requestQuit({ interactive: false, reason: "fatal" }), "quit");
  assert.equal(calls.quit, 1);
  assert.ok(logs.some((entry) => entry.level === "warn" && entry.event === "quit.cleanup_failed"));
});

test("concurrent quit requests share one flow and one cleanup", async () => {
  const gate = deferred();
  const { coordinator, calls } = makeCoordinator({
    cleanup: async () => {
      calls.cleanup += 1;
      await gate.promise;
    },
  });
  const first = coordinator.requestQuit({ interactive: true, reason: "window-close" });
  const second = coordinator.requestQuit({ interactive: true, reason: "app-quit" });
  assert.equal(first, second);
  await flush();
  assert.equal(calls.cleanup, 1);
  gate.resolve();
  assert.equal(await first, "quit");
  assert.equal(await coordinator.requestQuit({ interactive: true }), "quit");
  assert.equal(calls.cleanup, 1);
});

test("a cancelled flow clears itself so a later request can prompt again", async () => {
  const { coordinator, calls } = makeCoordinator({ readActivity: async () => active });
  assert.equal(await coordinator.requestQuit({ interactive: true }), "cancelled");
  assert.equal(await coordinator.requestQuit({ interactive: true }), "cancelled");
  assert.equal(calls.prompt, 2);
});

test("a signal preempts an open confirmation and finishes without the dialog", async () => {
  const answer = deferred();
  let prompted = 0;
  const { coordinator, calls, logs } = makeCoordinator({
    readActivity: async () => active,
    prompt: () => {
      prompted += 1;
      return answer.promise;
    },
  });
  const interactive = coordinator.requestQuit({ interactive: true, reason: "window-close" });
  await flush();
  await flush();
  assert.equal(prompted, 1);

  const signal = coordinator.requestQuit({ interactive: false, reason: "signal" });
  assert.equal(signal, interactive);
  assert.equal(await signal, "quit");
  assert.equal(calls.cleanup, 1);
  assert.equal(calls.quit, 1);
  assert.equal(coordinator.isApproved, true);
  assert.ok(logs.some((entry) => entry.event === "quit.preempted"));
  assert.ok(logs.some((entry) => entry.event === "quit.preempted_prompt"));

  // The human's late answer can no longer cancel an approved quit.
  answer.resolve("cancelled");
  await flush();
  assert.equal(coordinator.snapshot().approved, true);
  assert.equal(calls.cleanup, 1);
});

test("a signal during the activity read skips the prompt entirely", async () => {
  const reading = deferred();
  const { coordinator, calls, timers } = makeCoordinator({
    readActivity: () => reading.promise,
  });
  const interactive = coordinator.requestQuit({ interactive: true, reason: "window-close" });
  await flush();
  coordinator.requestQuit({ interactive: false, reason: "signal" });
  await timers.advance(3_500);
  assert.equal(await interactive, "quit");
  assert.equal(calls.prompt, 0);
  assert.equal(calls.cleanup, 1);
  assert.equal(calls.quit, 1);
  reading.resolve(active);
});

test("cleanup stays bounded after a preempted dialog", async () => {
  const answer = deferred();
  const cleanup = deferred();
  const { coordinator, timers, calls } = makeCoordinator({
    readActivity: async () => active,
    prompt: () => answer.promise,
    cleanup: () => {
      calls.cleanup += 1;
      return cleanup.promise;
    },
  });
  const interactive = coordinator.requestQuit({ interactive: true });
  await flush();
  const signal = coordinator.requestQuit({ interactive: false, reason: "signal" });
  await flush();
  await flush();
  await timers.advance(75_000);
  assert.equal(await signal, "quit");
  assert.equal(await interactive, "quit");
  assert.equal(calls.cleanup, 1);
  assert.equal(calls.quit, 1);
  cleanup.resolve();
});

test("two signals after preemption still share one cleanup", async () => {
  const answer = deferred();
  const { coordinator, calls } = makeCoordinator({
    readActivity: async () => active,
    prompt: () => answer.promise,
  });
  const interactive = coordinator.requestQuit({ interactive: true });
  await flush();
  const first = coordinator.requestQuit({ interactive: false, reason: "signal" });
  const second = coordinator.requestQuit({ interactive: false, reason: "signal" });
  assert.equal(first, interactive);
  assert.equal(second, interactive);
  assert.equal(await second, "quit");
  assert.equal(calls.cleanup, 1);
  assert.equal(calls.quit, 1);
});
