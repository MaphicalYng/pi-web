/**
 * The bottom terminal dock: `Ctrl+`` opens a shell under the composer, above
 * the extension shelf, in the project the page shows. It is a terminal of its
 * own, apart from the right panel's tabs: hiding it keeps the shell running,
 * and its height is the reader's, remembered per browser.
 */

/** The dock's height, in px, in this browser (`useResizablePanel`). */
export const TERMINAL_DOCK_HEIGHT_KEY = "pi-web:terminal-dock-height";

/** Defaults and limits, as shares of the chat column the dock sits in. */
export const TERMINAL_DOCK_DEFAULT_RATIO = 0.35;
export const TERMINAL_DOCK_MAX_RATIO = 0.85;
export const TERMINAL_DOCK_MIN_HEIGHT = 120;

/** Before the chat column reports a height: about a 40-line shell. */
const TERMINAL_DOCK_FALLBACK_AVAILABLE = 800;

function availableHeight(available: number): number {
  return Number.isFinite(available) && available > 0 ? available : TERMINAL_DOCK_FALLBACK_AVAILABLE;
}

/** 35% of the chat column, the height a first open (and a double click) gets. */
export function terminalDockDefaultHeight(available: number): number {
  return Math.max(TERMINAL_DOCK_MIN_HEIGHT, Math.round(availableHeight(available) * TERMINAL_DOCK_DEFAULT_RATIO));
}

/** 85% of the chat column: the composer and the shelf stay reachable. */
export function terminalDockMaxHeight(available: number): number {
  return Math.max(TERMINAL_DOCK_MIN_HEIGHT, Math.round(availableHeight(available) * TERMINAL_DOCK_MAX_RATIO));
}
