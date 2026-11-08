/**
 * Every wait in the desktop shell has a deadline here. Nothing may block
 * application quit indefinitely, and no timeout is configurable from the page.
 */

/** utilityProcess must report `ready` within this budget. */
export const BACKEND_READY_TIMEOUT_MS = 30_000;
/** The frozen protocol default: backend has up to 60 s for an orderly shutdown. */
export const BACKEND_SHUTDOWN_TIMEOUT_MS = 60_000;
/** After `stopped` the backend must still really exit within this grace. */
export const BACKEND_STOPPED_EXIT_GRACE_MS = 2_000;
/** After the hard kill, wait this long before giving up on the exit event. */
export const BACKEND_KILL_GRACE_MS = 2_000;

/** The first page must render fully; a bare `ready` is not enough. */
export const FIRST_PAGE_TIMEOUT_MS = 30_000;
export const FIRST_PAGE_MAX_BYTES = 512 * 1024;

export const ACTIVITY_TIMEOUT_MS = 3_000;

export const GUI_ENV_PROBE_TIMEOUT_MS = 3_000;
export const GUI_ENV_PROBE_MAX_BYTES = 128 * 1024;

export const DEV_ORIGIN = "http://127.0.0.1:30141";
export const DEV_PROBE_TIMEOUT_MS = 2_000;
export const DEV_READY_TIMEOUT_MS = 60_000;
export const DEV_HEALTH_POLL_INTERVAL_MS = 250;
export const DEV_STOP_GRACE_MS = 5_000;

export const LOG_MAX_BYTES = 1024 * 1024;
export const LOG_LINE_MAX_CHARS = 8 * 1024;
export const FATAL_TEXT_MAX_CHARS = 2 * 1024;

export const APP_WINDOW_TITLE = "Pi Web";
export const APP_WINDOW_BACKGROUND = "#111111";
