"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { columnBand, overlayCoversContent, type RectLike } from "@/lib/overlay-obscures";

/** A measurement taken before the column or the panel has its data retries
 *  itself, so an empty first frame cannot leave the panel open for good. */
const RETRY_MS = 400;
const RETRY_LIMIT = 3;

function rectOf(element: Element): RectLike {  const rect = element.getBoundingClientRect();
  return {
    top: rect.top,
    bottom: rect.bottom,
    left: rect.left,
    right: rect.right,
    width: rect.width,
    height: rect.height,
  };
}

/**
 * True while the open overlay would reach into `scrollRef`'s scroller.
 *
 * The railed strip must still be measured as the open panel, or it would see
 * nothing behind itself, open again, cover content, and rail on the next frame.
 * `railed` says which box the caller is showing, so the strip reuses the last
 * open-panel rect it recorded; the panel's bottom edge is anchored, so that box
 * only goes stale while it is railed — and it re-measures as soon as it opens.
 *
 * Listening: the scroller's scroll, window resize, and a ResizeObserver on the
 * overlay, the scroller and its content. Measurements coalesce into one frame.
 *
 * The box compared is the one the messages occupy, not the scroller's viewport:
 * the viewport reaches down to the composer in every chat, so a panel measured
 * against it would rail even beside an empty half-screen. `messageColumnRef`
 * names the centred column the messages are laid out in; without it the
 * scroller's inner wrapper is used, which spans the column's full width.
 */
export function useOverlayObscuresContent(
  overlayRef: RefObject<HTMLElement | null>,
  scrollRef: RefObject<HTMLElement | null> | undefined,
  enabled: boolean,
  railed = false,
  messageColumnRef?: RefObject<HTMLElement | null>,
): boolean {
  const [obscured, setObscured] = useState(false);
  // Read inside the frame callback, so a rail/open change does not re-subscribe.
  const railedRef = useRef(railed);
  railedRef.current = railed;

  useEffect(() => {
    if (!enabled) {
      setObscured(false);
      return;
    }
    const overlay = overlayRef.current;
    const scroll = scrollRef?.current;
    if (!overlay || !scroll) {
      setObscured(false);
      return;
    }

    let frame = 0;
    let lastOpenRect: RectLike | null = null;
    let unmounted = false;

    const contentOf = () => messageColumnRef?.current ?? scroll.firstElementChild;

    // A panel whose data arrives one poll later, or a column laid out a frame
    // after its first paint, would otherwise measure as "nothing to cover" and
    // stay open until some unrelated event re-ran the measurement.
    let retryTimer = 0;
    let retries = 0;
    const scheduleRetry = () => {
      if (retryTimer || unmounted || retries >= RETRY_LIMIT) return;
      retries += 1;
      retryTimer = window.setTimeout(() => {
        retryTimer = 0;
        schedule();
      }, RETRY_MS);
    };

    const measure = () => {
      frame = 0;
      if (unmounted) return;
      const live = rectOf(overlay);
      if (!railedRef.current && live.height > 0 && live.width > 0) lastOpenRect = live;
      // While railed the box on screen is the strip, but the strip shares the
      // open panel's bottom edge: rebasing the remembered box on that edge keeps
      // the answer right when a resize moves the whole shelf, instead of holding
      // a box measured at a height the window no longer has.
      const open = railedRef.current && lastOpenRect
        ? { ...lastOpenRect, top: live.bottom - lastOpenRect.height, bottom: live.bottom }
        : lastOpenRect;
      const box = open ?? (live.height > 0 ? live : null);
      if (!box) {
        scheduleRetry();
        return;
      }
      const column = contentOf();
      const occupied = columnBand(rectOf(scroll), column ? rectOf(column) : null);
      if (!occupied) {
        setObscured(false);
        scheduleRetry();
        return;
      }
      retries = 0;
      const next = overlayCoversContent(box, occupied);
      setObscured((previous) => (previous === next ? previous : next));
    };

    const schedule = () => {
      if (frame || unmounted) return;
      frame = window.requestAnimationFrame(measure);
    };

    schedule();
    scroll.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(schedule) : null;
    observer?.observe(overlay);
    observer?.observe(scroll);
    const content = contentOf();
    if (content) observer?.observe(content);

    // Rows and counts change without changing the panel's box (a task finishing,
    // a todo checked off), and the box only grows once its data lands.
    const mutations = typeof MutationObserver === "function" ? new MutationObserver(schedule) : null;
    const mutationOptions = { childList: true, subtree: true, characterData: true } as const;
    mutations?.observe(overlay, mutationOptions);
    if (content) mutations?.observe(content, mutationOptions);

    return () => {
      unmounted = true;
      if (frame) window.cancelAnimationFrame(frame);
      if (retryTimer) window.clearTimeout(retryTimer);
      scroll.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      observer?.disconnect();
      mutations?.disconnect();
    };
  }, [enabled, overlayRef, scrollRef, messageColumnRef]);

  return obscured;
}
