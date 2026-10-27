// frame.js — the editor's framing (VISUAL_EDITOR_PLAN.md ED-57), as Unity's F: the selection in the middle of the
// view, as large as fits with a margin (several selected: their common box); Shift+F the whole level (every placed
// entity, else the world). The editor's free camera goes there (Camera.setFreeTarget, targetZoom), within the scene's
// zoom limits. A selection with no size (a point, or smaller than a few pixels) keeps the zoom.
//
// Cost: one pass over what is framed, into boxes made once; nothing per frame.

import { Camera } from '../../camera.js';
import { Transform } from '../../../components/transform.js';
import { entityBox } from './pick.js';
import { indexOfName } from './sceneDocument.js';

/** The share of the view a framed box takes, at most. */
export const FRAME_FILL = 0.8;
/** A box no larger than this, in world units, is a point: framing it keeps the zoom. */
const POINT_SIZE = 4;
const INF = Infinity;

const box = new Float64Array(6);
/** What is framed: min x, min y, max x, max y. */
const bounds = new Float64Array(4);
/** Where the camera goes: x, y, zoom. */
const target = new Float64Array(3);

/** An empty box: anything added grows it. */
export function resetBounds(out = bounds) {
  out[0] = INF;
  out[1] = INF;
  out[2] = -INF;
  out[3] = -INF;
  return out;
}

/** Grow a box by the entity at `i`: its turned box's extent (pick.js entityBox), or its position. */
export function addEntityBounds(i, out = bounds) {
  let minX;
  let minY;
  let maxX;
  let maxY;
  if (entityBox(i, box)) {
    const ex = Math.abs(box[4]) * box[2] + Math.abs(box[5]) * box[3];
    const ey = Math.abs(box[5]) * box[2] + Math.abs(box[4]) * box[3];
    minX = box[0] - ex;
    minY = box[1] - ey;
    maxX = box[0] + ex;
    maxY = box[1] + ey;
  } else {
    minX = maxX = Transform.x[i];
    minY = maxY = Transform.y[i];
  }
  if (minX < out[0]) out[0] = minX;
  if (minY < out[1]) out[1] = minY;
  if (maxX > out[2]) out[2] = maxX;
  if (maxY > out[3]) out[3] = maxY;
  return out;
}

/**
 * Where the camera goes to frame a world box: its center, and the zoom at which it takes FRAME_FILL of the view
 * (within minZoom and maxZoom); a box no larger than a point keeps `zoom`.
 * @returns {Float64Array} out: x, y, zoom
 */
export function frameFor(minX, minY, maxX, maxY, viewW, viewH, zoom, minZoom, maxZoom, out = target) {
  out[0] = (minX + maxX) * 0.5;
  out[1] = (minY + maxY) * 0.5;
  const w = maxX - minX;
  const h = maxY - minY;
  let z = zoom;
  if ((w > POINT_SIZE || h > POINT_SIZE) && viewW > 0 && viewH > 0) {
    z = Math.min((viewW * FRAME_FILL) / Math.max(w, POINT_SIZE), (viewH * FRAME_FILL) / Math.max(h, POINT_SIZE));
  }
  out[2] = Math.max(minZoom, Math.min(maxZoom, z));
  return out;
}

/** Send the editor's camera to frame `bounds`. False when it is empty. */
function frameBounds() {
  if (!(bounds[0] <= bounds[2] && bounds[1] <= bounds[3])) return false;
  const maxZoom = Camera._freeMaxZoom != null ? Camera._freeMaxZoom : Camera.maxZoom;
  frameFor(bounds[0], bounds[1], bounds[2], bounds[3], Camera.canvasWidth, Camera.canvasHeight, Camera.targetZoom, Camera.minZoom, maxZoom);
  // About the view's center, not about where a wheel zoom last pointed.
  Camera._freeZoomAnchorX = null;
  Camera._freeZoomAnchorY = null;
  Camera.setFreeTarget(target[0], target[1]);
  Camera.targetZoom = target[2];
  return true;
}

/** The editor's selection: the entity the inspector shows and the others selected with it (ED-28). */
export function frameSelection(editMode) {
  resetBounds();
  const index = editMode.selection.index;
  if (index >= 0) addEntityBounds(index);
  const scene = editMode.debugUI.scene;
  for (const name of editMode.multi.names) {
    const i = indexOfName(scene, name);
    if (i >= 0) addEntityBounds(i);
  }
  return frameBounds();
}

/** Every placed entity of the running scene file; with none, the world. */
export function frameAll(editMode) {
  resetBounds();
  const scene = editMode.debugUI.scene;
  for (const record of scene?.sceneFile?.entities || []) {
    const i = indexOfName(scene, record.name);
    if (i >= 0) addEntityBounds(i);
  }
  if (!(bounds[0] <= bounds[2]) && Camera.worldWidth !== INF && Camera.worldHeight !== INF) {
    bounds[0] = 0;
    bounds[1] = 0;
    bounds[2] = Camera.worldWidth;
    bounds[3] = Camera.worldHeight;
  }
  return frameBounds();
}
