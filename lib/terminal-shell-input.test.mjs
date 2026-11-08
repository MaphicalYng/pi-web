import assert from "node:assert/strict";
import test from "node:test";
import { isExitCommand, NO_SHELL_INPUT, trackShellInput } from "./terminal-shell-input.ts";

/** Types a string one chunk at a time, as xterm reports keystrokes. */
function type(state, keys) {
  let next = state;
  for (const char of keys) next = trackShellInput(next, char);
  return next;
}

/** Types a line and presses Enter: true when the dock should close on the exit that follows. */
function submits(keys) {
  return type(NO_SHELL_INPUT, `${keys}\r`).exitCommand;
}

test("only an exit command counts, whatever spacing or code the reader gives it", () => {
  for (const line of ["exit", " exit ", "exit 0", "exit 1", "exit -1", "exit\t", "logout", "EXIT"]) {
    assert.equal(isExitCommand(line), line !== "EXIT", line);
  }
  for (const line of ["", "exi", "exit now", "exited", "echo exit", "exit;ls", "sudo exit"]) {
    assert.equal(isExitCommand(line), false, line);
  }
});

test("a submitted exit closes the dock, a submitted command does not", () => {
  assert.equal(submits("exit"), true);
  assert.equal(submits("exit 1"), true);
  assert.equal(submits("logout"), true);
  assert.equal(submits("echo exit"), false);
  assert.equal(submits("ls"), false);
  assert.equal(submits(""), false);
});

test("typing exit without Enter leaves the shell running and the dock open", () => {
  const state = type(NO_SHELL_INPUT, "exit");
  assert.deepEqual(state, { line: "exit", exitCommand: false });
});

test("backspace edits are followed, so a mistyped exit still counts once fixed", () => {
  assert.equal(submits("exitx\x7f"), true);
  assert.equal(submits("ex" + "\x7fi"), false);
});

test("keys that move or clear the line make the tracked text untrustworthy", () => {
  // Ctrl+C, Ctrl+U, Ctrl+L: the prompt takes a fresh line.
  for (const key of ["\x03", "\x15", "\x0c"]) assert.equal(submits(`ls${key}exit`), true, key);
  // An arrow key edits a cursor this tracker cannot follow: no close, rather than the wrong one.
  assert.equal(submits("\x1b[Aexit"), false);
  // Tab completion may expand what was typed, so the line is dropped.
  assert.equal(submits("exi\t"), false);
});

test("typing after a submitted exit cancels it: the prompt answered instead of exiting", () => {
  const submitted = type(NO_SHELL_INPUT, "exit\r");
  assert.equal(submitted.exitCommand, true);
  assert.equal(trackShellInput(submitted, "y").exitCommand, false);
  assert.equal(trackShellInput(trackShellInput(submitted, "y"), "\r").exitCommand, false);
});

test("a pasted multi-line block reports its last line's verdict", () => {
  assert.equal(trackShellInput(NO_SHELL_INPUT, "cd /tmp\rls\rexit\r").exitCommand, true);
  assert.equal(trackShellInput(NO_SHELL_INPUT, "exit\rls\r").exitCommand, false);
});

test("an unchanged chunk returns the same state", () => {
  const idle = NO_SHELL_INPUT;
  assert.equal(trackShellInput(idle, ""), idle);
  assert.equal(trackShellInput(idle, "\x7f"), idle);
});

test("a huge paste does not grow the tracked line without bound", () => {
  const state = trackShellInput(NO_SHELL_INPUT, "x".repeat(2000));
  assert.equal(state.line.length, 512);
  assert.equal(state.exitCommand, false);
});
