import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { createRedactor, installConsoleRedaction } = await jiti.import("../redaction.ts");

test("known secrets are replaced wherever they appear, in either order", () => {
  const redact = createRedactor(["second-secret", "first-secret"]);
  assert.equal(
    redact.redact("first-secret / second-secret / first-secret x second-secret"),
    "[redacted] / [redacted] / [redacted] x [redacted]",
  );
});

test("secrets added after startup are redacted too", () => {
  const redact = createRedactor();
  assert.equal(redact.redact("not yet known"), "not yet known");
  redact.add("late-secret");
  assert.equal(redact.redact("late-secret"), "[redacted]");
});

test("empty secrets are ignored instead of blanking every message", () => {
  const redact = createRedactor(["", undefined]);
  assert.equal(redact.redact("still readable"), "still readable");
});

test("fatal text is redacted and capped just under the shell's 2 KiB limit", () => {
  const redact = createRedactor(["secret"]);
  const fatal = redact.fatal(new Error("boom secret"));
  assert.ok(fatal.startsWith("Error: boom [redacted]"));
  assert.equal(fatal.includes("secret"), false);
  assert.ok(redact.fatal("x".repeat(10_000)).length <= 2001);
  assert.equal(redact.fatal("plain secret"), "plain [redacted]");
});

test("a circular or exotic error value still yields a redacted line", () => {
  const redact = createRedactor(["secret"]);
  const circular = { text: "secret" };
  circular.self = circular;
  assert.equal(redact.fatal(circular), "[object Object]");
  assert.doesNotThrow(() => redact.fatal(Object.create(null)));
});

test("secrets shorter than four characters are not registered", () => {
  const redact = createRedactor(["abc"]);
  redact.add("xy");
  assert.deepEqual(redact.secrets(), []);
  redact.add("abcd");
  assert.deepEqual(redact.secrets(), ["abcd"]);
});

test("installConsoleRedaction wraps console.error and restores it", () => {
  const chunks = [];
  const originalWrite = process.stderr.write;
  const originalError = console.error;
  process.stderr.write = (chunk) => { chunks.push(String(chunk)); return true; };
  try {
    const restore = installConsoleRedaction(createRedactor(["canary-secret"]));
    console.error("line with canary-secret inside");
    restore();
    console.error("line with canary-secret inside");
  } finally {
    process.stderr.write = originalWrite;
    console.error = originalError;
  }
  const output = chunks.join("");
  assert.ok(output.includes("[redacted]"), output);
  assert.ok(output.includes("line with canary-secret inside"), "restored console is raw again");
});
