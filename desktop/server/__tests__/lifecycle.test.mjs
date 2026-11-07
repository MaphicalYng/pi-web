import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { createLifecycle } = await jiti.import("../lifecycle.ts");
const { createRedactor } = await jiti.import("../redaction.ts");

function fakeBackend(events) {
  const http = {
    port: 49152,
    guard: { authority: "127.0.0.1:49152", origin: "http://127.0.0.1:49152" },
    close: async () => { events.push("http-close"); },
    destroyConnections: () => { events.push("destroy-connections"); },
    handlers: {
      closeUpgraded: () => { events.push("upgraded-close"); },
      server: { close: async () => { events.push("next-close"); } },
    },
  };
  return http;
}

test("shutdown cleans sessions, terminals, upgrades and the listener, then records exit", async () => {
  const events = [];
  const messages = [];
  const exits = [];
  const redact = createRedactor();
  const lifecycle = createLifecycle({
    http: fakeBackend(events),
    redact,
    send: (message) => { messages.push(message); return true; },
    exit: (code) => exits.push(code),
    timeoutMs: 5_000,
    cleanup: {
      shutdownAgentSessions: async () => { events.push("sessions"); },
      releaseAllTerminals: async () => { events.push("terminals"); },
    },
  });

  assert.equal(lifecycle.isShuttingDown(), false);
  const first = lifecycle.shutdown("test");
  const second = lifecycle.shutdown("duplicate");
  assert.equal(first, second);
  assert.equal(lifecycle.isShuttingDown(), true);
  assert.equal(await first, 0);

  assert.deepEqual(messages, [{ type: "stopped", code: 0 }]);
  assert.deepEqual(exits, [0]);
  assert.ok(events.includes("sessions"));
  assert.ok(events.indexOf("sessions") < events.indexOf("terminals"));
  assert.ok(events.indexOf("terminals") < events.indexOf("upgraded-close"));
  assert.ok(events.includes("destroy-connections"));
});

test("a hung cleanup step is abandoned at its deadline and shutdown still finishes", async () => {
  const events = [];
  const exits = [];
  const redact = createRedactor();
  const lifecycle = createLifecycle({
    http: fakeBackend(events),
    redact,
    send: () => true,
    exit: (code) => exits.push(code),
    timeoutMs: 4,
    cleanup: {
      shutdownAgentSessions: () => new Promise(() => {}),
      releaseAllTerminals: async () => { events.push("terminals"); },
    },
  });
  assert.equal(await lifecycle.shutdown("hung"), 0);
  assert.deepEqual(exits, [0]);
  assert.ok(events.includes("terminals"), "later steps still run after a timed-out step");
});

test("a failing step is reported redacted and does not stop the rest", async () => {
  const events = [];
  const exits = [];
  const logs = [];
  const redact = createRedactor(["super-secret-value"]);
  const originalError = console.error;
  console.error = (...args) => { logs.push(args.join(" ")); };
  const lifecycle = createLifecycle({
    http: fakeBackend(events),
    redact,
    send: () => true,
    exit: (code) => exits.push(code),
    timeoutMs: 2_000,
    cleanup: {
      shutdownAgentSessions: async () => { throw new Error("failed with super-secret-value"); },
      releaseAllTerminals: async () => { events.push("terminals"); },
    },
  });
  try {
    assert.equal(await lifecycle.shutdown("failing"), 0);
  } finally {
    console.error = originalError;
  }
  assert.ok(events.includes("terminals"));
  assert.deepEqual(exits, [0]);
  assert.ok(logs.some((line) => line.includes("[redacted]") && !line.includes("super-secret-value")));
});

test("step deadlines scale with the requested budget", async () => {
  const { shutdownStepMs } = await jiti.import("../lifecycle.ts");
  assert.equal(shutdownStepMs(30_000), 7_500);
  assert.equal(shutdownStepMs(120_000), 30_000);
  assert.equal(shutdownStepMs(60_000), 15_000);
  assert.equal(shutdownStepMs(2_000), 1_000);

  const logs = [];
  const originalError = console.error;
  console.error = (...args) => { logs.push(args.join(" ")); };
  const lifecycle = createLifecycle({
    http: fakeBackend([]),
    redact: createRedactor(),
    send: () => true,
    exit: () => {},
    timeoutMs: 120_000,
    cleanup: {
      shutdownAgentSessions: () => new Promise(() => {}),
      releaseAllTerminals: async () => {},
    },
  });
  try {
    assert.equal(await lifecycle.shutdown("requested", 4_000), 0);
  } finally {
    console.error = originalError;
  }
  // The call's budget (4 s / 4), not the 120 s fallback, set the deadline.
  assert.ok(logs.some((line) => line.includes("shutdownAgentSessions exceeded 1000 ms")), logs.join("\n"));
});

test("a step resolving undefined is not mistaken for a timeout", async () => {
  const logs = [];
  const originalError = console.error;
  console.error = (...args) => { logs.push(args.join(" ")); };
  const lifecycle = createLifecycle({
    http: fakeBackend([]),
    redact: createRedactor(),
    send: () => true,
    exit: () => {},
    cleanup: {
      shutdownAgentSessions: async () => undefined,
      releaseAllTerminals: async () => undefined,
    },
  });
  try {
    assert.equal(await lifecycle.shutdown("void steps"), 0);
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(logs.filter((line) => line.includes("exceeded")), []);
  assert.deepEqual(logs.filter((line) => line.includes("failed")), []);
});
