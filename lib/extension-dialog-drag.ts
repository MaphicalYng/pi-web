/** The four edges of a box, as `getBoundingClientRect()` reports them. */
export type DialogRect = { left: number; top: number; right: number; bottom: number };

/** How far an extension dialog was moved from the place its overlay centred it, in CSS pixels. */
export type DialogOffset = { x: number; y: number };

/** A dialog nobody has dragged: it stays where the overlay put it. */
export const NO_DIALOG_OFFSET: DialogOffset = { x: 0, y: 0 };

/** Movement below this is the tremor of a click, not a drag. */
export const DIALOG_DRAG_START_PX = 3;

/**
 * Where a drag may put an extension dialog so that it stays inside `container`.
 *
 * `dialogRect` is the dialog as rendered, already translated by `current`; the untranslated
 * geometry is that rectangle minus the translation, so the bounds do not depend on the
 * offset the measurement happened to be taken at. An axis the dialog already fills (a
 * maximized dialog, or one wider than the chat region on a phone) is returned untouched:
 * there is nowhere to move to, and clamping would shift a dialog nobody dragged.
 */
export function clampDialogOffset(
  proposed: DialogOffset,
  current: DialogOffset,
  dialogRect: DialogRect,
  container: DialogRect,
): DialogOffset {
  const baseLeft = dialogRect.left - current.x;
  const baseTop = dialogRect.top - current.y;
  const width = dialogRect.right - dialogRect.left;
  const height = dialogRect.bottom - dialogRect.top;
  const fitsX = width <= container.right - container.left;
  const fitsY = height <= container.bottom - container.top;
  return {
    x: fitsX ? Math.min(Math.max(proposed.x, container.left - baseLeft), container.right - baseLeft - width) : proposed.x,
    y: fitsY ? Math.min(Math.max(proposed.y, container.top - baseTop), container.bottom - baseTop - height) : proposed.y,
  };
}
