import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ALLOWED_PERMISSIONS,
  installNavigationGuards,
  installSessionGuards,
  linkAction,
  permissionAllowed,
  safeScheme,
} from "../navigation.ts";

const ORIGIN = "http://127.0.0.1:30141";

class FakeEvent {
  prevented = 0;
  preventDefault() {
    this.prevented += 1;
  }
}

function fakeContents() {
  const handlers = {};
  const windowOpen = [];
  return {
    contents: {
      setWindowOpenHandler: (handler) => windowOpen.push(handler),
      on: (event, handler) => {
        handlers[event] = handler;
      },
    },
    windowOpen,
    handlers,
  };
}

function makeGuards(origin = ORIGIN) {
  const { contents, windowOpen, handlers } = fakeContents();
  const opened = [];
  const created = [];
  const logs = [];
  installNavigationGuards(contents, {
    origin: () => origin,
    openExternal: (url) => opened.push(url),
    createSecureWindow: (url) => created.push(url),
    log: (level, event, fields) => logs.push({ level, event, fields }),
  });
  return { contents, windowOpen, handlers, opened, created, logs };
}

test("linkAction separates in-app navigation, external links and everything else", () => {
  assert.equal(linkAction(`${ORIGIN}/session/1`, ORIGIN), "navigate");
  assert.equal(linkAction("https://example.com/docs", ORIGIN), "external");
  assert.equal(linkAction("http://user:pass@example.com/", ORIGIN), "deny");
  assert.equal(linkAction("file:///etc/passwd", ORIGIN), "deny");
  assert.equal(linkAction("javascript:alert(1)", ORIGIN), "deny");
  assert.equal(linkAction("myapp://open", ORIGIN), "deny");
  assert.equal(linkAction(`${ORIGIN}/session/1`, null), "deny");
  assert.equal(linkAction("http://127.0.0.1:9/anything", ORIGIN), "deny");
  assert.equal(linkAction("http://127.0.0.1:9/", null), "deny");
});

test("same-origin navigation stays in place without preventDefault", () => {
  const { handlers, opened, logs } = makeGuards();
  const event = new FakeEvent();
  handlers["will-navigate"](event, `${ORIGIN}/session/2`);
  assert.equal(event.prevented, 0);
  assert.equal(opened.length, 0);
  assert.equal(logs.length, 0);
});

test("a same-origin will-navigate continues in place with no external hand-off", () => {
  const { handlers, opened, created, logs } = makeGuards();
  for (const url of [`${ORIGIN}/session/2?tab=chat#tail`, `${ORIGIN}/`, `${ORIGIN}/files/a%20b`]) {
    const event = new FakeEvent();
    handlers["will-navigate"](event, url);
    assert.equal(event.prevented, 0, url);
  }
  assert.deepEqual(opened, []);
  assert.deepEqual(created, []);
  assert.equal(logs.length, 0);
});

test("a loopback URL is blocked unless it matches the known origin, and never opened externally", () => {
  const known = makeGuards();
  const otherPort = new FakeEvent();
  known.handlers["will-navigate"](otherPort, "http://127.0.0.1:9/");
  assert.equal(otherPort.prevented, 1);
  assert.deepEqual(known.opened, []);
  assert.deepEqual(known.created, []);

  const unknown = makeGuards(null);
  for (const url of [`${ORIGIN}/`, "http://127.0.0.1:9/"]) {
    const event = new FakeEvent();
    unknown.handlers["will-navigate"](event, url);
    assert.equal(event.prevented, 1, url);
  }
  assert.deepEqual(unknown.opened, []);
  assert.equal(unknown.logs[0].event, "window.navigation_blocked");
  assert.equal(unknown.logs[0].fields.scheme, "http:");

  const external = new FakeEvent();
  unknown.handlers["will-navigate"](external, "https://example.com/docs");
  assert.equal(external.prevented, 1);
  assert.deepEqual(unknown.opened, ["https://example.com/docs"]);
});

