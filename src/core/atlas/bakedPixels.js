// What a baked atlas's pixels give the page (SST-5 step 4), in the atlas worker or on the page: the built-in textures a
// bake from before them lacks, drawn in where they fit (so a bake never goes stale when the engine adds a built-in), then
// the decal textures and the frame texels read from the completed atlas. No utils.js here: the worker imports it.

import { MaxRectsPacker } from './maxRectsPacker.js';
import { needsFrameTexels, readCanvasPixels } from './atlasFrames.js';

/**
 * Where an atlas of width × height gets built-ins it lacks: in the space its frames leave free (each frame keeps
 * `padding` around it, as the packer placed it), the largest first as createBigAtlas sorts them; when one does not fit,
 * all of them on rows below the atlas, which grows to hold them.
 * @param {Record<string, { frame?: { x: number, y: number, w: number, h: number } }>} frames the atlas's json frames
 * @param {number} width
 * @param {number} height
 * @param {Array<{ width: number, height: number }>} adds
 * @param {number} padding
 * @returns {{ width: number, height: number, rects: Array<{ x: number, y: number }> }} the atlas's size after, and a
 *   top-left corner per add, in adds's order
 */
export function placeBuiltins(frames, width, height, adds, padding) {
  const rects = new Array(adds.length);
  if (adds.length === 0) return { width, height, rects };
  const pad = Math.max(0, padding | 0);
  const order = adds.map((_, i) => i).sort((i, j) => Math.max(adds[j].width, adds[j].height) - Math.max(adds[i].width, adds[i].height));
  const packer = new MaxRectsPacker(width, height, pad);
  for (const f of Object.values(frames || {})) {
    const r = f?.frame;
    if (r) packer.placeRect({ x: r.x - pad, y: r.y - pad, width: r.w + 2 * pad, height: r.h + 2 * pad });
  }
  let fits = true;
  for (const i of order) {
    const r = packer.insert(adds[i].width, adds[i].height, 'best-short-side');
    if (!r) {
      fits = false;
      break;
    }
    rects[i] = { x: r.x, y: r.y };
  }
  if (fits) return { width, height, rects };
  // Rows below the atlas, left to right.
  let x = pad;
  let y = height + pad;
  let rowHeight = 0;
  let right = width;
  let bottom = height;
  for (const i of order) {
    const a = adds[i];
    if (x > pad && x + a.width + pad > width) {
      x = pad;
      y += rowHeight + 2 * pad;
      rowHeight = 0;
    }
    rects[i] = { x, y };
    x += a.width + 2 * pad;
    if (a.height > rowHeight) rowHeight = a.height;
    if (rects[i].x + a.width > right) right = rects[i].x + a.width;
    if (y + a.height > bottom) bottom = y + a.height;
  }
  return { width: right, height: bottom, rects };
}

/**
 * The json entries of built-ins placed in an atlas, as createBigAtlas writes a built-in's: its frame (untrimmed; marked
 * unshaded when it is), a one-frame animation of its name after the atlas's own, the atlas's size, and meta.unshaded
 * when one is unshaded.
 * @param {Array<{ name: string, width: number, height: number, unshaded?: boolean }>} adds
 * @param {{ width: number, height: number, rects: Array<{ x: number, y: number }> }} placed placeBuiltins's
 * @returns {{ frames: Record<string, object>, animations: string[], size: { w: number, h: number }, unshaded: boolean }}
 */
export function builtinJsonEntries(adds, placed) {
  const frames = {};
  const animations = [];
  let unshaded = false;
  adds.forEach((a, i) => {
    const r = placed.rects[i];
    frames[a.name] = {
      frame: { x: r.x, y: r.y, w: a.width, h: a.height },
      rotated: false,
      trimmed: false,
      spriteSourceSize: { x: 0, y: 0, w: a.width, h: a.height },
      sourceSize: { w: a.width, h: a.height },
      ...(a.unshaded === true ? { unshaded: true } : {}),
    };
    animations.push(a.name);
    if (a.unshaded === true) unshaded = true;
  });
  return { frames, animations, size: { w: placed.width, h: placed.height }, unshaded };
}

/**
 * Write builtinJsonEntries's result into an atlas json: frames and animations after its own, its size, its unshaded mark.
 * @param {{ frames: object, animations: object, meta?: object }} json
 * @param {ReturnType<typeof builtinJsonEntries>} added
 */
export function addBuiltinsToJson(json, added) {
  Object.assign(json.frames, added.frames);
  for (const name of added.animations) json.animations[name] = [name];
  json.meta = { ...(json.meta || {}), size: { ...added.size } };
  if (added.unshaded) json.meta.unshaded = true;
  return json;
}

/**
 * A baked atlas's pixel work: the missing built-ins drawn in, then its decal textures and texels read.
 * @param {{
 *   image: CanvasImageSource & { width: number, height: number },
 *   json: { frames: object, animations: object, meta?: object },
 *   decals: boolean,
 *   builtins?: Array<{ name: string, image: CanvasImageSource & { width: number, height: number }, unshaded?: boolean }>,
 *   padding?: number,
 *   makeCanvas: (w: number, h: number) => HTMLCanvasElement | OffscreenCanvas,
 * }} opts
 * @returns {Promise<{ decals: object | null, texels: object | null, added: ReturnType<typeof builtinJsonEntries> | null,
 *   bitmap: ImageBitmap | null }>} bitmap: the completed atlas for the renderer, when built-ins were added
 */
export async function completeBakedPixels({ image, json, decals, builtins = [], padding = 2, makeCanvas }) {
  const adds = builtins.map((b) => ({ name: b.name, width: b.image.width, height: b.image.height, unshaded: b.unshaded === true }));
  let full = json;
  let added = null;
  let placed = null;
  if (adds.length > 0) {
    placed = placeBuiltins(json.frames, image.width, image.height, adds, padding);
    added = builtinJsonEntries(adds, placed);
    full = addBuiltinsToJson({ frames: { ...json.frames }, animations: { ...json.animations }, meta: { ...(json.meta || {}) } }, added);
  }
  if (!decals && adds.length === 0 && !needsFrameTexels(full)) return { decals: null, texels: null, added: null, bitmap: null };
  const width = placed ? placed.width : image.width;
  const height = placed ? placed.height : image.height;
  const canvas = makeCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(image, 0, 0);
  for (let i = 0; i < adds.length; i++) ctx.drawImage(builtins[i].image, placed.rects[i].x, placed.rects[i].y);
  const read = readCanvasPixels(ctx, width, height, full, { decals });
  let bitmap = null;
  if (adds.length > 0) {
    bitmap = typeof canvas.transferToImageBitmap === 'function' ? canvas.transferToImageBitmap() : await createImageBitmap(canvas);
  }
  return { decals: read.decals, texels: read.texels, added, bitmap };
}
