import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  BACKGROUND_TASK_HOST_CHANGED_CHANNEL,
  BACKGROUND_TASK_HOST_CHANGED_SCHEMA,
  BACKGROUND_TASK_HOST_REQUEST_CHANNEL,
  BACKGROUND_TASK_HOST_REQUEST_SCHEMA,
  BACKGROUND_TASK_HOST_RESPONSE_CHANNEL,
  BACKGROUND_TASK_HOST_RESPONSE_SCHEMA,
  BackgroundTaskHostClient,
  BackgroundTaskHostError,
  backgroundTaskDisplayName,
  createBackgroundTaskHostBridge,
  isBackgroundTaskHostUnavailable,
  toBackgroundTaskOverlayData,
} = await jiti.import("./background-task-host-client.ts");
const { BACKGROUND_TASK_LIST_LIMIT } = await jiti.import("./background-task-host-types.ts");

/** The session's public EventBus, as much of it as the adapter uses. */
class FakeBus {
  constructor() {
    this.handlers = new Map();
  }

  on(channel, fn) {
    const set = this.handlers.get(channel) ?? new Set();
    set.add(fn);
    this.handlers.set(channel, set);
    return () => set.delete(fn);
  }

  emit(channel, data) {
    for (const fn of [...(this.handlers.get(channel) ?? [])]) fn(data);
  }

  count(channel) {
    return this.handlers.get(channel)?.size ?? 0;
  }

  total() {
    let total = 0;
    for (const set of this.handlers.values()) total += set.size;
    return total;
  }
}

/** A plugin stand-in: records every frame, answers from `handler` synchronously. */
function serve(bus, handler) {
  const frames = [];
  bus.on(BACKGROUND_TASK_HOST_REQUEST_CHANNEL, (frame) => {
    frames.push(structuredClone(frame));
    const reply = handler(frame);
    if (!reply) return;
    bus.emit(BACKGROUND_TASK_HOST_RESPONSE_CHANNEL, {
      schema_version: BACKGROUND_TASK_HOST_RESPONSE_SCHEMA,
      request_id: frame.request_id,
      operation: frame.operation,
      ...reply,
    });
  });
  return frames;
}

const leaseResult = (leaseId, activationId) => ({ ok: true, result: { leaseId, activationId } });

const task = (overrides) => ({
  task: {
    status: "running",
    startTime: 1_000,
    bytesWritten: 0,
    ...overrides,
  },
});

const listResult = (tasks, overrides) => ({
  ok: true,
  result: {
    activationId: "act-1",
    sessionId: "session-1",
    revision: 4,
    observedAt: 10_000,
    counts: { total: 3, running: 1, completed: 1, failed: 1, killed: 0 },
    tasks,
    nextCursor: null,
    ...overrides,
  },
});

test("subscribes once, then lists with a growing sequence and the page bound", async () => {
  const bus = new FakeBus();
  const frames = serve(bus, (frame) => (frame.operation === "subscribe"
    ? leaseResult("lease-1", "act-1")
    : listResult([])));
  const client = new BackgroundTaskHostClient(bus, { clientId: "pi-web-test" });

  await client.listTasks();
  await client.listTasks();

  assert.equal(frames.length, 3);
  const [subscribe, first, second] = frames;
  assert.equal(subscribe.schema_version, BACKGROUND_TASK_HOST_REQUEST_SCHEMA);
  assert.equal(subscribe.operation, "subscribe");
  assert.deepEqual(subscribe.payload, { clientId: "pi-web-test" });
  assert.equal(typeof subscribe.request_id, "string");

  for (const [frame, sequence] of [[first, 1], [second, 2]]) {
    assert.equal(frame.operation, "list");
    assert.equal(frame.payload.leaseId, "lease-1");
    assert.equal(frame.payload.activationId, "act-1");
    assert.equal(frame.payload.sequence, sequence);
    assert.equal(frame.payload.limit, BACKGROUND_TASK_LIST_LIMIT);
    assert.equal(BACKGROUND_TASK_LIST_LIMIT, 50);
  }

  client.dispose();
});

