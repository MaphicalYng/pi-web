import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildDevelopmentSpawn,
  classifyDevelopmentProbe,
  DevelopmentServer,
  DevelopmentStartError,
} from "../development-server.ts";
import { FakeDevChild, FakeTimers, flush } from "./helpers.mjs";

const ORIGIN = "http://127.0.0.1:30141";

function makeServer(overrides = {}) {
  const timers = new FakeTimers();
  const children = [];
  const logs = [];
  const server = new DevelopmentServer({
    origin: ORIGIN,
    log: (level, event, fields) => logs.push({ level, event, fields }),
    probe: async () => ({ reachable: false, isPiWeb: false }),
    spawn: () => {
      const child = new FakeDevChild({ pid: 5000 + children.length });
      children.push(child);
      return child;
    },
    cwd: "/repo",
    environment: () => ({ PATH: "/usr/bin", PORT: "30141" }),
    timers,
    now: () => timers.nowMs,
    healthTimeoutMs: 1_000,
    pollIntervalMs: 250,
    stopGraceMs: 5_000,
    ...overrides,
  });
  return { server, timers, children, logs };
}

test("probe classification maps reachability and identity", () => {
  assert.equal(classifyDevelopmentProbe({ reachable: false, isPiWeb: false }), "absent");
  assert.equal(classifyDevelopmentProbe({ reachable: true, isPiWeb: true }), "attached");
  assert.equal(classifyDevelopmentProbe({ reachable: true, isPiWeb: false }), "occupied");
});

test("the spawn spec is shell-free npm run dev in the repository", () => {
  const spec = buildDevelopmentSpawn("/repo", { PATH: "/usr/bin" });
  assert.equal(spec.command, "npm");
  assert.deepEqual(spec.args, ["run", "dev"]);
  assert.equal(spec.options.cwd, "/repo");
  assert.equal(spec.options.shell, false);
  assert.deepEqual(spec.options.stdio, ["ignore", "pipe", "pipe"]);
  assert.throws(() => buildDevelopmentSpawn("", {}));
});

test("a healthy dev server on 30141 is attached and never spawned", async () => {
  const { server, children } = makeServer({
    probe: async () => ({ reachable: true, isPiWeb: true }),
  });
  assert.equal(await server.ensureStarted(), "attached");
  assert.equal(children.length, 0);
  assert.deepEqual(server.snapshot(), { surface: "attached", pid: null, owned: false, origin: ORIGIN });
  await server.stop();
  assert.equal(server.snapshot().surface, "idle");
});

test("an occupied port refuses with code occupied", async () => {
  const { server, children } = makeServer({
    probe: async () => ({ reachable: true, isPiWeb: false }),
  });
  await assert.rejects(server.ensureStarted(), (error) => error instanceof DevelopmentStartError && error.code === "occupied");
  assert.equal(children.length, 0);
  assert.equal(server.snapshot().surface, "idle");
});

test("a spawned server becomes ready after polling and is owned", async () => {
  let probes = 0;
  const { server, timers, children } = makeServer({
    probe: async () => {
      probes += 1;
      return probes === 1 ? { reachable: false, isPiWeb: false } : { reachable: true, isPiWeb: true };
    },
  });
  const started = server.ensureStarted();
  await timers.advance(250);
  assert.equal(await started, "spawned");
  assert.equal(children.length, 1);
  assert.equal(children[0].killSignals.length, 0);
  assert.deepEqual(server.snapshot(), { surface: "spawned", pid: 5000, owned: true, origin: ORIGIN });
});

test("a server that never turns healthy is stopped and reported not-ready", async () => {
  const { server, timers, children } = makeServer();
  const started = assert.rejects(
    server.ensureStarted(),
    (error) => error instanceof DevelopmentStartError && error.code === "not-ready",
  );
  await flush();
  await timers.advance(1_000);
  await timers.advance(5_000);
  await started;
  assert.deepEqual(children[0].killSignals, ["SIGTERM", "SIGKILL"]);
  assert.equal(server.snapshot().surface, "idle");
});

test("a spawn failure is reported as spawn-failed", async () => {
  const { server } = makeServer({
    spawn: () => {
      throw new Error("ENOENT npm");
    },
  });
  await assert.rejects(server.ensureStarted(), (error) => error instanceof DevelopmentStartError && error.code === "spawn-failed");
});

test("stop terminates an owned child with SIGTERM and waits for its exit", async () => {
  let probes = 0;
  const { server, timers, children } = makeServer({
    probe: async () => {
      probes += 1;
      return probes === 1 ? { reachable: false, isPiWeb: false } : { reachable: true, isPiWeb: true };
    },
  });
  const started = server.ensureStarted();
  await timers.advance(250);
  assert.equal(await started, "spawned");
  const child = children[0];
  child.kill = (signal) => {
    child.killSignals.push(signal);
    if (signal === "SIGTERM") child.exit(0);
    return true;
  };
  await server.stop();
  assert.deepEqual(child.killSignals, ["SIGTERM"]);
  assert.equal(server.snapshot().surface, "idle");
});

test("stop escalates to SIGKILL after the grace and killAllNow reaps leftovers", async () => {
  let probes = 0;
  const { server, timers, children } = makeServer({
    probe: async () => {
      probes += 1;
      return probes === 1 ? { reachable: false, isPiWeb: false } : { reachable: true, isPiWeb: true };
    },
  });
  const started = server.ensureStarted();
  await timers.advance(250);
  await started;
  const child = children[0];
  child.kill = (signal) => {
    child.killSignals.push(signal);
    return true;
  };
  const stop = server.stop();
  await timers.advance(5_000);
  await stop;
  assert.deepEqual(child.killSignals, ["SIGTERM", "SIGKILL"]);

  const second = makeServer({ spawn: () => new FakeDevChild({ pid: 5060 }) });
  second.server.killAllNow();
  assert.equal(second.server.snapshot().surface, "idle");
});
