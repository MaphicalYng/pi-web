import assert from "node:assert/strict";
import { test } from "node:test";

import { BackendSupervisor } from "../backend-supervisor.ts";
import { createShutdownMessage, isSessionSecret } from "../../shared/backend-protocol.ts";
import { FakeChild, FakeTimers, flush } from "./helpers.mjs";

const ORIGIN = "http://127.0.0.1:30141";

function makeSupervisor(overrides = {}) {
  const timers = new FakeTimers();
  const children = [];
  const logs = [];
  const failures = [];
  const secrets = [];
  const supervisor = new BackendSupervisor({
    entry: "/app/resources/backend/desktop/server/index.js",
    serviceName: "pi-web-backend",
    spawnUtility: () => {
      const child = new FakeChild({ pid: 4000 + children.length });
      children.push(child);
      return child;
    },
    environment: () => ({ PATH: "/usr/bin" }),
    log: (level, event, fields) => logs.push({ level, event, fields }),
    onSecret: (secret) => secrets.push(secret),
    onFailed: (failure) => failures.push(failure),
    timers,
    now: () => timers.nowMs,
    readyTimeoutMs: 30_000,
    shutdownTimeoutMs: 60_000,
    ...overrides,
  });
  return { supervisor, timers, children, logs, failures, secrets };
}

test("start posts the secret handoff before ready and resolves with origin plus that secret", async () => {
  const { supervisor, children, secrets } = makeSupervisor();
  const readyPromise = supervisor.start();
  assert.equal(supervisor.snapshot().phase, "starting");
  const child = children[0];
  assert.equal(child.messages.length, 1);
  assert.equal(child.messages[0].type, "session");
  assert.equal(isSessionSecret(child.messages[0].session), true);
  assert.deepEqual(secrets, [child.messages[0].session]);

  child.send({ type: "ready", origin: ORIGIN });
  const ready = await readyPromise;
  assert.deepEqual(ready, { origin: ORIGIN, session: child.messages[0].session });
  assert.equal(supervisor.snapshot().phase, "ready");
  assert.equal(supervisor.snapshot().pid, 4000);
  assert.equal(supervisor.snapshot().origin, ORIGIN);
});

test("invalid ready origins and fatal backend messages fail the attempt", async () => {
  const invalid = makeSupervisor();
  const invalidStart = assert.rejects(invalid.supervisor.start(), /invalid loopback origin/);
  invalid.children[0].send({ type: "ready", origin: `https://${ORIGIN.slice(7)}` });
  await invalidStart;
  assert.equal(invalid.supervisor.snapshot().phase, "failed");
  assert.equal(invalid.failures[0].code, null);
  assert.equal(invalid.children[0].killCalls, 1);

  const fatal = makeSupervisor();
  const fatalStart = assert.rejects(fatal.supervisor.start(), /database locked/);
  fatal.children[0].send({ type: "fatal", code: "E_BOOT", message: "database locked" });
  await fatalStart;
  assert.equal(fatal.supervisor.snapshot().phase, "failed");
  assert.equal(fatal.failures[0].code, "E_BOOT");
  assert.equal(fatal.supervisor.snapshot().origin, null);
});

test("a backend that never reports ready fails on the bounded timeout", async () => {
  const { supervisor, timers, children, failures } = makeSupervisor();
  const pending = assert.rejects(supervisor.start(), /did not report ready/);
  await timers.advance(30_000);
  await pending;
  assert.equal(supervisor.snapshot().phase, "failed");
  assert.equal(children[0].killCalls, 1);
  assert.match(failures[0].reason, /did not report ready/);
});

test("a utility spawn error fails immediately without retrying", async () => {
  const { supervisor, failures } = makeSupervisor({
    spawnUtility: () => {
      throw new Error("spawn EACCES");
    },
  });
  await assert.rejects(supervisor.start(), /spawn EACCES/);
  assert.equal(supervisor.snapshot().phase, "failed");
  assert.equal(failures.length, 1);
  assert.equal(supervisor.snapshot().pid, null);
});

