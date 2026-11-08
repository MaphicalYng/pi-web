import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
const globals = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

test("centres a one-line notice in the card its inline min-height pins", () => {
  const minHeight = Number(source.match(/const NOTICE_MIN_HEIGHT_PX = (\d+);/)[1]);
  const lineBox = Number(source.match(/const NOTICE_LINE_BOX_PX = (\d+);/)[1]);

  // The padding is half of what one line leaves of the card - the two 1px
  // borders and a 21px line box out - so the line sits in the middle of the
  // card. Filling the card's min-height from the top instead leaves its
  // leftover under the text, which pushes the line above the centre.
  assert.match(source, /const NOTICE_TEXT_PADDING_Y_PX = \(NOTICE_MIN_HEIGHT_PX - 2 - NOTICE_LINE_BOX_PX\) \/ 2;/);
  const padding = (minHeight - 2 - lineBox) / 2;

  // The card takes that height from the inline style and keeps it: the entrance
  // animation may not touch layout (see the next test), so the height is never
  // animated and the text between the borders has to add up to it exactly.
  assert.match(source, /minHeight: NOTICE_MIN_HEIGHT_PX,/);
  assert.equal(2 * padding + lineBox + 2, minHeight);
});

test("animates a notice with opacity and transform only", () => {
  // Height, max-height, min-height and margin used to be in these keyframes,
  // which re-laid-out the whole transcript on every frame of every toast.
  for (const name of ["notice-shelf-in", "notice-shelf-out"]) {
    const frames = globals.match(new RegExp(`@keyframes ${name} \\{[\\s\\S]*?\\n\\}`));
    assert.ok(frames, `${name} must exist`);
    // The comment above the frames explains the rule; the declarations are what
    // the browser animates.
    const declarations = frames[0].replace(/\/\*[\s\S]*?\*\//g, "");
    assert.doesNotMatch(declarations, /height|margin|padding/);
    assert.match(declarations, /opacity/);
    assert.match(declarations, /transform/);
  }
});

test("measures the notice line box from the card's own font size and line height", () => {
  const lineBox = Number(source.match(/const NOTICE_LINE_BOX_PX = (\d+);/)[1]);
  const card = source.match(/className="notice-shelf-item"[\s\S]*?fontSize: (\d+),\s*lineHeight: ([\d.]+),/);
  assert.equal(Number(card[1]) * Number(card[2]), lineBox);
});
