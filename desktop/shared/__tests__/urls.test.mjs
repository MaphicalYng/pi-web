import assert from "node:assert/strict";
import { test } from "node:test";

import {
  appUrlFromInput,
  buildAppUrl,
  classifyLink,
  isAllowedBackendUrl,
  isExternalHttpUrl,
  isNavigationAllowed,
  parseLoopbackOrigin,
} from "../urls.ts";

test("parseLoopbackOrigin accepts only strict http://127.0.0.1:<port>", () => {
  assert.equal(parseLoopbackOrigin("http://127.0.0.1:30141"), "http://127.0.0.1:30141");
  assert.equal(parseLoopbackOrigin("http://127.0.0.1:1"), "http://127.0.0.1:1");
  assert.equal(parseLoopbackOrigin("http://127.0.0.1:65535"), "http://127.0.0.1:65535");

  for (const bad of [
    "http://localhost:30141",
    "http://127.0.0.1",
    "http://127.0.0.1:0",
    "http://127.0.0.1:65536",
    "https://127.0.0.1:30141",
    "http://[::1]:30141",
    "http://0.0.0.0:30141",
    "http://user:pass@127.0.0.1:30141",
    "http://127.0.0.1:30141/",
    "http://127.0.0.1:30141/path",
    "http://127.0.0.1:30141?q=1",
    "http://127.0.0.1:30141#hash",
    "http://127.0.0.1:30141/.",
    "not a url",
    "",
    null,
    42,
  ]) {
    assert.equal(parseLoopbackOrigin(bad), null, `expected rejection: ${String(bad)}`);
  }
});

test("same-origin URLs keep paths, queries and hashes; everything else is rejected", () => {
  const origin = "http://127.0.0.1:30141";
  for (const good of [`${origin}/`, `${origin}/chat?x=1#y`, `${origin}/a/b`]) {
    assert.equal(isAllowedBackendUrl(good, origin), true, good);
    assert.equal(isNavigationAllowed(good, origin), true, good);
  }
  for (const bad of [
    "http://127.0.0.1:30142/",
    "https://127.0.0.1:30141/",
    "http://localhost:30141/",
    "http://127.0.0.1:30141.evil.com/",
    "file:///etc/passwd",
    "data:text/html,<h1>x</h1>",
    "javascript:alert(1)",
    "mailto:a@b.c",
    "myapp://open",
    "http://user:pass@127.0.0.1:30141/",
  ]) {
    assert.equal(isAllowedBackendUrl(bad, origin), false, `expected rejection: ${bad}`);
  }
  assert.equal(isAllowedBackendUrl(origin, origin), true);
  assert.equal(isAllowedBackendUrl(`${origin}/`, null), false);
  assert.equal(isAllowedBackendUrl(`${origin}/`, "http://127.0.0.1:1"), false);
});

test("external links are credential-free http(s) only", () => {
  assert.equal(isExternalHttpUrl("https://example.com/a?b=1#c"), true);
  assert.equal(isExternalHttpUrl("http://example.com"), true);
  for (const bad of [
    "javascript:alert(1)",
    "file:///etc/passwd",
    "data:text/plain,x",
    "mailto:a@b.c",
    "myapp://x",
    "https://user:pass@example.com/",
    "not a url",
    "",
    undefined,
  ]) {
    assert.equal(isExternalHttpUrl(bad), false, `expected rejection: ${String(bad)}`);
  }
});

test("classifyLink and isNavigationAllowed separate navigation, external and blocked", () => {
  const origin = "http://127.0.0.1:30141";
  assert.equal(classifyLink(`${origin}/x`, origin), "same-origin");
  assert.equal(classifyLink("https://example.com/", origin), "external");
  assert.equal(classifyLink("javascript:alert(1)", origin), "blocked");
  assert.equal(classifyLink("javascript:alert(1)", null), "blocked");
  assert.equal(isNavigationAllowed("javascript:alert(1)", origin), false);
});

test("buildAppUrl keeps the path narrow", () => {
  const origin = "http://127.0.0.1:30141";
  assert.equal(buildAppUrl(origin, "/"), `${origin}/`);
  assert.equal(buildAppUrl(origin, "/chat?x=1#y"), `${origin}/chat?x=1#y`);
  for (const bad of ["//evil.com/", "javascript:alert(1)", "/a\\b", "/a b", "http://evil.com/", "", "/\u0000"]) {
    assert.equal(buildAppUrl(origin, bad), null, `expected rejection: ${JSON.stringify(bad)}`);
  }
  assert.equal(buildAppUrl(null, "/"), null);
});

test("appUrlFromInput accepts a relative path, an absolute same-origin URL and the bare origin", () => {
  const origin = "http://127.0.0.1:30141";
  assert.equal(appUrlFromInput("/chat", origin), `${origin}/chat`);
  assert.equal(appUrlFromInput(`${origin}/chat?a=1`, origin), `${origin}/chat?a=1`);
  assert.equal(appUrlFromInput(origin, origin), `${origin}/`);
  assert.equal(appUrlFromInput("https://example.com/", origin), null);
  assert.equal(appUrlFromInput("", origin), null);
  assert.equal(appUrlFromInput("/chat", null), null);
});
