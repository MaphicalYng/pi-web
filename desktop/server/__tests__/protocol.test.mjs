import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const protocol = await jiti.import("../protocol.ts");

const SESSION = "c".repeat(64);

test("a session handoff must be the exact 64 hex secret", () => {
  assert.deepEqual(protocol.parseMainMessage({ type: "session", session: SESSION }), {
    type: "session",
    session: SESSION,
  });
  assert.equal(protocol.parseMainMessage({ type: "session", session: SESSION.toUpperCase() }), undefined);
  assert.equal(protocol.parseMainMessage({ type: "session" }), undefined);
  assert.equal(protocol.parseMainMessage({ type: "ready", origin: "http://127.0.0.1:1" }), undefined);
  assert.equal(protocol.parseMainMessage("session"), undefined);
});

test("an Electron parentPort payload arrives wrapped in data", () => {
  assert.deepEqual(
    protocol.parseMainMessage({ data: { type: "session", session: SESSION } }),
    { type: "session", session: SESSION },
  );
});

test("shutdown budgets follow the frozen rule: default when absent, reject outside 30-120 s", () => {
  assert.equal(protocol.normalizeShutdownTimeoutMs(undefined), protocol.SHUTDOWN_TIMEOUT_DEFAULT_MS);
  assert.equal(protocol.normalizeShutdownTimeoutMs(30_000), 30_000);
  assert.equal(protocol.normalizeShutdownTimeoutMs(120_000), 120_000);
  // Same semantics as `normalizeShutdownTimeout` in the frozen shared module:
  // invalid values are not clamped, they reject the message.
  assert.equal(protocol.normalizeShutdownTimeoutMs(29_999), null);
  assert.equal(protocol.normalizeShutdownTimeoutMs(120_001), null);
  assert.equal(protocol.normalizeShutdownTimeoutMs(1.5), null);
  assert.equal(protocol.normalizeShutdownTimeoutMs("3000"), null);
  assert.equal(protocol.normalizeShutdownTimeoutMs(Number.NaN), null);

  assert.deepEqual(protocol.parseMainMessage({ type: "shutdown" }), {
    type: "shutdown",
    timeoutMs: protocol.SHUTDOWN_TIMEOUT_DEFAULT_MS,
  });
  assert.deepEqual(protocol.parseMainMessage({ type: "shutdown", timeoutMs: 120_000 }), {
    type: "shutdown",
    timeoutMs: 120_000,
  });
  assert.equal(protocol.parseMainMessage({ type: "shutdown", timeoutMs: 20_000 }), undefined);
  assert.equal(protocol.parseMainMessage({ type: "shutdown", timeoutMs: 1e9 }), undefined);
});

test("a broken pipe never throws out of the sender", () => {
  const send = protocol.createMessageSender({ postMessage: () => { throw new Error("gone"); } });
  assert.equal(send({ type: "stopped", code: 0 }), false);
  const collected = [];
  const ok = protocol.createMessageSender({ postMessage: (message) => collected.push(message) });
  assert.equal(ok({ type: "stopped", code: 0 }), true);
  assert.deepEqual(collected, [{ type: "stopped", code: 0 }]);
});

test("readParentPort reads Electron's parentPort and ignores a plain process", () => {
  const listeners = [];
  const electron = protocol.readParentPort({
    parentPort: {
      on: (event, listener) => listeners.push([event, listener]),
      postMessage: () => {},
    },
  });
  assert.ok(electron);
  assert.equal(typeof electron.postMessage, "function");
  assert.equal(protocol.readParentPort({}), undefined);
});
