import assert from "node:assert/strict";
import test from "node:test";
import { newTerminalTab, restoreTerminalDock, restoreTerminalTabs, serializeTerminalDock } from "./terminal-tab-state.ts";

test("restored workspace tabs retain terminal identity and never request a new shell", () => {
  const first = newTerminalTab("/repo/worktree-a");
  const second = newTerminalTab("/repo/worktree-b");
  assert.notEqual(first.id, second.id);
  const saved = restoreTerminalTabs(JSON.stringify({ tabs: [first, second], activeId: second.id, open: true }));
  assert.deepEqual(saved, {
    tabs: [{ ...first, restored: true }, { ...second, restored: true }],
    activeId: second.id,
    open: true,
  });
});

test("storage corruption cannot create invalid or duplicate terminal tabs", () => {
  assert.deepEqual(restoreTerminalTabs("broken"), { tabs: [], activeId: null, open: false });
  assert.deepEqual(restoreTerminalTabs(null), { tabs: [], activeId: null, open: false });
  const tab = newTerminalTab("/repo");
  const saved = restoreTerminalTabs(JSON.stringify({
    tabs: [null, {}, tab, tab, { ...tab, id: "../../bad" }, { ...tab, cwd: null }],
    activeId: "missing",
  }));
  assert.deepEqual(saved, { tabs: [{ ...tab, restored: true }], activeId: null, open: false });
});

test("the bottom dock's saved shell reattaches to its own PTY and keeps being open", () => {
  const tab = newTerminalTab("/repo/worktree-a");
  const saved = restoreTerminalDock(serializeTerminalDock(tab, true));
  assert.deepEqual(saved, { tab: { ...tab, restored: true }, open: true });
  // Hidden is remembered too, without losing the shell behind it.
  assert.deepEqual(restoreTerminalDock(serializeTerminalDock(tab, false)), { tab: { ...tab, restored: true }, open: false });
});

test("a dock with no shell is never open, whatever storage says", () => {
  assert.deepEqual(restoreTerminalDock(serializeTerminalDock(null, true)), { tab: null, open: false });
  assert.deepEqual(restoreTerminalDock(null), { tab: null, open: false });
  assert.deepEqual(restoreTerminalDock("broken"), { tab: null, open: false });
});
