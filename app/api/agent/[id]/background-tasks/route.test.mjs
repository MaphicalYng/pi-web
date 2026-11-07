import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

// One module graph for the route and its dependencies: the alias resolves the
// same `@/lib/...` ids the route imports, so `instanceof` checks keep working.
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const { GET } = await jiti.import("./route.ts");
const { BackgroundTaskHostError } = await jiti.import("@/lib/background-task-host-client");

class FakeClient {
  constructor(result) {
    this.result = result;
    this.calls = 0;
  }

  async listTasks() {
    this.calls += 1;
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }
}

function register(id, wrapper) {
  const registry = new Map(globalThis.__piSessions ?? []);
  registry.set(id, wrapper);
  globalThis.__piSessions = registry;
}

const get = (id) => GET(new Request(`http://localhost/api/agent/${id}/background-tasks`), {
  params: Promise.resolve({ id }),
});

const hostResult = (overrides) => ({
  activationId: "act-1",
  sessionId: "session-1",
  revision: 7,
  observedAt: 5_000,
  counts: { total: 2, running: 1, completed: 1, failed: 0, killed: 0 },
  tasks: [
    {
      kind: "shell",
      seen: false,
      task: {
        id: "t1",
        name: "build",
        status: "running",
        startTime: 1_000,
        bytesWritten: 12,
        command: "node build.js --token super-secret",
        cwd: "/private/project",
        outputPath: "/private/build.log",
        artifactPaths: ["/private/artifact"],
      },
    },
    { task: { id: "t2", status: "completed", startTime: 900, endTime: 1_500, exitCode: 0 } },
  ],
  nextCursor: null,
  ...overrides,
});

test.afterEach(() => {
  delete globalThis.__piSessions;
});

test("an unknown session answers available:false and nothing else", async () => {
  delete globalThis.__piSessions;
  const response = await get("missing");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { available: false });
});

test("a dead or older wrapper gets the same quiet answer", async () => {
  const cases = [
    { isAlive: () => false, getBackgroundTaskHostClient: () => new FakeClient(hostResult({})) },
    { isAlive: () => true },
    { isAlive: () => true, getBackgroundTaskHostClient: () => undefined },
  ];
  for (const wrapper of cases) {
    register("session-1", wrapper);
    const response = await get("session-1");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { available: false });
  }
});

test("a live session returns the panel's own fields, and none of the snapshot's", async () => {
  const client = new FakeClient(hostResult({ nextCursor: "cursor-2" }));
  register("session-1", { isAlive: () => true, getBackgroundTaskHostClient: () => client });

  const response = await get("session-1");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();

  assert.equal(body.available, true);
  assert.equal(body.revision, 7);
  assert.equal(body.observedAt, 5_000);
  assert.deepEqual(body.counts, { total: 2, running: 1, completed: 1, failed: 0, killed: 0 });
  assert.equal(body.hasMore, true);
  assert.deepEqual(body.tasks.map((task) => task.id), ["t1", "t2"]);
  assert.equal(body.tasks[0].name, "build");
  assert.equal(body.tasks[0].bytesWritten, 12);
  assert.equal(body.tasks[1].endTime, 1_500);

  const serialized = JSON.stringify(body);
  for (const secret of ["super-secret", "/private", "artifactPaths", "nextCursor", "activationId"]) {
    assert.equal(serialized.includes(secret), false, secret);
  }
  assert.equal(client.calls, 1);
});

test("an expected host failure is answered without a server error log", async () => {
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args);
  try {
    const client = new FakeClient(new BackgroundTaskHostError("TIMEOUT", "no answer in 750ms"));
    register("session-1", { isAlive: () => true, getBackgroundTaskHostClient: () => client });

    const response = await get("session-1");
    assert.deepEqual(await response.json(), { available: false });
    assert.equal(errors.length, 0);
  } finally {
    console.error = original;
  }
});

test("an unexpected failure still answers, and says so in the log", async () => {
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args);
  try {
    const client = new FakeClient(new Error("boom"));
    register("session-1", { isAlive: () => true, getBackgroundTaskHostClient: () => client });

    const response = await get("session-1");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { available: false });
    assert.equal(errors.length, 1);
    assert.match(String(errors[0][0]), /background task list failed/u);
  } finally {
    console.error = original;
  }
});
