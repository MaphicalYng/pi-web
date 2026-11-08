import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const config = await jiti.import("../config.ts");
const auth = await jiti.import("../../../lib/desktop-auth.ts");
const redaction = await jiti.import("../redaction.ts");

const SESSION = "a".repeat(64);

test("the session is exactly 64 lowercase hex characters", () => {
  assert.equal(config.isDesktopSessionSecret(SESSION), true);
  assert.equal(config.isDesktopSessionSecret("A".repeat(64)), false);
  assert.equal(config.isDesktopSessionSecret("a".repeat(63)), false);
  assert.equal(config.isDesktopSessionSecret("a".repeat(65)), false);
  assert.equal(config.isDesktopSessionSecret(undefined), false);
});

test("launch refuses a plain Web process and a malformed session", () => {
  assert.throws(
    () => config.consumeDesktopLaunch({ env: { PI_WEB_DESKTOP_SERVER_DIR: "/tmp/x" } }),
    (error) => error.code === "desktop.mode",
  );
  assert.throws(
    () => config.consumeDesktopLaunch({ env: { PI_WEB_DESKTOP: "1", PI_WEB_DESKTOP_SESSION: "nope" } }),
    (error) => error.code === "desktop.session",
  );
});

test("launch copies the session out of the environment before it is used", () => {
  const env = {
    PI_WEB_DESKTOP: "1",
    PI_WEB_DESKTOP_SESSION: SESSION,
    PI_WEB_DESKTOP_SERVER_DIR: "/tmp/standalone",
    PI_WEB_PASSWORD: "web-password",
  };
  const launch = config.consumeDesktopLaunch({ env });
  assert.equal(launch.sessionFromEnv, SESSION);
  assert.equal("PI_WEB_DESKTOP_SESSION" in env, false);
  assert.equal(launch.serverDir, "/tmp/standalone");
  assert.equal(launch.port, 0);
  assert.deepEqual(new Set(launch.secrets), new Set([SESSION, "web-password"]));
});

test("an incomplete standalone root is reported by name, never by path", () => {
  const missing = config.missingStandaloneParts("/nonexistent/standalone");
  assert.deepEqual(missing, ["package.json", ".next", "node_modules/next"]);
  assert.throws(
    () => config.assertStandaloneRoot("/nonexistent/standalone"),
    (error) => error.code === "desktop.resources" && !error.message.includes("/nonexistent"),
  );
});

test("installing a session makes desktop mode and validates only that secret", () => {
  // The suite may itself run inside the desktop backend, whose environment is
  // already desktop mode; the assertion is about installing a session, not
  // about how the test process was started.
  const savedMode = process.env.PI_WEB_DESKTOP;
  delete process.env.PI_WEB_DESKTOP;
  auth.clearDesktopAuthContext();
  assert.equal(auth.isDesktopMode(), false);
  config.installDesktopSession(SESSION);
  try {
    assert.equal(auth.isDesktopMode(), true);
    assert.equal(auth.hasValidDesktopSession({ headers: { get: () => `__pi-web-session=${SESSION}` } }, auth.getDesktopAuthContext()), true);
    assert.equal(auth.hasValidDesktopSession({ headers: { get: () => `__pi-web-session=${"b".repeat(64)}` } }, auth.getDesktopAuthContext()), false);
    assert.equal(auth.hasValidDesktopSession({ headers: { get: () => "__pi-web-session=a" } }, auth.getDesktopAuthContext()), false);
  } finally {
    auth.clearDesktopAuthContext();
    if (savedMode === undefined) delete process.env.PI_WEB_DESKTOP;
    else process.env.PI_WEB_DESKTOP = savedMode;
  }
});

test("redaction removes the exact secrets from log and fatal text", () => {
  const redact = redaction.createRedactor([SESSION, "web-password"]);
  assert.equal(redact.redact(`cookie ${SESSION} password web-password`), "cookie [redacted] password [redacted]");
  assert.match(redact.fatal(new Error(`bad ${SESSION}`)), /^Error: bad \[redacted\]/);
  redact.add("later-secret");
  assert.equal(redact.redact("later-secret"), "[redacted]");
  assert.equal(redact.log(`line ${SESSION}`), undefined);
});