test("maps a Host result to the browser DTO and never leaks a snapshot field", async () => {
  const bus = new FakeBus();
  serve(bus, (frame) => (frame.operation === "subscribe" ? leaseResult("lease-1", "act-1") : listResult([
    task({
      id: "t1",
      name: "build",
      command: "node secret.js --token abc123",
      cwd: "/private/project",
      outputPath: "/private/out.log",
      artifactPaths: ["/private/artifact"],
      reloadSurvival: true,
      facts: { delegate: "/private/report.md" },
      bytesWritten: 42,
      model: "anthropic/claude-sonnet-4-5",
      contextUsage: { tokens: 10, contextWindow: 100, percent: 10 },
      tokenUsage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 6 },
      toolUsage: { total: 2, failed: 1 },
    }),
    task({ id: "t2", description: "npm test", command: "npm test -- --runInBand", status: "completed", endTime: 1_500 }),
    task({ id: "t3", command: "very long command with many words that should be cut short for the panel", status: "killed" }),
    task({ id: "t4", status: "failed" }),
    // Unknown status, a missing start time, and a non-record: all dropped.
    task({ id: "t5", status: "paused" }),
    task({ id: "t6", startTime: undefined }),
    "junk",
  ], { nextCursor: "cursor-2" })));
  const client = new BackgroundTaskHostClient(bus, { clientId: "pi-web-test" });
  const data = toBackgroundTaskOverlayData(await client.listTasks());
  client.dispose();

  assert.equal(data.available, true);
  assert.equal(data.revision, 4);
  assert.equal(data.observedAt, 10_000);
  assert.deepEqual(data.counts, { total: 3, running: 1, completed: 1, failed: 1, killed: 0 });
  assert.equal(data.hasMore, true);
  assert.deepEqual(data.tasks.map((entry) => entry.id), ["t1", "t2", "t3", "t4"]);
  assert.deepEqual(data.tasks.map((entry) => entry.name), [
    "build",
    // The description wins over the command.
    "npm test",
    // Five words at most, cut to 48 characters.
    "very long command with many",
    // No name, description or command: the id stands in.
    "t4",
  ]);
  assert.equal(data.tasks[0].bytesWritten, 42);
  assert.equal(data.tasks[0].model, "anthropic/claude-sonnet-4-5");
  assert.deepEqual(data.tasks[0].contextUsage, { tokens: 10, contextWindow: 100, percent: 10 });
  assert.deepEqual(data.tasks[0].tokenUsage, { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 6 });
  assert.deepEqual(data.tasks[0].toolUsage, { total: 2, failed: 1 });
  assert.equal(data.tasks[1].endTime, 1_500);

  const serialized = JSON.stringify(data);
  for (const secret of ["secret.js", "abc123", "/private", "artifactPaths", "reloadSurvival", "facts", "cursor-2"]) {
    assert.equal(serialized.includes(secret), false, secret);
  }
});

test("a stale lease is replaced once, and the new list starts at sequence 1", async () => {
  const bus = new FakeBus();
  const leases = ["lease-1", "lease-2"];
  let subscribes = 0;
  let lists = 0;
  const frames = serve(bus, (frame) => {
    if (frame.operation === "subscribe") {
      subscribes += 1;
      return leaseResult(leases[subscribes - 1], "act-1");
    }
    lists += 1;
    if (lists === 1) return { ok: false, error: { code: "LEASE_INVALID", message: "stale lease" } };
    return listResult([task({ id: "t1", name: "build" })]);
  });
  const client = new BackgroundTaskHostClient(bus, { clientId: "pi-web-test" });
  const result = await client.listTasks();
  client.dispose();

  assert.equal(subscribes, 2);
  assert.equal(result.tasks.length, 1);
  const listFrames = frames.filter((frame) => frame.operation === "list");
  assert.equal(listFrames[0].payload.leaseId, "lease-1");
  assert.equal(listFrames[1].payload.leaseId, "lease-2");
  assert.equal(listFrames[1].payload.sequence, 1);
});

