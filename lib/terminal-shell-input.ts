/**
 * The line a reader is typing into a terminal, tracked far enough to tell the `exit` they typed
 * from a shell that ended some other way. Only the first closes the bottom dock: a crashed shell,
 * a terminated one, or a dropped connection keeps its pane and its exit notice.
 */
export interface ShellInputState {
  /** What the prompt has received since its last newline, as far as xterm reported it. */
  line: string;
  /** Whether the last submitted line was an exit command, with nothing typed since. */
  exitCommand: boolean;
}

export const NO_SHELL_INPUT: ShellInputState = { line: "", exitCommand: false };

/** Longer than any exit command: stop growing instead of holding a pasted file in memory. */
const MAX_TRACKED_LINE = 512;

/** `exit`, `exit 0`, `exit -1`, `logout`: what ends a shell on purpose. */
const EXIT_COMMAND = /^\s*(?:exit(?:\s+-?\d+)?|logout)\s*$/;

export function isExitCommand(line: string): boolean {
  return EXIT_COMMAND.test(line);
}

/**
 * Keys after which the prompt's line is no longer the one we tracked: Ctrl+C, Ctrl+U, Ctrl+L, and
 * an escape sequence (arrows, Home/End, which move a cursor we cannot follow). Tab is here too: a
 * completion inserts text we never see, so such a line is not trusted as an exit command.
 */
const DISCARD_LINE = new Set(["\x03", "\x15", "\x0c", "\x1b", "\t"]);

/**
 * Feeds one `onData` chunk (xterm reports keystrokes, pasted text and control keys through it) and
 * returns the state after it. A line only counts as an exit command once it is submitted: what it
 * may still turn into is not known before Enter.
 */
export function trackShellInput(state: ShellInputState, data: string): ShellInputState {
  let line = state.line;
  let exitCommand = state.exitCommand;
  let changed = false;
  for (const char of data) {
    if (char === "\r" || char === "\n") {
      exitCommand = isExitCommand(line);
      line = "";
      changed = true;
    } else if (char === "\x7f" || char === "\b") {
      if (!line) continue;
      line = line.slice(0, -1);
      changed = true;
    } else if (DISCARD_LINE.has(char) || char < " ") {
      // Whatever is typed next is a fresh line, and nothing submitted before it is still pending.
      if (line || exitCommand) changed = true;
      line = "";
      exitCommand = false;
    } else if (line.length < MAX_TRACKED_LINE) {
      // Typing again means the prompt answered instead of exiting: drop a pending exit command.
      if (exitCommand) {
        exitCommand = false;
        changed = true;
      }
      line += char;
      changed = true;
    }
  }
  if (!changed) return state;
  return { line, exitCommand };
}
