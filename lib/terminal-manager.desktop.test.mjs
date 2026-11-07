import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { releaseAllTerminals, terminalEnvironment } = await jiti.import("./terminal-manager.ts");

const DESKTOP_ENV = {
  PATH: "/usr/bin",
  HOME: "/home/pi",
  PI_WEB_PASSWORD: "browser-password",
  PI_WEB_DESKTOP: "1",
  PI_WEB_DESKTOP_SESSION: "ab".repeat(32),
  PI_WEB_DESKTOP_LOG_DIR: "/home/pi/.pi-web/logs",
  TERM: "dumb",
};

test("a terminal never inherits the browser password or any desktop host variable", () => {
  const env = terminalEnvironment(DESKTOP_ENV, "linux");
  for (const name of ["PI_WEB_PASSWORD", "PI_WEB_DESKTOP", "PI_WEB_DESKTOP_SESSION", "PI_WEB_DESKTOP_LOG_DIR"]) {
    assert.equal(Object.hasOwn(env, name), false, name);
  }
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.TERM, "xterm-256color");
  assert.equal(env.COLORTERM, "truecolor");
  assert.equal(env.LANG, "C.UTF-8");
});

test("Windows environment names are matched case-insensitively", () => {
  const env = terminalEnvironment({ Path: "C:\\Windows", pi_web_desktop_session: "cd".repeat(32) }, "win32");
  assert.equal(env.Path, "C:\\Windows");
  assert.equal(env.pi_web_desktop_session, undefined);
});

test("releaseAllTerminals is idempotent with no terminals open", async () => {
  assert.equal(await releaseAllTerminals(), 0);
  assert.equal(await releaseAllTerminals(), 0);
});
