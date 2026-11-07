import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildLoginShellProbe,
  fallbackPath,
  GUI_ENV_MARKER,
  mergeLoginEnvironment,
  parseProbeOutput,
  parseProbeOutputFromLastMarker,
  resolveGuiEnvironment,
  stripDesktopVariables,
} from "../environment.ts";

const MARKER = `${GUI_ENV_MARKER}1234__`;

test("desktop host variables are stripped from inherited environments", () => {
  const stripped = stripDesktopVariables({
    PATH: "/usr/bin",
    PI_WEB_DESKTOP: "1",
    PI_WEB_DESKTOP_SESSION: "secret",
    PI_WEB_DESKTOP_LOG_DIR: "/tmp/logs",
    EMPTY: undefined,
  });
  assert.deepEqual(stripped, { PATH: "/usr/bin" });
});

test("probe output parses NUL separated records after the last marker", () => {
  const stdout = `prompt noise\n${MARKER}PATH=/opt/homebrew/bin:/usr/bin\0FOO=bar=baz\0BAD KEY=x\0=oops\0`;
  assert.deepEqual(parseProbeOutput(stdout), { PATH: "/opt/homebrew/bin:/usr/bin", FOO: "bar=baz" });
  assert.deepEqual(parseProbeOutputFromLastMarker(stdout), { PATH: "/opt/homebrew/bin:/usr/bin", FOO: "bar=baz" });
  assert.equal(parseProbeOutput("no marker here"), null);
  assert.equal(parseProbeOutput(`${GUI_ENV_MARKER}1__\0`), null);
});

test("a marker echoed inside prompt text cannot swallow the real environment", () => {
  const stdout = `user said ${GUI_ENV_MARKER}fake__ ok\nlogin output\n${MARKER}A=1\0`;
  assert.deepEqual(parseProbeOutputFromLastMarker(stdout), { A: "1" });
});

test("merge only fills gaps and always ends with a PATH", () => {
  assert.deepEqual(mergeLoginEnvironment({ A: "main", B: "main" }, { A: "login", C: "login" }), {
    A: "main",
    B: "main",
    C: "login",
    PATH: fallbackPath(),
  });
  assert.equal(mergeLoginEnvironment({}, null).PATH, fallbackPath());
  assert.equal(mergeLoginEnvironment({ PATH: "/custom" }, { PATH: "/login" }).PATH, "/custom");
});

test("the login-shell probe is zsh -lic with a bounded timeout and stripped env", () => {
  const probe = buildLoginShellProbe({ PATH: "/usr/bin", PI_WEB_DESKTOP_LOG_DIR: "/secret" });
  assert.equal(probe.command, "/bin/zsh");
  assert.deepEqual(probe.args.slice(0, 1), ["-lic"]);
  assert.equal(probe.options.env.PI_WEB_DESKTOP_LOG_DIR, undefined);
  assert.equal(typeof probe.options.timeout, "number");
  assert.ok(probe.options.maxBuffer > 0);
  assert.equal(probe.options.encoding, "utf8");
});

test("resolveGuiEnvironment merges a successful probe and keeps main-process values", async () => {
  const environment = await resolveGuiEnvironment({
    env: { PATH: "/usr/bin", SHELL: "/bin/zsh", PI_WEB_DESKTOP: "1" },
    platform: "darwin",
    execFile: (_file, _args, _options, callback) => {
      callback(null, `${MARKER}PATH=/opt/homebrew/bin:/usr/bin\0NVM_DIR=/Users/x/.nvm\0`);
      return undefined;
    },
  });
  assert.equal(environment.PATH, "/usr/bin");
  assert.equal(environment.NVM_DIR, "/Users/x/.nvm");
  assert.equal(environment.PI_WEB_DESKTOP, undefined);
});

test("resolveGuiEnvironment falls back to the inherited environment on failure", async () => {
  const warnings = [];
  const environment = await resolveGuiEnvironment({
    env: { PATH: "/usr/bin", HOME: "/Users/x" },
    platform: "darwin",
    execFile: (_file, _args, _options, callback) => {
      callback(new Error("spawn failed"), "");
      return undefined;
    },
    logger: { warn: (message) => warnings.push(message) },
  });
  assert.equal(environment.PATH, "/usr/bin");
  assert.equal(environment.HOME, "/Users/x");
  assert.equal(warnings.length, 1);

  const nonMac = await resolveGuiEnvironment({
    env: { PATH: "/usr/bin" },
    platform: "linux",
    execFile: () => {
      throw new Error("must not run on linux");
    },
  });
  assert.equal(nonMac.PATH, "/usr/bin");

  const throwing = await resolveGuiEnvironment({
    env: {},
    platform: "darwin",
    execFile: () => {
      throw new Error("sync throw");
    },
    logger: { warn: () => undefined },
  });
  assert.equal(throwing.PATH, fallbackPath());
});
