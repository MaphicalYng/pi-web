import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { overlapsScrollViewport, columnBand, overlayCoversContent } = await jiti.import("./overlay-obscures.ts");

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

test("the band the column occupies spans the scroller's visible height", () => {
  // A short conversation: its text stops two thirds down the scroller, but the
  // blank space below it is still the column's, so the band reaches the
  // composer.
  const band = columnBand(scroller, rect(73, 260, 984, 260));
  assert.deepEqual(band, {
    top: 65,
    bottom: 493.5,
    left: 260,
    right: 1244,
    width: 984,
    height: 428.5,
  });
});

test("a column narrower than the scroller narrows the band", () => {
  const band = columnBand(scroller, rect(73, 304, 820, 260));
  assert.equal(band.left, 304);
  assert.equal(band.right, 1124);
  assert.equal(band.width, 820);
});

test("without a column, the scroller's own width is the band", () => {
  const band = columnBand(scroller, null);
  assert.equal(band.left, 260);
  assert.equal(band.right, 1244);
});

test("a scroller with no visible height occupies nothing", () => {
  assert.equal(columnBand(rect(493.5, 260, 984, 0), rect(73, 260, 984, 260)), null);
  assert.equal(columnBand(rect(65, 1244, 0, 428.5), rect(73, 260, 984, 260)), null);
});

test("the panel takes room from the chat once it enters the column's band", () => {
  const band = columnBand(scroller, rect(73, 260, 984, 260));
  // Below the last message of a short conversation, still inside the column.
  assert.equal(overlayCoversContent(rect(340, 276, 420, 100), band), true);
  // Beside the column, never over it.
  assert.equal(overlayCoversContent(rect(200, 1244, 420, 200), band), false);
  // Above the scroller entirely (a tall window leaves the band lower).
  assert.equal(overlayCoversContent(rect(-40, 276, 420, 100), band), false);
});

test("an unrendered panel covers nothing", () => {
  const band = columnBand(scroller, rect(73, 260, 984, 260));
  assert.equal(overlayCoversContent(rect(400, 276, 0, 0), band), false);
  assert.equal(overlayCoversContent(rect(400, 276, 420, 0), band), false);
});