test("external links open exactly once and blocked schemes never reach the OS", () => {
  const { handlers, opened, logs } = makeGuards();
  const event = new FakeEvent();
  handlers["will-navigate"](event, "https://example.com/path?q=1");
  assert.equal(event.prevented, 1);
  assert.deepEqual(opened, ["https://example.com/path?q=1"]);
  assert.equal(logs[0].event, "window.external_opened");
  assert.equal(logs[0].fields.scheme, "https:");

  const blocked = new FakeEvent();
  handlers["will-redirect"](blocked, "file:///Users/me/.ssh/id_rsa");
  assert.equal(blocked.prevented, 1);
  assert.equal(opened.length, 1);
  assert.equal(logs[1].event, "window.navigation_blocked");
  assert.equal(logs[1].fields.scheme, "file:");
});

test("window.open always denies but routes same-origin and external targets safely", () => {
  const { windowOpen, opened, created, logs } = makeGuards();
  const handler = windowOpen[0];
  assert.deepEqual(handler({ url: `${ORIGIN}/session/3` }), { action: "deny" });
  assert.deepEqual(created, [`${ORIGIN}/session/3`]);
  assert.deepEqual(handler({ url: "https://example.com" }), { action: "deny" });
  assert.deepEqual(opened, ["https://example.com"]);
  assert.deepEqual(handler({ url: "data:text/html,x" }), { action: "deny" });
  assert.equal(logs.at(-1).event, "window.open_blocked");
});

test("webview attachment is refused", () => {
  const { handlers, logs } = makeGuards();
  const event = new FakeEvent();
  handlers["will-attach-webview"](event);
  assert.equal(event.prevented, 1);
  assert.equal(logs[0].event, "window.webview_blocked");
});

test("permissions are default-deny and limited to the backend origin", () => {
  assert.deepEqual(ALLOWED_PERMISSIONS, ["notifications", "fullscreen", "clipboard-sanitized-write"]);
  assert.equal(permissionAllowed("notifications", ORIGIN, ORIGIN), true);
  assert.equal(permissionAllowed("notifications", `${ORIGIN}/`, ORIGIN), true);
  assert.equal(permissionAllowed("camera", ORIGIN, ORIGIN), false);
  assert.equal(permissionAllowed("notifications", "https://evil.example", ORIGIN), false);
  assert.equal(permissionAllowed("notifications", ORIGIN, null), false);
  assert.equal(permissionAllowed("notifications", null, ORIGIN), false);
});

test("session guards grant only allow-listed same-origin requests and log denials", () => {
  let requestHandler;
  let checkHandler;
  const logs = [];
  installSessionGuards(
    {
      setPermissionRequestHandler: (handler) => {
        requestHandler = handler;
      },
      setPermissionCheckHandler: (handler) => {
        checkHandler = handler;
      },
    },
    { origin: () => ORIGIN, log: (level, event, fields) => logs.push({ level, event, fields }) },
  );
  let granted;
  requestHandler({}, "notifications", (value) => {
    granted = value;
  }, { requestingUrl: `${ORIGIN}/chat` });
  assert.equal(granted, true);
  requestHandler({}, "camera", (value) => {
    granted = value;
  }, { requestingUrl: `${ORIGIN}/chat` });
  assert.equal(granted, false);
  assert.equal(checkHandler({}, "fullscreen", ORIGIN), true);
  assert.equal(checkHandler({}, "fullscreen", "https://evil.example"), false);
  assert.ok(logs.some((entry) => entry.event === "permission.granted"));
  assert.ok(logs.some((entry) => entry.event === "permission.denied"));
});

test("safeScheme logs the scheme only", () => {
  assert.equal(safeScheme("https://user:pass@example.com/a?b=1"), "https:");
  assert.equal(safeScheme("nonsense"), "invalid:");
});
