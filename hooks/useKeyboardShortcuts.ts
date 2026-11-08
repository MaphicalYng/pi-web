"use client";

import { useEffect } from "react";

// ---------------------------------------------------------------------------
// Module-level registry — ChatWindow registers the abort handler here so that
// the global Esc listener in AppShell can call it without prop-drilling.
// ---------------------------------------------------------------------------
let globalAbortHandler: (() => void) | null = null;

/**
 * Register (or clear) the abort handler for the global Esc shortcut.
 * Call this from ChatWindow whenever agentRunning or handleAbort changes.
 */
export function registerAbortHandler(handler: (() => void) | null): void {
  globalAbortHandler = handler;
}

/**
 * The global Esc shortcut: stops the running agent, unless the key belongs to
 * something else. Typed into a textarea or input, it is that field's (ChatInput
 * has its own Esc logic). Marked handled already (`defaultPrevented`), it was
 * something nearer's: Settings, a menu or a viewer that closed on it. Those
 * listen on `document` or below and run before this one on `window`, and
 * closing them must not stop a run as well. Returns whether it stopped the
 * agent.
 */
export function handleGlobalEscape(event: KeyboardEvent): boolean {
  if (event.key !== "Escape" || event.defaultPrevented || !globalAbortHandler) return false;

  const tag = (event.target as HTMLElement | null)?.tagName;
  // Let textarea/input handle Esc internally (ChatInput menus / stop).
  if (tag === "TEXTAREA" || tag === "INPUT") return false;

  event.preventDefault();
  globalAbortHandler();
  return true;
}

/**
 * Whether a keydown is the Ctrl+Alt+N "new session" shortcut.
 *
 * The letter decides (`event.key`), so the shortcut follows the layout. Two
 * platforms bend that:
 * - macOS treats Option as a character-input modifier: `Option+N` is a dead
 *   key (`˜`) in the U.S., ABC and British layouts, and Chrome reports
 *   `key === "Dead"` with `ctrlKey`/`altKey` intact (#1335). A dead key types
 *   nothing yet, so the physical key (`code === "KeyN"`) decides there.
 * - Windows reports AltGr as Ctrl+Alt. When the combination types a character
 *   (Polish AltGr+N is `ń`), that `key` is the user's text: matching `code`
 *   alone would swallow it and open a session instead.
 */
export function isNewSessionShortcut(event: {
  key: string;
  code?: string | null;
  ctrlKey: boolean;
  altKey: boolean;
}): boolean {
  if (!event.ctrlKey || !event.altKey) return false;
  if (event.key.toLowerCase() === "n") return true;
  return event.key === "Dead" && event.code === "KeyN";
}

/**
 * Whether a keydown is the `Ctrl+`` bottom terminal shortcut.
 *
 * The physical key decides (`event.code`): with Ctrl held, what a layout types
 * on the key left of `1` is its own (a German keyboard's `` ` `` is `´`, a
 * Czech one's `'`), while the key is in the same place everywhere. An event
 * built by hand, or one from a browser without `code`, matches on the
 * character instead.
 *
 * Cmd+` is macOS's window switcher and AltGr arrives as Ctrl+Alt on Windows, so
 * both are left alone; so is Shift, whose Ctrl+Shift+` is a character of its
 * own and no shortcut here.
 */
export function isTerminalDockShortcut(event: {
  key: string;
  code?: string | null;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}): boolean {
  if (!event.ctrlKey || event.altKey || event.metaKey) return false;
  if (event.code) return event.code === "Backquote" && !event.shiftKey;
  return event.key === "`";
}

// ---------------------------------------------------------------------------
// Hook: global keyboard shortcuts
// ---------------------------------------------------------------------------

interface UseGlobalKeyboardShortcutsOptions {
  /** Called when Ctrl+Alt+N is pressed. Receives current cwd. */
  onNewSession?: (cwd: string) => void;
  /** Called when Ctrl+` is pressed: show the bottom terminal, or hide it again. */
  onToggleTerminal?: () => void;
  /** The currently selected project directory (sidebar cwd). */
  activeCwd?: string | null;
}

/**
 * Register global keyboard shortcuts for the application.
 *
 * Shortcuts handled here:
 *   Esc          – stop the running agent (via module-level abort handler)
 *   Ctrl+Alt+N   – create a new session in the active project directory
 *                  (see `isNewSessionShortcut()` for macOS and AltGr)
 *   Ctrl+`       – show the bottom terminal dock, or hide it again
 *                  (see `isTerminalDockShortcut()` for layouts, Cmd and Shift)
 *
 * Note: Esc inside <textarea> or <input> is deliberately NOT handled here.
 * ChatInput manages its own Esc logic (closing slash / @ file menus, stopping
 * the agent when no menu is open) because it needs intimate knowledge of menu
 * state that is local to that component. Nor is an Esc something nearer
 * already handled (see `handleGlobalEscape()`).
 */
export function useGlobalKeyboardShortcuts(
  options: UseGlobalKeyboardShortcutsOptions,
): void {
  const { onNewSession, onToggleTerminal, activeCwd } = options;

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      // ---- Esc: stop agent ----
      if (e.key === "Escape") {
        handleGlobalEscape(e);
        return;
      }

      // ---- Ctrl+`: the bottom terminal ----
      // Handled from anywhere, a focused terminal included: the shell keeps its
      // own Ctrl+` line editing, so the panel's toggle must win here.
      if (isTerminalDockShortcut(e)) {
        if (!onToggleTerminal) return;
        e.preventDefault();
        onToggleTerminal();
        return;
      }

      // ---- Ctrl+Alt+N: new session ----
      if (isNewSessionShortcut(e)) {
        if (!activeCwd || !onNewSession) return;
        e.preventDefault();
        onNewSession(activeCwd);
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeCwd, onNewSession, onToggleTerminal]);
}