test("any other Host error is final, and typed as an expected absence", async () => {
  const bus = new FakeBus();
  let subscribes = 0;
  serve(bus, (frame) => {
    if (frame.operation === "subscribe") {
      subscribes += 1;
      return leaseResult("lease-1", "act-1");
    }
    return { ok: false, error: { code: "FORBIDDEN", message: "not allowed" } };
  });
  const client = new BackgroundTaskHostClient(bus, { clientId: "pi-web-test" });

  await assert.rejects(client.listTasks(), (error) => {
    assert.ok(error instanceof BackgroundTaskHostError);
    assert.equal(error.code, "FORBIDDEN");
    assert.equal(error.message, "not allowed");
    assert.equal(isBackgroundTaskHostUnavailable(error), true);
    return true;
  });
  assert.equal(subscribes, 1);
  client.dispose();
});

test("no plugin installed: the request gives up inside its timeout", async () => {
  const bus = new FakeBus();
  const client = new BackgroundTaskHostClient(bus, { clientId: "pi-web-test", timeoutMs: 20 });

  await assert.rejects(client.listTasks(), (error) => {
    assert.equal(error.code, "TIMEOUT");
    assert.equal(isBackgroundTaskHostUnavailable(error), true);
    return true;
  });
  client.dispose();
});

test("a malformed list result is refused rather than half-read", async () => {
  const bus = new FakeBus();
  serve(bus, (frame) => (frame.operation === "subscribe"
    ? leaseResult("lease-1", "act-1")
    : { ok: true, result: { tasks: "not-an-array" } }));
  const client = new BackgroundTaskHostClient(bus, { clientId: "pi-web-test" });

  await assert.rejects(client.listTasks(), (error) => error.code === "MALFORMED");
  client.dispose();
});

test("a stray response is ignored and the real one still answers", async () => {
  const bus = new FakeBus();
  const frames = serve(bus, (frame) => (frame.operation === "subscribe"
    ? leaseResult("lease-1", "act-1")
    : listResult([task({ id: "t1", name: "build" })])));
  const client = new BackgroundTaskHostClient(bus, { clientId: "pi-web-test" });
  let injecting = false;
  bus.on(BACKGROUND_TASK_HOST_RESPONSE_CHANNEL, (data) => {
    if (injecting || !data) return;
    injecting = true;
    try {
      // Before the client sees the real answer, strangers arrive.
      bus.emit(BACKGROUND_TASK_HOST_RESPONSE_CHANNEL, { ...data, request_id: "unknown" });
      bus.emit(BACKGROUND_TASK_HOST_RESPONSE_CHANNEL, { ...data, operation: "subscribe" });
      bus.emit(BACKGROUND_TASK_HOST_RESPONSE_CHANNEL, { ...data, schema_version: "v0" });
      bus.emit(BACKGROUND_TASK_HOST_RESPONSE_CHANNEL, null);
    } finally {
      injecting = false;
    }
  });

  const result = await client.listTasks();
  assert.equal(result.tasks.length, 1);
  assert.equal(frames.length, 2);
  client.dispose();
});

