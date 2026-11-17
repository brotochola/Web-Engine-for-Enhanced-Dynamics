/**
 * E-504: a worldRect layer (`shader.worldRect`, one world-sized rectangle under a fragment shader) that sets
 * `shader.cache: true` is drawn into a target of its own, the size of the canvas, only when what it shows changed:
 * the camera (position, zoom, roll), the canvas' size, its uniforms or one of its pictures. The target is the layer on
 * the stage, drawn 1:1. A procedural floor (Buenos Aires': 1.9 of the 5.9 ms of GPU a frame at 22 h on a GTX 1650)
 * then costs a copy while the camera holds. A shader that reads the frame's time (uTime, uDt) changes every frame:
 * its layer is drawn every frame, as without the cache.
 */

/** The engine's frame uniforms that change every frame (applyEngineLookUniforms); the others follow the camera. */
export const WORLD_RECT_EVERY_FRAME_UNIFORMS = Object.freeze(['uTime', 'uDt']);

/**
 * What the target was last drawn for. Doubles start as NaN, so the first frame always draws.
 * @returns {{ drawn: boolean, zoom: number, x: number, y: number, rot: number, w: number, h: number }}
 */
export function createWorldRectCache() {
  return { drawn: false, zoom: NaN, x: NaN, y: NaN, rot: NaN, w: 0, h: 0 };
}

/**
 * Whether the target must be drawn again for this view; when it must, the view is recorded as drawn.
 * @param {ReturnType<typeof createWorldRectCache>} c
 * @param {number} zoom
 * @param {number} x camera x
 * @param {number} y camera y
 * @param {number} rot camera roll
 * @param {number} w canvas width (px)
 * @param {number} h canvas height (px)
 * @param {boolean} changed its uniforms or pictures changed this frame, or it reads the frame's time
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
