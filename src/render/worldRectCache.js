/**
 * E-504: a worldRect layer (`shader.worldRect`, one world-sized rectangle under a fragment shader) is painted into a
 * target of its own, the size of the canvas, only when what it shows changed: the camera (position, zoom, roll), the
 * canvas' size, its uniforms or one of its pictures. The target is the layer on the stage, drawn 1:1. A procedural floor
 * (Buenos Aires': 1.9 of the 5.9 ms of GPU a frame at 22 h on a GTX 1650; on an Intel HD 620 it drew 16.6 fps without
 * the cache and 21.2 with it) then costs a copy while the camera holds.
 *
 * It adapts: a view that changes WORLD_RECT_DIRECT_AFTER frames in a row (a camera that follows something, a picture
 * uploaded every frame, a shader that reads the frame's time) gives up the target, and the layer's mesh draws on the
 * stage as without a cache (no copy); WORLD_RECT_HOLD_FRAMES frames of the same view bring the target back. So the cache
 * is the default, and `shader.cache: false` paints every frame.
 */

/** The engine's frame uniforms that change every frame (applyEngineLookUniforms); the others follow the camera. */
export const WORLD_RECT_EVERY_FRAME_UNIFORMS = Object.freeze(['uTime', 'uDt']);
/** Frames of a changing view the target is painted for before the layer draws on the stage instead. */
export const WORLD_RECT_DIRECT_AFTER = 2;
/** Frames of the same view, drawn on the stage, before the target is painted again and shown. */
export const WORLD_RECT_HOLD_FRAMES = 2;

/** worldRectCacheStep's answers: what the layer does this frame. */
export const WORLD_RECT_SHOW = 0; // the target shows, as painted
export const WORLD_RECT_PAINT = 1; // paint the target, and show it
export const WORLD_RECT_DIRECT = 2; // the mesh draws on the stage, the target hidden

/**
 * What the target was last painted for, and the adaptive state. Doubles start as NaN, so the first frame paints.
 * @returns {{ drawn: boolean, zoom: number, x: number, y: number, rot: number, w: number, h: number,
 *   direct: boolean, staleRun: number, held: number }}
 */
export function createWorldRectCache() {
  return { drawn: false, zoom: NaN, x: NaN, y: NaN, rot: NaN, w: 0, h: 0, direct: false, staleRun: 0, held: 0 };
}

/**
 * Whether the view changed since it was recorded (`changed`: its uniforms or pictures changed this frame, or it reads the
 * frame's time); when it did, this view is recorded.
 * @param {ReturnType<typeof createWorldRectCache>} c
 * @param {number} zoom
 * @param {number} x camera x
 * @param {number} y camera y
 * @param {number} rot camera roll
 * @param {number} w canvas width (px)
 * @param {number} h canvas height (px)
 * @param {boolean} changed
 */
export function worldRectCacheStale(c, zoom, x, y, rot, w, h, changed) {
  if (!changed && c.drawn && c.zoom === zoom && c.x === x && c.y === y && c.rot === rot && c.w === w && c.h === h) {
    return false;
  }
  c.drawn = true;
  c.zoom = zoom;
  c.x = x;
  c.y = y;
  c.rot = rot;
  c.w = w;
  c.h = h;
  return true;
}

/**
 * What the layer does this frame (WORLD_RECT_SHOW, WORLD_RECT_PAINT or WORLD_RECT_DIRECT), from its view and the
 * adaptive state: paint on a change, until WORLD_RECT_DIRECT_AFTER changes in a row send it to the stage, where it stays
 * until the view holds WORLD_RECT_HOLD_FRAMES frames. Arguments as worldRectCacheStale's.
 */
export function worldRectCacheStep(c, zoom, x, y, rot, w, h, changed) {
  const stale = worldRectCacheStale(c, zoom, x, y, rot, w, h, changed);
  if (c.direct) {
    if (stale) {
      c.held = 0;
      return WORLD_RECT_DIRECT;
    }
    if (++c.held < WORLD_RECT_HOLD_FRAMES) return WORLD_RECT_DIRECT;
    c.direct = false;
    c.staleRun = 0;
    return WORLD_RECT_PAINT;
  }
  if (!stale) {
    c.staleRun = 0;
    return WORLD_RECT_SHOW;
  }
  if (++c.staleRun > WORLD_RECT_DIRECT_AFTER) {
    c.direct = true;
    c.held = 0;
    return WORLD_RECT_DIRECT;
  }
  return WORLD_RECT_PAINT;
}

/**
 * Whether a layer's fragment source reads a uniform that changes every frame. The source, not the uniform map: the
 * engine adds its frame uniforms to every look's map (Layer._mergeReservedLookUniforms), read or not.
 */
export function readsFrameTime(fragmentSource) {
  if (typeof fragmentSource !== 'string') return false;
  for (let i = 0; i < WORLD_RECT_EVERY_FRAME_UNIFORMS.length; i++) {
    if (new RegExp(`\\b${WORLD_RECT_EVERY_FRAME_UNIFORMS[i]}\\b`).test(fragmentSource)) return true;
  }
  return false;
}
