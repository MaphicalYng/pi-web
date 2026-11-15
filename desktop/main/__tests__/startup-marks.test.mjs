import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createStartupMarker,
  startupPerfEnabled,
  STARTUP_MARK_NAMES,
} from "../startup-marks.ts";

test("startupPerfEnabled requires PI_WEB_PERF=1 exactly", () => {
  assert.equal(startupPerfEnabled({ PI_WEB_PERF: "1" }), true);
  assert.equal(startupPerfEnabled({}), false);
  assert.equal(startupPerfEnabled({ PI_WEB_PERF: "0" }), false);
  assert.equal(startupPerfEnabled({ PI_WEB_PERF: "true" }), false);
});

test("without PI_WEB_PERF the marker records nothing and writes no log", () => {
  const emitted = [];
  let ticks = 0;
  const marker = createStartupMarker({
    enabled: startupPerfEnabled({}),
    now: () => (ticks += 10),
    emit: (marks) => emitted.push(marks),
  });
  for (const name of STARTUP_MARK_NAMES) marker.mark(name);
  assert.deepEqual(emitted, []);
});

test("with PI_WEB_PERF the report carries all 6 marks and emits once", () => {
  const emitted = [];
  let ticks = 0;
  const marker = createStartupMarker({
    enabled: startupPerfEnabled({ PI_WEB_PERF: "1" }),
    now: () => (ticks += 10),
    emit: (marks) => emitted.push(marks),
  });
  // The production phase order; the emit fires only after the last one.
  for (const name of STARTUP_MARK_NAMES) {
    marker.mark(name);
  }
  assert.equal(emitted.length, 1);
  assert.deepEqual(Object.keys(emitted[0]).sort(), [...STARTUP_MARK_NAMES].sort());
  assert.deepEqual(emitted[0], {
    "app-ready": 10,
    "window-created": 20,
    "env-resolved": 30,
    "backend-ready": 40,
    "cookie-set": 50,
    "first-load-finished": 60,
  });
});

test("marks are one-shot: repeats neither rewrite a phase nor re-emit", () => {
  const emitted = [];
  let ticks = 0;
  const marker = createStartupMarker({
    enabled: true,
    now: () => (ticks += 10),
    emit: (marks) => emitted.push(marks),
  });
  marker.mark("app-ready");
  marker.mark("app-ready");
  marker.mark("first-load-finished");
  marker.mark("first-load-finished");
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0]["app-ready"], 10);
});

test("a development launch (no cookie phase) still emits its five marks", () => {
  const emitted = [];
  const marker = createStartupMarker({ enabled: true, now: () => 5, emit: (marks) => emitted.push(marks) });
  for (const name of ["app-ready", "window-created", "env-resolved", "backend-ready", "first-load-finished"]) {
    marker.mark(name);
  }
  assert.equal(emitted.length, 1);
  assert.equal("cookie-set" in emitted[0], false);
});
