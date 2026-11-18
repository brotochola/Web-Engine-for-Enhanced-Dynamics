// SST-5: what the page needs from an atlas's pixels besides the renderer's texture, read from pixels instead of from a 2D
// canvas of the whole atlas on the page: the decal textures (every frame's RGBA, as Scene.extractDecalTextures read them)
// and, for a bake from before H-EDGE, each frame's texels (frameBase.js fillFrameTexels). Plain functions on RGBA arrays:
// the atlas worker (src/workers/atlasWorker.js) runs them, and the page when it has no worker.

import { fillFrameTexels } from '../../render/frameBase.js';

/**
 * A rectangle of RGBA pixels, as a canvas's getImageData returns it: what lies outside the read region is transparent.
 * @param {{ data: Uint8ClampedArray, x: number, y: number, width: number, height: number }} pixels a region of an image
 * @param {number} x
 * @param {number} y
 * @param {number} w
 * @param {number} h
 * @returns {Uint8ClampedArray} w × h × 4 bytes
 */
export function cutPixels(pixels, x, y, w, h) {
  const width = Math.max(0, w | 0);
  const height = Math.max(0, h | 0);
  const out = new Uint8ClampedArray(width * height * 4);
  const iw = pixels.width;
  const x0 = Math.max(x, pixels.x);
  const x1 = Math.min(x + width, pixels.x + iw);
  if (x1 <= x0) return out;
  const y0 = Math.max(y, pixels.y);
  const y1 = Math.min(y + height, pixels.y + pixels.height);
  const data = pixels.data;
  for (let row = y0; row < y1; row++) {
    const from = ((row - pixels.y) * iw + (x0 - pixels.x)) * 4;
    out.set(data.subarray(from, from + (x1 - x0) * 4), ((row - y) * width + (x0 - x)) * 4);
  }
  return out;
}

/**
 * The decal textures of an atlas, by textureId, as Scene.extractDecalTextures made them: ids 0 … A − 1 each animation's
 * first frame (an animation without frames, or whose first frame is not in the json, has none), then ids A, A + 1, … every
 * frame in the json's order. Each frame is read once: an animation's id shares its first frame's pixels (the same
 * ArrayBuffer under both ids; nothing writes them, and a structured clone keeps one copy).
 * @param {{ frames: Record<string, { frame: { x: number, y: number, w: number, h: number } }>, animations: Record<string, string[]> }} json
 * @param {(x: number, y: number, w: number, h: number) => Uint8ClampedArray} readRect the atlas's pixels in a rectangle
 *   (getImageData's, un-premultiplied), w × h × 4 bytes
 * @returns {{ textures: Record<number, { width: number, height: number, rgba: ArrayBuffer }>, frameNameToId: Record<string, number> }}
 */
export function decalTexturesFrom(json, readRect) {
  const frames = json.frames || {};
  const animations = json.animations || {};
  const animationNames = Object.keys(animations);
  const textures = {};
  const frameNameToId = {};
  /** @type {Map<string, ArrayBuffer>} */
  const read = new Map();
  const pixelsOf = (name, frame) => {
    let rgba = read.get(name);
    if (rgba === undefined) {
      rgba = readRect(frame.x, frame.y, frame.w, frame.h).buffer;
      read.set(name, rgba);
    }
    return rgba;
  };
  let frameTextureId = animationNames.length;
  for (const frameName of Object.keys(frames)) {
    const frameData = frames[frameName];
    if (!frameData) continue;
    const frame = frameData.frame;
    textures[frameTextureId] = { width: frame.w, height: frame.h, rgba: pixelsOf(frameName, frame) };
    frameNameToId[frameName] = frameTextureId;
    frameTextureId++;
  }
  for (let textureId = 0; textureId < animationNames.length; textureId++) {
    const frameList = animations[animationNames[textureId]];
    if (!frameList || frameList.length === 0) continue;
    const frameData = frames[frameList[0]];
    if (!frameData) continue;
    const frame = frameData.frame;
    textures[textureId] = { width: frame.w, height: frame.h, rgba: pixelsOf(frameList[0], frame) };
  }
  return { textures, frameNameToId };
}

/** The ArrayBuffers of a set of decal textures, each once (a transfer list may not name one twice). */
export function decalTextureBuffers(textures) {
  const set = new Set();
  for (const t of Object.values(textures || {})) if (t && t.rgba) set.add(t.rgba);
  return [...set];
}

