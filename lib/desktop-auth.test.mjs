import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const auth = await jiti.import("./desktop-auth.ts");

const SECRET = "ab".repeat(32);
const context = { enabled: true, secret: SECRET, origin: "http://127.0.0.1:49152" };

function withCookie(cookie) {
  return { headers: { get: (name) => (name.toLowerCase() === "cookie" ? cookie : null) } };
}

test("only exactly one __pi-web-session value is read", () => {
  assert.deepEqual(auth.readDesktopSessionCookieValues(withCookie(undefined)), []);
  assert.deepEqual(auth.readDesktopSessionCookieValues(withCookie(`a=b; __pi-web-session=${SECRET}`)), [SECRET]);
  assert.deepEqual(
    auth.readDesktopSessionCookieValues(withCookie(`__pi-web-session=${SECRET}; __pi-web-session=${SECRET}`)),
    [SECRET, SECRET],
  );
  assert.deepEqual(auth.readDesktopSessionCookieValues(withCookie('__pi-web-session="quoted"')), ["quoted"]);
  assert.deepEqual(auth.readDesktopSessionCookieValues(withCookie("malformed; __pi-web-session")), []);
  assert.equal(auth.hasDesktopSessionCookie(withCookie(`x=1; __pi-web-session=${SECRET}`)), true);
  assert.equal(auth.hasDesktopSessionCookie(withCookie(`__pi-web-session=${SECRET}; __pi-web-session=${SECRET}`)), false);
});

test("the session matches only this run's exact secret and exactly one cookie", () => {
  assert.equal(auth.hasValidDesktopSession(withCookie(`__pi-web-session=${SECRET}`), context), true);
  assert.equal(auth.hasValidDesktopSession(withCookie(`__pi-web-session=${"cd".repeat(32)}`), context), false);
  assert.equal(
    auth.hasValidDesktopSession(withCookie(`__pi-web-session=${SECRET}; __pi-web-session=${SECRET}`), context),
    false,
  );
  assert.equal(auth.hasValidDesktopSession(withCookie(undefined), context), false);
  assert.equal(auth.hasValidDesktopSession(withCookie(`__pi-web-session=${SECRET}`), undefined), false);
});

test("secretsEqual compares digests, so different lengths do not throw", () => {
  assert.equal(auth.secretsEqual(SECRET, SECRET), true);
  assert.equal(auth.secretsEqual(SECRET, SECRET.slice(1)), false);
  assert.equal(auth.secretsEqual(SECRET, ""), false);
  assert.equal(auth.secretsEqual(SECRET, "a".repeat(1024)), false);
});

test("the auth context is installed non-enumerably, gets its origin later and can be cleared", () => {
  const previous = process.env.PI_WEB_DESKTOP;
  delete process.env.PI_WEB_DESKTOP;
  auth.setDesktopAuthContext(context);
  try {
    assert.equal(auth.isDesktopMode(), true);
    assert.deepEqual(auth.getDesktopAuthContext(), context);
    const key = Symbol.for("pi-web.desktop-auth");
    assert.equal(Object.getOwnPropertyDescriptor(globalThis, key)?.enumerable, false);
    assert.deepEqual(Object.getOwnPropertySymbols(globalThis).includes(key), true);

    auth.setDesktopAuthOrigin("http://127.0.0.1:49200");
    assert.equal(auth.getDesktopAuthContext()?.origin, "http://127.0.0.1:49200");

    auth.clearDesktopAuthContext();
    assert.equal(auth.getDesktopAuthContext(), undefined);
    // A bundle that cannot see the context still knows the mode from the flag.
    process.env.PI_WEB_DESKTOP = "1";
    assert.equal(auth.isDesktopMode(), true);
  } finally {
    auth.clearDesktopAuthContext();
    if (previous === undefined) delete process.env.PI_WEB_DESKTOP;
    else process.env.PI_WEB_DESKTOP = previous;
  }
});
