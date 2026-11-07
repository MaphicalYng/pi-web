/**
 * Whether a floating overlay covers the chat.
 *
 * The overlay sits above the composer, over the message list's lower left
 * corner, and grows upward as it gains rows. When its box reaches into the
 * scroller's viewport it railed itself to a narrow strip against the chat
 * column's left edge; when it stays below that viewport, it stays open.
 *
 * The test is deliberately geometric. An earlier version hit-tested the
 * overlay's area for text and only railed over a word; that answer flapped as
 * the list scrolled (the same box covered text, then blank padding, then text),
 * and a panel that flickers between two shapes is worse than one that rails a
 * little eagerly. Overlap with the scroller is stable, cheap, and matches what
 * a reader sees: the panel's lower-left corner sitting over the conversation.
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
 * Whether a panel, as drawn open, would cover the conversation.
 *
 * Both boxes are viewport coordinates. A panel with no area covers nothing.
 */
export function overlayCoversContent(overlay: RectLike, scroll: RectLike): boolean {
  if (!(overlay.width > 0) || !(overlay.height > 0)) return false;
  return overlapsScrollViewport(overlay, scroll);
}