test("dispose releases the lease, drops the listeners and ends later calls", async () => {
  const bus = new FakeBus();
  const frames = serve(bus, (frame) => (frame.operation === "subscribe" ? leaseResult("lease-1", "act-1") : listResult([])));
  const client = new BackgroundTaskHostClient(bus, { clientId: "pi-web-test" });
  await client.listTasks();
  client.dispose();
  client.dispose();

  const releases = frames.filter((frame) => frame.operation === "unsubscribe");
  assert.equal(releases.length, 1);
  assert.equal(releases[0].schema_version, BACKGROUND_TASK_HOST_REQUEST_SCHEMA);
  assert.equal(releases[0].payload.leaseId, "lease-1");
  assert.equal(releases[0].payload.activationId, "act-1");
  // One list made the lease's sequence 1; the release is the next number.
  assert.equal(releases[0].payload.sequence, 2);
  // Only the adapter's own listeners are gone; the stand-in host keeps its own.
  assert.equal(bus.count(BACKGROUND_TASK_HOST_RESPONSE_CHANNEL), 0);
  assert.equal(bus.count(BACKGROUND_TASK_HOST_CHANGED_CHANNEL), 0);

  await assert.rejects(client.listTasks(), (error) => {
    assert.equal(error.code, "UNAVAILABLE");
    assert.match(error.message, /disposed/u);
    assert.equal(isBackgroundTaskHostUnavailable(error), true);
    return true;
  });
});

test("a closed or reactivated channel makes the next call subscribe again", async () => {
  const bus = new FakeBus();
  let subscribes = 0;
  serve(bus, (frame) => {
    if (frame.operation !== "subscribe") return listResult([]);
    subscribes += 1;
    return leaseResult(`lease-${subscribes}`, `act-${subscribes}`);
  });
  const client = new BackgroundTaskHostClient(bus, { clientId: "pi-web-test" });

  await client.listTasks();
  bus.emit(BACKGROUND_TASK_HOST_CHANGED_CHANNEL, {
    schema_version: BACKGROUND_TASK_HOST_CHANGED_SCHEMA,
    kind: "closed",
    activationId: "act-1",
  });
  await client.listTasks();
  assert.equal(subscribes, 2);

  // A frame from another activation is the same signal.
  bus.emit(BACKGROUND_TASK_HOST_CHANGED_CHANNEL, {
    schema_version: BACKGROUND_TASK_HOST_CHANGED_SCHEMA,
    kind: "tasks-changed",
    activationId: "act-somewhere-else",
  });
  await client.listTasks();
  assert.equal(subscribes, 3);
  client.dispose();
});

test("the display name falls back in order and never carries a whole command", () => {
  assert.equal(backgroundTaskDisplayName({ name: " build ", description: "npm test", command: "npm test" }), "build");
  assert.equal(backgroundTaskDisplayName({ description: "npm test", command: "npm test" }), "npm test");
  assert.equal(backgroundTaskDisplayName({ command: "npm test -- --runInBand" }), "npm test -- --runInBand");
  assert.equal(backgroundTaskDisplayName({ id: "task-9" }), "task-9");
  assert.equal(backgroundTaskDisplayName({}), "后台任务");

  const long = "a".repeat(80);
  const name = backgroundTaskDisplayName({ command: `${long} b c d e` });
  assert.equal(name.length, 48);
  assert.ok(name.endsWith("…"));
});

test("the bridge hands out the client of the load in progress, and forgets it on dispose", () => {
  const bridge = createBackgroundTaskHostBridge();
  assert.equal(bridge.extension.name, "pi-web-background-task-host");
  assert.equal(bridge.extension.hidden, true);
  assert.equal(bridge.extension.builtin, undefined);
  assert.equal(bridge.getClient(), undefined);

  const bus = new FakeBus();
  bridge.extension.factory({ events: bus }, { cwd: "/tmp" });
  const client = bridge.getClient();
  assert.ok(client instanceof BackgroundTaskHostClient);
  assert.equal(bus.total(), 2);

  // Loading again replaces the previous client, listening on the new bus.
  const nextBus = new FakeBus();
  bridge.extension.factory({ events: nextBus }, { cwd: "/tmp" });
  assert.notEqual(bridge.getClient(), client);
  assert.equal(nextBus.total(), 2);

  bridge.dispose();
  assert.equal(bridge.getClient(), undefined);
  assert.equal(nextBus.total(), 0);

  // A session without an EventBus registers nothing and still has no client.
  const empty = createBackgroundTaskHostBridge();
  empty.extension.factory({}, { cwd: "/tmp" });
  assert.equal(empty.getClient(), undefined);
  empty.dispose();
});
