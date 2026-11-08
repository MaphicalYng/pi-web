import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./extension-dialog-drag.ts");
}

const container = { left: 0, top: 0, right: 1000, bottom: 700 };
/** A 560x300 dialog centred in the container by its overlay. */
const centred = { left: 220, top: 200, right: 780, bottom: 500 };

test("a dialog that fits moves where it is dragged", async () => {
  const { clampDialogOffset, NO_DIALOG_OFFSET } = await loadSubject();
  assert.deepEqual(clampDialogOffset({ x: 120, y: 60 }, NO_DIALOG_OFFSET, centred, container), { x: 120, y: 60 });
  assert.deepEqual(clampDialogOffset({ x: -120, y: -60 }, NO_DIALOG_OFFSET, centred, container), { x: -120, y: -60 });
});

test("a drag stops at the container's edges instead of leaving the chat region", async () => {
  const { clampDialogOffset, NO_DIALOG_OFFSET } = await loadSubject();
  // 220px of room to the left, 220px to the right; 200px up, 200px down.
  assert.deepEqual(clampDialogOffset({ x: -400, y: 0 }, NO_DIALOG_OFFSET, centred, container), { x: -220, y: 0 });
  assert.deepEqual(clampDialogOffset({ x: 400, y: 0 }, NO_DIALOG_OFFSET, centred, container), { x: 220, y: 0 });
  assert.deepEqual(clampDialogOffset({ x: 0, y: -400 }, NO_DIALOG_OFFSET, centred, container), { x: 0, y: -200 });
  assert.deepEqual(clampDialogOffset({ x: 0, y: 400 }, NO_DIALOG_OFFSET, centred, container), { x: 0, y: 200 });
});

test("bounds come from the untranslated box, so an already moved dialog keeps its room", async () => {
  const { clampDialogOffset } = await loadSubject();
  // Rendered 100px right of centre: the base box is still the centred one.
  const moved = { left: 320, top: 200, right: 880, bottom: 500 };
  assert.deepEqual(clampDialogOffset({ x: 140, y: 0 }, { x: 100, y: 0 }, moved, container), { x: 140, y: 0 });
  assert.deepEqual(clampDialogOffset({ x: 400, y: 0 }, { x: 100, y: 0 }, moved, container), { x: 220, y: 0 });
});

test("re-measuring a dialog nobody dragged changes nothing", async () => {
  const { clampDialogOffset, NO_DIALOG_OFFSET } = await loadSubject();
  assert.deepEqual(clampDialogOffset(NO_DIALOG_OFFSET, NO_DIALOG_OFFSET, centred, container), NO_DIALOG_OFFSET);
});

test("an axis the dialog already fills stays put", async () => {
  const { clampDialogOffset, NO_DIALOG_OFFSET } = await loadSubject();
  const full = { left: 0, top: 0, right: 1000, bottom: 700 };
  assert.deepEqual(clampDialogOffset({ x: 60, y: 20 }, NO_DIALOG_OFFSET, full, container), NO_DIALOG_OFFSET);
});

test("an axis the dialog overflows is left alone", async () => {
  const { clampDialogOffset, NO_DIALOG_OFFSET } = await loadSubject();
  // Wider than the chat region (a phone), but free to move up and down.
  const wide = { left: -30, top: 200, right: 1030, bottom: 500 };
  assert.deepEqual(clampDialogOffset({ x: -120, y: 40 }, NO_DIALOG_OFFSET, wide, container), { x: -120, y: 40 });
  assert.deepEqual(clampDialogOffset({ x: -120, y: 400 }, NO_DIALOG_OFFSET, wide, container), { x: -120, y: 200 });
});
