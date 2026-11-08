import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createTimeoutSignal,
  isPiWebHtml,
  probeDevelopmentServer,
  probeFirstPage,
} from "../http-probes.ts";
import { FakeTimers, htmlResponse, jsonResponse } from "./helpers.mjs";

const ORIGIN = "http://127.0.0.1:30141";
const PI_WEB_HTML = "<html><head><title>Pi Web</title></head><body>ok</body></html>";

function response(status, body, url = `${ORIGIN}/`, type = "text/html; charset=utf-8") {
  const result = status === 200 && type.startsWith("text/html") ? htmlResponse(status, body) : jsonResponse(status, body);
  result.url = url;
  result.headers = { get: (name) => (name.toLowerCase() === "content-type" ? type : null) };
  return result;
}

test("isPiWebHtml recognizes the product page and the password gate", () => {
  assert.equal(isPiWebHtml(PI_WEB_HTML), true);
  assert.equal(isPiWebHtml('<title> Pi  Web </title>'), true);
  assert.equal(isPiWebHtml('<html><script src="/_next/static/chunks/a.js"></script> Pi Web</html>'), true);
  assert.equal(isPiWebHtml("<html><title>Other</title></html>"), false);
  assert.equal(isPiWebHtml(""), false);
  assert.equal(isPiWebHtml(null), false);
});

test("a healthy first page passes after a bounded body read", async () => {
  const result = await probeFirstPage(ORIGIN, {
    fetch: async () => response(200, PI_WEB_HTML),
  });
  assert.equal(result.ok, true);
  assert.equal(result.reachable, true);
  assert.equal(result.status, 200);
});

test("network failures, timeouts and HTTP errors never pass", async () => {
  const network = await probeFirstPage(ORIGIN, {
    fetch: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  assert.deepEqual(network, { ok: false, reachable: false, failure: "network" });

  const timers = new FakeTimers();
  const pending = probeFirstPage(ORIGIN, {
    timer: timers,
    timeoutMs: 100,
    fetch: (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted")));
      }),
  });
  await timers.advance(100);
  assert.deepEqual(await pending, { ok: false, reachable: false, failure: "timeout" });

  const status = await probeFirstPage(ORIGIN, { fetch: async () => response(500, "boom") });
  assert.equal(status.ok, false);
  assert.equal(status.failure, "http-status");
  assert.equal(status.status, 500);
});

test("redirects off the backend origin are refused", async () => {
  const result = await probeFirstPage(ORIGIN, {
    fetch: async () => response(200, PI_WEB_HTML, "https://evil.example/"),
  });
  assert.equal(result.ok, false);
  assert.equal(result.failure, "redirect");
  assert.equal(result.reachable, true);
});

test("a non-HTML body, a foreign page and an unreadable body are rejected", async () => {
  const json = await probeFirstPage(ORIGIN, {
    fetch: async () => response(200, "{}", `${ORIGIN}/`, "application/json"),
  });
  assert.equal(json.failure, "not-pi-web");

  const foreign = await probeFirstPage(ORIGIN, {
    fetch: async () => response(200, "<html><title>nginx</title></html>"),
  });
  assert.equal(foreign.failure, "not-pi-web");

  const brokenBody = {
    status: 200,
    ok: true,
    url: `${ORIGIN}/`,
    headers: { get: () => "text/html" },
    body: {
      getReader: () => ({
        read: async () => {
          throw new Error("socket closed");
        },
        cancel: async () => undefined,
        releaseLock: () => undefined,
      }),
    },
    text: async () => "",
  };
  const body = await probeFirstPage(ORIGIN, { fetch: async () => brokenBody });
  assert.equal(body.failure, "body");
});

test("probeDevelopmentServer distinguishes attached from occupied", async () => {
  const attached = await probeDevelopmentServer(ORIGIN, {
    fetch: async () => response(200, PI_WEB_HTML),
  });
  assert.equal(attached.reachable, true);
  assert.equal(attached.isPiWeb, true);

  const occupied = await probeDevelopmentServer(ORIGIN, {
    fetch: async () => response(200, "<html><title>Nuxt</title></html>"),
  });
  assert.equal(occupied.reachable, true);
  assert.equal(occupied.isPiWeb, false);
});

test("createTimeoutSignal aborts once and can be cancelled", () => {
  const timers = new FakeTimers();
  const signal = createTimeoutSignal(50, timers);
  assert.equal(signal.timedOut(), false);
  signal.cancel();
  assert.equal(timers.pending, 0);

  const second = createTimeoutSignal(50, timers);
  void timers.advance(50);
  assert.equal(second.timedOut(), true);
  assert.equal(second.signal.aborted, true);
});
