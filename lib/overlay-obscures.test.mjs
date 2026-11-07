import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { overlapsScrollViewport, overlayCoversContent } = await jiti.import("./overlay-obscures.ts");

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

test("the panel covers the chat only once it reaches into the viewport", () => {
  // A one-row summary just below the conversation: stays open.
  assert.equal(overlayCoversContent(rect(523, 276, 420, 67), scroller), false);
  // Grown tall enough to reach back into the scroller: rails.
  assert.equal(overlayCoversContent(rect(465, 276, 420, 125), scroller), true);
});

test("an unrendered panel covers nothing", () => {
  assert.equal(overlayCoversContent(rect(400, 276, 0, 0), scroller), false);
  assert.equal(overlayCoversContent(rect(400, 276, 420, 0), scroller), false);
});
