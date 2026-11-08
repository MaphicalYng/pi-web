import { useCallback, useState } from "react";

/** How long a switched-to session's transcript takes to arrive. */
export const SESSION_SWAP_MS = 340;

/**
 * "A session was just switched to, and its transcript has not faded in yet."
 *
 * The chat remounts on a new session (`AppShell` keys `ChatWindow` by
 * `sessionKey`), so the chat itself cannot tell a switch from a first paint -
 * by the time it renders, its own memory is gone. `AppShell` survives the
 * remount, so it holds the flag and hands it down.
 *
 * The flag is not timed here. A switch first shows the chat's loading screen,
 * and a session can take far longer than one animation to load; timing the fade
 * from the click would spend it before a single message appeared. The chat
 * starts the fade when the transcript is actually on screen and calls
 * `settle()` when it is done.
 */
export function useSessionSwap() {
  const [swapping, setSwapping] = useState(false);
  const announce = useCallback(() => setSwapping(true), []);
  const settle = useCallback(() => setSwapping(false), []);
  return { swapping, announce, settle };
}
