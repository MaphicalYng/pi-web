import assert from "node:assert/strict";
import { test } from "node:test";

import {
  boundText,
  collectSensitiveEnvValues,
  createLogger,
  createRedactor,
  formatLogLine,
  initializeLogDirectory,
  openLogsDirectory,
  REDACTED,
  rotateLogFile,
  toLogFields,
} from "../logger.ts";

const SECRET = "super-secret-session-value";

function memoryFs({ size = 0 } = {}) {
  const calls = { mkdir: [], chmod: [], rename: [], append: [], stat: [] };
  return {
    calls,
    fs: {
      mkdirSync: (path, options) => calls.mkdir.push({ path, options }),
      chmodSync: (path, mode) => calls.chmod.push({ path, mode }),
      statSync: (path) => {
        calls.stat.push(path);
        return { size };
      },
      renameSync: (from, to) => calls.rename.push({ from, to }),
      appendFileSync: (path, data, options) => calls.append.push({ path, data, options }),
    },
  };
}

test("the redactor removes exact, encoded and header secrets", () => {
  const redactor = createRedactor([SECRET]);
  const encoded = encodeURIComponent(SECRET);
  assert.equal(redactor.redact(`value=${SECRET}`), `value=${REDACTED}`);
  assert.equal(redactor.redact(`value=${encoded}`), `value=${REDACTED}`);
  assert.equal(
    redactor.redact(`Cookie: __pi-web-session=${"f".repeat(64)}; other=1`),
    `Cookie: ${REDACTED}`,
  );
  assert.equal(redactor.redact("Authorization: Bearer abc.def"), `Authorization: ${REDACTED}`);
  assert.equal(redactor.redact("nothing to redact"), "nothing to redact");
  redactor.addSecret("short");
  assert.deepEqual(redactor.secrets(), [SECRET]);
});

test("sensitive environment values are collected without desktop host variables", () => {
  const values = collectSensitiveEnvValues({
    OPENAI_API_KEY: "sk-1234567890",
    GITHUB_TOKEN: "ghp_12345678",
    PASSWORD: "password-value",
    HARMLESS: "not-a-secret",
    PI_WEB_DESKTOP_SESSION: "a".repeat(64),
    SHORT_TOKEN: "abc",
    MISSING: undefined,
  });
  assert.deepEqual(values, ["sk-1234567890", "ghp_12345678", "password-value"]);
});

test("boundText flattens newlines and bounds long values", () => {
  assert.equal(boundText("a\nb\r\nc"), "a \\n b \\n c");
  assert.equal(boundText("x".repeat(20), 5), "xxxx…");
  assert.equal(boundText("ok", 10), "ok");
});

test("log lines are single-line key=value text with JSON strings", () => {
  const line = formatLogLine({
    time: new Date("2026-01-02T03:04:05.000Z"),
    pid: 42,
    level: "warn",
    message: "backend.exit",
    fields: { code: 1, reason: "two words", missing: undefined, ok: true },
  });
  assert.equal(line, '2026-01-02T03:04:05.000Z pid=42 warn backend.exit code=1 reason="two words" ok=true');
});

test("toLogFields narrows objects instead of leaking structure", () => {
  assert.deepEqual(toLogFields({ a: 1, b: "x", c: true, d: null, e: undefined, f: { nested: 1 } }), {
    a: 1,
    b: "x",
    c: true,
    d: null,
    e: undefined,
    f: "[object Object]",
  });
});

test("initializeLogDirectory creates mode 0700 and rotate keeps one bounded backup", () => {
  const { fs, calls } = memoryFs();
  initializeLogDirectory("/Users/x/Library/Logs/Pi Web", fs);
  assert.deepEqual(calls.mkdir[0], { path: "/Users/x/Library/Logs/Pi Web", options: { recursive: true, mode: 0o700 } });
  assert.deepEqual(calls.chmod[0], { path: "/Users/x/Library/Logs/Pi Web", mode: 0o700 });

  const small = memoryFs({ size: 10 });
  assert.equal(rotateLogFile("/logs/main.log", 1_000, small.fs), false);
  assert.equal(small.calls.rename.length, 0);

  const large = memoryFs({ size: 2_000 });
  assert.equal(rotateLogFile("/logs/main.log", 1_000, large.fs), true);
  assert.deepEqual(large.calls.rename[0], { from: "/logs/main.log", to: "/logs/main.log.1" });
});

test("createLogger writes redacted, bounded lines with mode 0600", () => {
  const { fs, calls } = memoryFs();
  let secretAdded;
  const logger = createLogger({
    directory: "/logs",
    pid: 7,
    now: () => new Date("2026-01-02T03:04:05.000Z"),
    fsOps: fs,
    secrets: [SECRET],
  });
  logger.info("backend.ready", { origin: "http://127.0.0.1:30141", session: SECRET, nested: { a: 1 } });
  assert.equal(calls.append.length, 1);
  assert.doesNotMatch(calls.append[0].data, /super-secret/);
  assert.match(calls.append[0].data, /\[redacted\]/);
  assert.equal(calls.append[0].options.mode, 0o600);
  assert.equal(logger.filePath, "/logs/main.log");
  logger.addSecret("another-secret-value");
  assert.equal(logger.redactor.secrets().includes("another-secret-value"), true);
  secretAdded = logger.redact("another-secret-value");
  assert.equal(secretAdded, REDACTED);
});

test("append failures never throw and openLogsDirectory never accepts a path from the caller", async () => {
  const { fs } = memoryFs();
  fs.appendFileSync = () => {
    throw new Error("disk full");
  };
  const logger = createLogger({ directory: "/logs", fsOps: fs });
  assert.doesNotThrow(() => logger.error("still-safe"));

  const opened = [];
  assert.equal(await openLogsDirectory("/logs", async (target) => {
    opened.push(target);
    return "";
  }, fs), true);
  assert.deepEqual(opened, ["/logs"]);
  assert.equal(await openLogsDirectory("/logs", async () => "failed", fs), false);
  assert.equal(await openLogsDirectory("/logs", async () => {
    throw new Error("x");
  }, fs), false);
});
