import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import { createJiti } from "jiti";
import { NextRequest } from "next/server.js";

const originalPassword = process.env.PI_WEB_PASSWORD;
const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { proxy } = await jiti.import("../proxy.ts");
const { createWebSessionToken } = await jiti.import("./web-auth.ts");
const { getAuthRetryAfterMs, recordAuthFailure, recordAuthSuccess } = await import("./auth-throttle.ts");

before(() => { process.env.PI_WEB_PASSWORD = "secret"; });
beforeEach(() => { recordAuthSuccess(); });
after(() => {
  recordAuthSuccess();
  if (originalPassword === undefined) delete process.env.PI_WEB_PASSWORD;
  else process.env.PI_WEB_PASSWORD = originalPassword;
});

function request(path, headers = {}, method = "GET") {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: { Host: "localhost", ...headers },
  });
}

test("redirects page navigation to the login page and preserves its query", () => {
  const response = proxy(request("/?session=abc"));
  assert.equal(response.status, 307);
  assert.equal(response.headers.get("location"), "http://localhost/login?next=%2F%3Fsession%3Dabc");
});

test("accepts a signed session for pages", () => {
  const token = createWebSessionToken("secret");
  const response = proxy(request("/", { Cookie: `pi_web_session=${token}` }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-middleware-next"), "1");
});

test("keeps Basic Auth compatibility for APIs but not pages", () => {
  const authorization = `Basic ${Buffer.from("pi:secret").toString("base64")}`;
  assert.equal(proxy(request("/api/sessions", { Authorization: authorization })).status, 200);
  assert.equal(proxy(request("/", { Authorization: authorization })).status, 307);
  assert.equal(proxy(request("/api/sessions")).status, 401);
});

test("leaves the login endpoint reachable without a session", () => {
  assert.equal(proxy(request("/login")).status, 200);
  assert.equal(proxy(request("/api/web-auth")).status, 200);
});

function basic(password) {
  return `Basic ${Buffer.from(`pi:${password}`).toString("base64")}`;
}

test("a wrong Basic password blocks further attempts, even with the right password", () => {
  assert.equal(proxy(request("/api/sessions", { Authorization: basic("guess") })).status, 401);
  assert.ok(getAuthRetryAfterMs() > 0);

  for (const path of ["/api/sessions", "/api/web-auth"]) {
    const response = proxy(request(path, { Authorization: basic("secret") }));
    assert.equal(response.status, 429, path);
    assert.equal(response.headers.get("retry-after"), "1");
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
});

test("GET /api/web-auth cannot be used to check Basic passwords without the throttle", () => {
  assert.equal(proxy(request("/api/web-auth", { Authorization: basic("guess") })).status, 200);
  assert.ok(getAuthRetryAfterMs() > 0);
  assert.equal(proxy(request("/api/web-auth", { Authorization: basic("guess-2") })).status, 429);
});

test("a signed session keeps working while Basic attempts are blocked", () => {
  proxy(request("/api/sessions", { Authorization: basic("guess") }));
  const token = createWebSessionToken("secret");
  const response = proxy(request("/api/sessions", {
    Authorization: basic("guess"),
    Cookie: `pi_web_session=${token}`,
  }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-middleware-next"), "1");
});

test("only Basic credentials count as password attempts", () => {
  assert.equal(proxy(request("/api/sessions", { Authorization: "Bearer token" })).status, 401);
  assert.equal(getAuthRetryAfterMs(), 0);
});

test("a Basic success does not reset earlier failures", () => {
  recordAuthFailure(Date.now() - 2_000);
  assert.equal(getAuthRetryAfterMs(), 0);
  assert.equal(proxy(request("/api/sessions", { Authorization: basic("secret") })).status, 200);

  assert.equal(proxy(request("/api/sessions", { Authorization: basic("guess") })).status, 401);
  // The second failure in a row doubles the block instead of starting over.
  assert.ok(getAuthRetryAfterMs() > 1_000);
});

test("desktop mode accepts this run's exact cookie and keeps the Web fallback", async () => {
  const { setDesktopAuthContext, clearDesktopAuthContext } = await jiti.import("./desktop-auth.ts");
  const secret = "cd".repeat(32);
  setDesktopAuthContext({ enabled: true, secret, origin: "http://localhost" });
  try {
    assert.equal(proxy(request("/", { Cookie: `__pi-web-session=${secret}` })).status, 200);
    assert.equal(proxy(request("/api/sessions", { Cookie: `__pi-web-session=${secret}` })).status, 200);

    // No valid desktop cookie yet: with a password configured, the existing
    // Web credentials stay an accepted path (the approved desktop matrix).
    const authorization = `Basic ${Buffer.from("pi:secret").toString("base64")}`;
    assert.equal(proxy(request("/api/sessions", { Authorization: authorization })).status, 200);
    const token = createWebSessionToken("secret");
    assert.equal(proxy(request("/api/sessions", { Cookie: `pi_web_session=${token}` })).status, 200);
    assert.equal(proxy(request("/api/sessions")).status, 401);
    assert.equal(proxy(request("/")).status, 307);

    // A wrong or duplicated desktop cookie is ignored, not trusted.
    assert.equal(proxy(request("/", { Cookie: `__pi-web-session=${"ef".repeat(32)}` })).status, 307);
    assert.equal(
      proxy(request("/", { Cookie: `__pi-web-session=${secret}; __pi-web-session=${secret}` })).status,
      307,
    );

    const login = proxy(request("/login", { Cookie: `__pi-web-session=${secret}` }));
    assert.equal(login.status, 307);
    assert.equal(login.headers.get("location"), "http://localhost/");
  } finally {
    clearDesktopAuthContext();
  }
});

test("desktop mode requires this listener's exact Origin for mutations", async () => {
  const { setDesktopAuthContext, clearDesktopAuthContext } = await jiti.import("./desktop-auth.ts");
  const secret = "01".repeat(32);
  setDesktopAuthContext({ enabled: true, secret, origin: "http://localhost" });
  try {
    const cookie = `__pi-web-session=${secret}`;
    const mutation = (headers) => proxy(request("/api/agent/x", { Cookie: cookie, ...headers }, "POST"));
    assert.equal(mutation({ Origin: "http://localhost" }).status, 200);
    assert.equal(mutation({}).status, 403);
    assert.equal(mutation({ Origin: "http://127.0.0.1:3000" }).status, 403);
    // GET/HEAD stay open to a cookie-only client (the shell's own reloads).
    assert.equal(proxy(request("/api/sessions", { Cookie: cookie })).status, 200);
  } finally {
    clearDesktopAuthContext();
  }
});

test("desktop env without an installed session fails closed only without a password", () => {
  const previous = process.env.PI_WEB_DESKTOP;
  const previousPassword = process.env.PI_WEB_PASSWORD;
  process.env.PI_WEB_DESKTOP = "1";
  try {
    // With the Web password still configured, the ordinary login stays the
    // fallback matrix: API 401, page redirect to /login, login form reachable.
    assert.equal(proxy(request("/api/sessions")).status, 401);
    assert.equal(proxy(request("/")).status, 307);
    assert.equal(proxy(request("/login")).status, 200);

    // No password and no desktop cookie: nothing may pass the gate.
    delete process.env.PI_WEB_PASSWORD;
    assert.equal(proxy(request("/api/sessions")).status, 401);
    assert.equal(proxy(request("/")).status, 403);
    assert.equal(proxy(request("/login")).status, 307);
  } finally {
    if (previous === undefined) delete process.env.PI_WEB_DESKTOP;
    else process.env.PI_WEB_DESKTOP = previous;
    if (previousPassword === undefined) delete process.env.PI_WEB_PASSWORD;
    else process.env.PI_WEB_PASSWORD = previousPassword;
  }
});
