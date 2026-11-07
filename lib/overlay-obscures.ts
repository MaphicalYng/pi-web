/**
 * Whether a floating overlay takes room from the chat's messages.
 *
 * The overlay sits above the composer, over the message list's lower left
 * corner, and grows upward as it gains rows. When its box reaches the band the
 * conversation's own column occupies, it rails itself to a narrow strip against
 * the chat column's left edge; while it stays clear of that column, it stays
 * open.
 *
 * The test is deliberately geometric, and it measures the **column's band**, not
 * the text: the blank space under a short conversation is part of the column a
 * reader is about to fill, so a panel that has entered the column's width has
 * taken a share of the conversation. Only the vertical extent comes from the
 * scroller (it ends at the composer), which is what lets a wide window — one
 * whose column starts to the right of the panel — keep the panel open.
 *
 * An earlier version hit-tested the overlay's area for text and only railed
 * over a word; that answer flapped as the list scrolled (the same box covered
 * text, then blank padding, then text), and a panel that flickers between two
 * shapes is worse than one that rails a little eagerly. Column boxes stay put
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
 * The band the chat column occupies inside the scroller: the column's own left
 * and right edges, and the scroller's visible height.
 *
 * The vertical extent is the scroller's, not the content's: an overlay that has
 * entered the column's width has taken a share of the conversation's own column
 * — the blank space below a short conversation is where its next message lands —
 * so the panel rails there rather than only once it touches a line of text. A
 * wide window (the column starts to the right of the panel) still leaves room to
 * stay open. `null` when nothing is visible.
 */
export function columnBand(scroll: RectLike, column: RectLike | null): RectLike | null {
  const left = Math.max(scroll.left, column ? column.left : scroll.left);
  const right = Math.min(scroll.right, column ? column.right : scroll.right);
  const top = scroll.top;
  const bottom = scroll.bottom;
  if (!(bottom > top) || !(right > left)) return null;
  return { top, bottom, left, right, width: right - left, height: bottom - top };
}

/**
 * Whether a panel, as drawn open, would take room from the column.
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