/**
 * Whether a baked atlas's json lacks frame texels its pixels must give (fillFrameTexels: a bake from before H-EDGE).
 * @param {{ frames?: Record<string, { frame?: object, base?: object }>, meta?: { maps?: boolean } }} json
 */
export function needsFrameTexels(json) {
  const frames = json?.frames;
  if (!frames || json.meta?.maps === true) return false;
  for (const f of Object.values(frames)) {
    if (f && f.frame && (typeof f.base?.texels !== 'number' || typeof f.base?.solidTexels !== 'number')) return true;
  }
  return false;
}

/**
 * fillFrameTexels on a copy of the frames, returning only what it wrote: { name: [texels, solidTexels] } for each frame
 * it filled, which applyFrameTexels writes into the json on the other side of a postMessage.
 * @param {{ frames: object, meta?: object }} json
 * @param {{ data: Uint8ClampedArray, x: number, y: number, width: number, height: number }} pixels the whole atlas
 * @returns {Record<string, [number, number]>}
 */
export function frameTexelsFrom(json, pixels) {
  const frames = {};
  for (const [name, f] of Object.entries(json.frames || {})) frames[name] = f ? { frame: f.frame, base: f.base } : f;
  fillFrameTexels({ frames, meta: { maps: json.meta?.maps } }, () => pixels);
  const out = {};
  for (const [name, f] of Object.entries(frames)) {
    const orig = json.frames[name];
    if (f && f.base && f.base !== orig.base) out[name] = [f.base.texels, f.base.solidTexels];
  }
  return out;
}

/**
 * Write frameTexelsFrom's result into an atlas json, as fillFrameTexels would have.
 * @returns {number} the frames written
 */
export function applyFrameTexels(json, texels) {
  let n = 0;
  for (const [name, [t, solid]] of Object.entries(texels || {})) {
    const f = json.frames?.[name];
    if (!f) continue;
    f.base = { ...(f.base || {}), texels: t, solidTexels: solid };
    n++;
  }
  return n;
}

/**
 * Read a decoded atlas's pixels for the page: its decal textures (when `decals`), and the texels a bake from before
 * H-EDGE lacks. The image is drawn once into a 2D canvas (as the page drew it before SST-5, so the pixels read are the
 * same: un-premultiplied from the canvas's premultiplied store); with texels to fill the whole atlas is read once and the
 * frames cut from it, else each frame is read where it is.
 * @param {CanvasImageSource & { width: number, height: number }} image the decoded atlas (an ImageBitmap)
 * @param {{ frames: object, animations: object, meta?: object }} json
 * @param {{ decals: boolean, makeCanvas: (w: number, h: number) => { getContext: Function } }} opts
 * @returns {{ decals: ReturnType<typeof decalTexturesFrom> | null, texels: Record<string, [number, number]> | null }}
 */
export function readAtlasPixels(image, json, { decals, makeCanvas }) {
  if (!decals && !needsFrameTexels(json)) return { decals: null, texels: null };
  const ctx = makeCanvas(image.width, image.height).getContext('2d', { willReadFrequently: true });
  ctx.drawImage(image, 0, 0);
  return readCanvasPixels(ctx, image.width, image.height, json, { decals });
}

/**
 * readAtlasPixels on an atlas already drawn into a 2D context (willReadFrequently) of width × height.
 * @param {CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D} ctx
 * @param {number} width
 * @param {number} height
 * @param {{ frames: object, animations: object, meta?: object }} json
 * @param {{ decals: boolean }} opts
 */
export function readCanvasPixels(ctx, width, height, json, { decals }) {
  const texelsNeeded = needsFrameTexels(json);
  if (!decals && !texelsNeeded) return { decals: null, texels: null };
  if (texelsNeeded) {
    const pixels = { data: ctx.getImageData(0, 0, width, height).data, x: 0, y: 0, width, height };
    return {
      decals: decals ? decalTexturesFrom(json, (x, y, w, h) => cutPixels(pixels, x, y, w, h)) : null,
      texels: frameTexelsFrom(json, pixels),
    };
  }
  return {
    decals: decalTexturesFrom(json, (x, y, w, h) => (w > 0 && h > 0 ? ctx.getImageData(x, y, w, h).data : new Uint8ClampedArray(0))),
    texels: null,
  };
}
