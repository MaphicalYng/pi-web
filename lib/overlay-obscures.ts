/**
 * Whether a floating overlay covers the chat's messages.
 *
 * The overlay sits above the composer, over the message list's lower left
 * corner, and grows upward as it gains rows. When its box reaches the box the
 * messages actually occupy, it rails itself to a narrow strip against the chat
 * column's left edge; while it stays below that content, it stays open.
 *
 * The test is deliberately geometric, and it measures **content**, not the
 * scroller's viewport: the scroller always reaches down to the composer, so a
 * panel compared against it would rail even with the conversation half empty,
 * which is what a reader does not see. The content box is the scroller's inner
 * wrapper clipped to the visible part of the scroller.
 *
 * An earlier version hit-tested the overlay's area for text and only railed
 * over a word; that answer flapped as the list scrolled (the same box covered
 * text, then blank padding, then text), and a panel that flickers between two
 * shapes is worse than one that rails a little eagerly. Content boxes stay put
 * while nothing scrolls, and the caller measures the panel as it is drawn open
 * (`lastOpenRect`), so neither shape feeds back into its own answer.
 */

export interface RectLike {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
  height: number;
}

/** True when the overlay's box overlaps the scroller's viewport at all. */
export function overlapsScrollViewport(overlay: RectLike, scroll: RectLike): boolean {
  return overlay.top < scroll.bottom
    && overlay.bottom > scroll.top
    && overlay.left < scroll.right
    && overlay.right > scroll.left;
}

/**
 * The part of a scroller its content occupies, clipped to what the reader can
 * see: the scroller's own left and right edges, and the taller of the two
 * boxes' shared band. `null` when nothing is visible.
 */
export function contentOccupies(scroll: RectLike, content: RectLike | null): RectLike | null {
  if (!content) return null;
  const top = Math.max(scroll.top, content.top);
  const bottom = Math.min(scroll.bottom, content.bottom);
  const left = Math.max(scroll.left, content.left);
  const right = Math.min(scroll.right, content.right);
  if (!(bottom > top) || !(right > left)) return null;
  return { top, bottom, left, right, width: right - left, height: bottom - top };
}

/**
 * Whether a panel, as drawn open, would cover the messages.
 *
 * Both boxes are viewport coordinates. A panel with no area covers nothing.
 */
export function overlayCoversContent(overlay: RectLike, content: RectLike): boolean {
  if (!(overlay.width > 0) || !(overlay.height > 0)) return false;
  if (!(content.width > 0) || !(content.height > 0)) return false;
  return overlay.top < content.bottom
    && overlay.bottom > content.top
    && overlay.left < content.right
    && overlay.right > content.left;
}
