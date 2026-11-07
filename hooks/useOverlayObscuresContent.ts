"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { contentOccupies, overlayCoversContent, type RectLike } from "@/lib/overlay-obscures";

function rectOf(element: Element): RectLike {
  const rect = element.getBoundingClientRect();
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

    const measure = () => {
      frame = 0;
      if (unmounted) return;
      const live = rectOf(overlay);
      if (!railedRef.current && live.height > 0 && live.width > 0) lastOpenRect = live;
      const box = lastOpenRect ?? (live.height > 0 ? live : null);
      if (!box) return;
      const content = contentOf();
      const occupied = content ? contentOccupies(rectOf(scroll), rectOf(content)) : null;
      const next = occupied ? overlayCoversContent(box, occupied) : false;
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

    return () => {
      unmounted = true;
      if (frame) window.cancelAnimationFrame(frame);
      scroll.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      observer?.disconnect();
    };
  }, [enabled, overlayRef, scrollRef, messageColumnRef]);

  return obscured;
}
