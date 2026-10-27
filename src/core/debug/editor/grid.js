// grid.js — the editor's grid (VISUAL_EDITOR_PLAN.md ED-60): the lines of the snap step drawn over the view while
// editing (every step, thinned out where they would come closer than 8 screen pixels, every fourth one brighter),
// and the step and the lines remembered per viewer. The step itself is MoveTool.snap: drags, nudges, placing and
// pasting snap to it. The toolbar sets both; G cycles the step, Shift+G shows or hides the lines.
//
// Cost: while the lines show, two paths per overlay frame (minor, major), drawn from loops over numbers: nothing is
// allocated. The lines go through whole pixels under a half-pixel translate, crisp: a canvas call given a double that
// is not a small integer boxes it, every call (38.7 KB/s at 1:1 with 16 px lines, ED-70).

const GRID_KEY = 'weed.editor.grid';
/** The closest two drawn lines come on screen, in pixels: closer, every other one is left out. */
const MIN_SPACING_PX = 8;
const MINOR_STYLE = 'rgba(255, 255, 255, 0.07)';
const MAJOR_STYLE = 'rgba(255, 255, 255, 0.16)';

function storage() {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

/**
 * The step and the lines the viewer left (defaults: no snap, lines shown once there is a step).
 * @param {number[]} steps - the steps offered: a remembered one that is not among them is dropped
 * @returns {{ snap: number, show: boolean }}
 */
export function loadGrid(steps) {
  const grid = { snap: 1, show: true };
  try {
    const saved = JSON.parse(storage()?.getItem(GRID_KEY) || 'null');
    if (saved && steps.includes(saved.snap)) grid.snap = saved.snap;
    if (saved && typeof saved.show === 'boolean') grid.show = saved.show;
  } catch {
    // blocked or not JSON: the defaults
  }
  return grid;
}

/** Remember the step and the lines (storage that fails keeps them for this page only). */
export function saveGrid(snap, show) {
  try {
    storage()?.setItem(GRID_KEY, JSON.stringify({ snap, show }));
  } catch {
    // full or blocked
  }
}

export class GridOverlay {
  /** @param {object} editMode - its MoveTool's snap is the step */
  constructor(editMode) {
    this.editMode = editMode;
    /** Whether the lines show (when there is a step). */
    this.show = true;
  }

  wantsOverlay() {
    return this.show && this.editMode.move.snap > 1;
  }

  /**
   * The lines, in the overlay's screen space (camera.x and camera.y: the view's top-left in the world).
   * @param {CanvasRenderingContext2D} ctx
   */
  drawOverlay(ctx, camera, zoom) {
    const step = this.editMode.move.snap;
    if (!this.show || !(step > 1) || !(zoom > 0) || !camera || !ctx?.canvas) return;
    let cell = step;
    while (cell * zoom < MIN_SPACING_PX) cell *= 2;
    // The view's extent in the world, from the canvas's size (its backing pixels: never smaller than its CSS size).
    const right = camera.x + ctx.canvas.width / zoom;
    const bottom = camera.y + ctx.canvas.height / zoom;
    const first = Math.floor(camera.x / cell);
    const last = Math.ceil(right / cell);
    const top = Math.floor(camera.y / cell);
    const end = Math.ceil(bottom / cell);
    const height = ctx.canvas.height;
    const width = ctx.canvas.width;
    ctx.save();
    ctx.translate(0.5, 0.5);
    ctx.lineWidth = 1;
    for (let major = 0; major < 2; major++) {
      ctx.beginPath();
      for (let k = first; k <= last; k++) {
        if ((k % 4 === 0) !== (major === 1)) continue;
        const sx = Math.round((k * cell - camera.x) * zoom) | 0;
        ctx.moveTo(sx, 0);
        ctx.lineTo(sx, height);
      }
      for (let k = top; k <= end; k++) {
        if ((k % 4 === 0) !== (major === 1)) continue;
        const sy = Math.round((k * cell - camera.y) * zoom) | 0;
        ctx.moveTo(0, sy);
        ctx.lineTo(width, sy);
      }
      ctx.strokeStyle = major === 1 ? MAJOR_STYLE : MINOR_STYLE;
      ctx.stroke();
    }
    ctx.restore();
  }
}
