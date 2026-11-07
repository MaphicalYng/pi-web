"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { overlayCoversContent, type RectLike } from "@/lib/overlay-obscures";

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
 */
export function useOverlayObscuresContent(
  overlayRef: RefObject<HTMLElement | null>,
  scrollRef: RefObject<HTMLElement | null> | undefined,
  enabled: boolean,
  railed = false,
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

    const measure = () => {
      frame = 0;
      if (unmounted) return;
      const live = rectOf(overlay);
      if (!railedRef.current && live.height > 0 && live.width > 0) lastOpenRect = live;
      const box = lastOpenRect ?? (live.height > 0 ? live : null);
      if (!box) return;
      const next = overlayCoversContent(box, rectOf(scroll));
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
    const content = scroll.firstElementChild;
    if (content) observer?.observe(content);

    return () => {
      unmounted = true;
      if (frame) window.cancelAnimationFrame(frame);
      scroll.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      observer?.disconnect();
    };
  }, [enabled, overlayRef, scrollRef]);

  return obscured;
}
