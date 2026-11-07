import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { overlapsScrollViewport, contentOccupies, overlayCoversContent } = await jiti.import("./overlay-obscures.ts");

const rect = (top, left, width, height) => ({
  top,
  left,
  width,
  height,
  bottom: top + height,
  right: left + width,
});

// The chat scroller in a 633px-tall window: from under the branch label to the
// composer, left of the chat column's x = 260.
const scroller = rect(65, 260, 984, 428.5);

test("a box above the viewport or beside it does not overlap", () => {
  assert.equal(overlapsScrollViewport(rect(-300, 260, 420, 260), scroller), false);
  assert.equal(overlapsScrollViewport(rect(100, 1260, 420, 260), scroller), false);
  assert.equal(overlapsScrollViewport(rect(100, 260, 420, 260), scroller), true);
});

test("touching the viewport's bottom edge without entering it is not overlap", () => {
  assert.equal(overlapsScrollViewport(rect(493.5, 260, 420, 120), scroller), false);
  assert.equal(overlapsScrollViewport(rect(493, 260, 420, 120), scroller), true);
});

test("the occupied box ends where the messages end, not where the scroller does", () => {
  // A short conversation: the wrapper stops two thirds down the scroller.
  const short = contentOccupies(scroller, rect(73, 260, 984, 260));
  assert.deepEqual(short, {
    top: 73,
    bottom: 333,
    left: 260,
    right: 1244,
    width: 984,
    height: 260,
  });
  // A long one: clipped to the visible part of the scroller.
  const long = contentOccupies(scroller, rect(-200, 260, 984, 800));
  assert.equal(long.top, 65);
  assert.equal(long.bottom, 493.5);
});

test("content scrolled entirely past the viewport occupies nothing", () => {
  assert.equal(contentOccupies(scroller, rect(600, 260, 984, 240)), null);
  assert.equal(contentOccupies(scroller, rect(-400, 260, 984, 200)), null);
  assert.equal(contentOccupies(scroller, null), null);
});

test("the panel covers the chat only once it reaches into the messages", () => {
  // The conversation stops at 333: a panel below it stays open, even though the
  // scroller itself reaches the composer at 493.5.
  const short = contentOccupies(scroller, rect(73, 260, 984, 260));
  assert.equal(overlayCoversContent(rect(340, 276, 420, 100), short), false);
  // Grown tall enough to reach the last message: rails.
  assert.equal(overlayCoversContent(rect(320, 276, 420, 120), short), true);
  // Beside the column, never over it.
  assert.equal(overlayCoversContent(rect(200, 1244, 420, 200), short), false);

  // A conversation that fills the viewport is covered as soon as the panel
  // enters it.
  const long = contentOccupies(scroller, rect(-200, 260, 984, 800));
  assert.equal(overlayCoversContent(rect(523, 276, 420, 67), long), false);
  assert.equal(overlayCoversContent(rect(465, 276, 420, 125), long), true);
});

test("an unrendered panel covers nothing", () => {
  const short = contentOccupies(scroller, rect(73, 260, 984, 260));
  assert.equal(overlayCoversContent(rect(400, 276, 0, 0), short), false);
  assert.equal(overlayCoversContent(rect(400, 276, 420, 0), short), false);
});
