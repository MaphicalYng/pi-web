import assert from "node:assert/strict";
import test from "node:test";
import {
  TERMINAL_DOCK_MIN_HEIGHT,
  terminalDockDefaultHeight,
  terminalDockMaxHeight,
} from "./terminal-dock.ts";

test("the dock starts at 35% of the chat column and never goes under its minimum", () => {
  assert.equal(terminalDockDefaultHeight(1000), 350);
  assert.equal(terminalDockDefaultHeight(720), 252);
  assert.equal(terminalDockDefaultHeight(200), TERMINAL_DOCK_MIN_HEIGHT);
});

test("the dock may take 85% of the chat column, leaving the composer reachable", () => {
  assert.equal(terminalDockMaxHeight(1000), 850);
  assert.equal(terminalDockMaxHeight(400), 340);
  assert.ok(terminalDockMaxHeight(320) >= TERMINAL_DOCK_MIN_HEIGHT);
});

test("a column that has not been measured yet falls back instead of collapsing", () => {
  assert.equal(terminalDockDefaultHeight(0), terminalDockDefaultHeight(800));
  assert.equal(terminalDockMaxHeight(Number.NaN), terminalDockMaxHeight(800));
});
