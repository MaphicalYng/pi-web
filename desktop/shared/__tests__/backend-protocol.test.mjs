import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createSessionHandoff,
  createShutdownMessage,
  DESKTOP_ENV,
  DESKTOP_ENV_PREFIX,
  DESKTOP_SESSION_COOKIE,
  generateSessionSecret,
  isSessionHandoffMessage,
  isSessionSecret,
  isShutdownMessage,
  normalizeShutdownTimeout,
  parseBackendMessage,
  SHUTDOWN_TIMEOUT_DEFAULT_MS,
  SHUTDOWN_TIMEOUT_MAX_MS,
  SHUTDOWN_TIMEOUT_MIN_MS,
  SESSION_SECRET_LENGTH,
} from "../backend-protocol.ts";

test("session secrets are 64 lowercase hex characters and validated strictly", () => {
  const secret = generateSessionSecret();
  assert.match(secret, /^[0-9a-f]{64}$/);
  assert.equal(secret.length, SESSION_SECRET_LENGTH);
  assert.equal(isSessionSecret(secret), true);
  assert.notEqual(generateSessionSecret(), secret);

  for (const bad of ["", "abc", secret.toUpperCase(), `${secret}0`, "g".repeat(64), null, 42, undefined]) {
    assert.equal(isSessionSecret(bad), false, String(bad));
  }
});

test("session handoff carries the secret and nothing else", () => {
  const secret = generateSessionSecret();
  const message = createSessionHandoff(secret);
  assert.deepEqual(message, { type: "session", session: secret });
  assert.equal(isSessionHandoffMessage(message), true);
  assert.throws(() => createSessionHandoff("not-a-secret"));
  assert.equal(isSessionHandoffMessage({ type: "session", session: secret, extra: 1 }), false);
  assert.equal(isSessionHandoffMessage({ type: "session" }), false);
});

test("ready parsing accepts a non-empty origin string and requires exact keys", () => {
  assert.deepEqual(parseBackendMessage({ type: "ready", origin: "http://127.0.0.1:30141" }), {
    type: "ready",
    origin: "http://127.0.0.1:30141",
  });
  assert.equal(parseBackendMessage({ type: "ready", origin: "" }), null);
  assert.equal(parseBackendMessage({ type: "ready", origin: "http://127.0.0.1:1", extra: true }), null);
  assert.equal(parseBackendMessage({ type: "ready" }), null);
});

test("fatal parsing bounds code length and requires a message", () => {
  assert.deepEqual(parseBackendMessage({ type: "fatal", code: "E_BOOT", message: "boom" }), {
    type: "fatal",
    code: "E_BOOT",
    message: "boom",
  });
  assert.equal(parseBackendMessage({ type: "fatal", code: "", message: "boom" }), null);
  assert.equal(parseBackendMessage({ type: "fatal", code: "X".repeat(129), message: "boom" }), null);
  assert.equal(parseBackendMessage({ type: "fatal", code: "E", message: 5 }), null);
  assert.equal(parseBackendMessage({ type: "fatal", code: "E", message: "boom", extra: 1 }), null);
});

test("stopped parsing requires an integer exit code", () => {
  assert.deepEqual(parseBackendMessage({ type: "stopped", code: 0 }), { type: "stopped", code: 0 });
  assert.equal(parseBackendMessage({ type: "stopped", code: 1.5 }), null);
  assert.equal(parseBackendMessage({ type: "stopped", code: "0" }), null);
  assert.equal(parseBackendMessage({ type: "stopped" }), null);
});

test("unknown messages parse as null instead of throwing", () => {
  for (const value of [null, undefined, 0, "ready", [], { type: "other" }, { type: "session", session: "x" }]) {
    assert.equal(parseBackendMessage(value), null);
  }
});

test("shutdown timeout is clamped to the frozen 30s..120s window", () => {
  assert.equal(normalizeShutdownTimeout(undefined), SHUTDOWN_TIMEOUT_DEFAULT_MS);
  assert.equal(normalizeShutdownTimeout(SHUTDOWN_TIMEOUT_MIN_MS), SHUTDOWN_TIMEOUT_MIN_MS);
  assert.equal(normalizeShutdownTimeout(SHUTDOWN_TIMEOUT_MAX_MS), SHUTDOWN_TIMEOUT_MAX_MS);
  for (const bad of [
    SHUTDOWN_TIMEOUT_MIN_MS - 1,
    SHUTDOWN_TIMEOUT_MAX_MS + 1,
    1.5,
    "60000",
    null,
    Number.NaN,
  ]) {
    assert.equal(normalizeShutdownTimeout(bad), null, String(bad));
  }
});

test("shutdown messages reject invalid budgets; handoff messages reject unknown fields", () => {
  assert.deepEqual(createShutdownMessage(), { type: "shutdown", timeoutMs: SHUTDOWN_TIMEOUT_DEFAULT_MS });
  assert.equal(isShutdownMessage(createShutdownMessage(SHUTDOWN_TIMEOUT_MIN_MS)), true);
  assert.throws(() => createShutdownMessage(1_000));
  assert.equal(isShutdownMessage({ type: "shutdown", timeoutMs: 1_000 }), false);
  assert.equal(isShutdownMessage({ type: "shutdown", timeoutMs: SHUTDOWN_TIMEOUT_DEFAULT_MS, extra: 1 }), false);
});

test("frozen constants keep their exact public values", () => {
  assert.equal(DESKTOP_SESSION_COOKIE, "__pi-web-session");
  assert.equal(DESKTOP_ENV_PREFIX, "PI_WEB_DESKTOP_");
  assert.equal(DESKTOP_ENV.mode, "PI_WEB_DESKTOP");
  assert.equal(DESKTOP_ENV.session, "PI_WEB_DESKTOP_SESSION");
  assert.equal(DESKTOP_ENV.logDir, "PI_WEB_DESKTOP_LOG_DIR");
});