test("an unexpected exit before ready fails the attempt", async () => {
  const { supervisor, children } = makeSupervisor();
  const pending = assert.rejects(supervisor.start(), /exited unexpectedly/);
  children[0].exit(1);
  await pending;
  assert.equal(supervisor.snapshot().phase, "failed");
});

test("duplicate ready messages are ignored after the first", async () => {
  const { supervisor, children, logs } = makeSupervisor();
  const pending = supervisor.start();
  children[0].send({ type: "ready", origin: ORIGIN });
  await pending;
  children[0].send({ type: "ready", origin: "http://127.0.0.1:9" });
  assert.equal(supervisor.snapshot().origin, ORIGIN);
  assert.ok(logs.some((entry) => entry.event === "backend.duplicate_ready_ignored"));
});

test("shutdown posts the frozen message, awaits stopped and exit, then reports stopped", async () => {
  const { supervisor, timers, children } = makeSupervisor();
  const pending = supervisor.start();
  children[0].send({ type: "ready", origin: ORIGIN });
  await pending;

  const stopPromise = supervisor.stop();
  assert.deepEqual(children[0].messages[1], createShutdownMessage(60_000));
  children[0].send({ type: "stopped", code: 0 });
  children[0].exit(0);
  await timers.advance(0);
  await stopPromise;
  assert.equal(supervisor.snapshot().phase, "stopped");
  assert.equal(supervisor.snapshot().origin, null);
  await supervisor.stop();
});

test("an unresponsive backend is killed after the shutdown and kill graces", async () => {
  const { supervisor, timers, children, logs } = makeSupervisor();
  const pending = supervisor.start();
  children[0].send({ type: "ready", origin: ORIGIN });
  await pending;

  const stopPromise = supervisor.stop();
  await timers.advance(60_000);
  await timers.advance(2_000);
  assert.equal(children[0].killCalls, 1);
  children[0].exit(null, "SIGKILL");
  await timers.advance(2_000);
  await stopPromise;
  assert.equal(supervisor.snapshot().phase, "stopped");
  assert.ok(logs.some((entry) => entry.event === "backend.stopped_missing"));
});

test("restart stops the old attempt and starts a fresh one with a new secret", async () => {
  const { supervisor, timers, children, secrets } = makeSupervisor();
  const first = supervisor.start();
  children[0].send({ type: "ready", origin: ORIGIN });
  await first;

  const restart = supervisor.restart();
  children[0].send({ type: "stopped", code: 0 });
  children[0].exit(0);
  await timers.advance(0);
  await flush();
  assert.equal(children.length, 2);
  assert.notEqual(children[1].messages[0].session, children[0].messages[0].session);
  children[1].send({ type: "ready", origin: "http://127.0.0.1:30200" });
  const ready = await restart;
  assert.equal(ready.origin, "http://127.0.0.1:30200");
  assert.equal(secrets.length, 2);
  assert.equal(supervisor.snapshot().phase, "ready");
});

test("stale messages from a replaced attempt are ignored", async () => {
  const { supervisor, timers, children, logs } = makeSupervisor();
  const first = supervisor.start();
  children[0].send({ type: "ready", origin: ORIGIN });
  await first;

  const restart = supervisor.restart();
  children[0].send({ type: "stopped", code: 0 });
  children[0].exit(0);
  await timers.advance(0);
  children[1].send({ type: "ready", origin: ORIGIN });
  await restart;

  children[0].send({ type: "ready", origin: "http://127.0.0.1:9" });
  children[0].send({ type: "fatal", code: "OLD", message: "stale" });
  assert.equal(supervisor.snapshot().phase, "ready");
  assert.ok(logs.some((entry) => entry.event === "backend.stale_message_ignored"));
});
