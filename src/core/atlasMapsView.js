/**
 * DBG-6: an atlas's maps as pictures for the atlas inspector. The twin page (DX-MAPS) holds, for each frame of a sheet
 * with maps, a window of texels (the json's frames[name].maps gives its top left: E-496) in one of E-497's formats, which
 * spriteMaps.js's twinPageTexel reads. These paint each frame's window into an image of the atlas's size, over the
 * frame's own rectangle, so the maps sit where the colours are.
 */
import { twinPageTexel } from '../render/spriteMaps.js';

/** The inspector's modes: the atlas's colours, then the maps (atlasMapsImage). */
export const ATLAS_MAP_MODES = Object.freeze(['colour', 'height', 'normals', 'relief', 'marks']);

/**
 * The twin page's size at full resolution: formats B and C keep two texels to one, and C's last third of rows holds the
 * normals at half resolution.
 * @param {{ width: number, height: number }} page
 * @param {string} format
 */
export function twinFullSize(page, format) {
  if (format === 'B') return { w: page.width * 2, h: page.height };
  if (format === 'C') return { w: page.width * 2, h: (page.height * 2) / 3 };
  return { w: page.width, h: page.height };
}

/**
 * Where a frame's texels are in the twin page: its window's top left (E-496), or its atlas rectangle's when the page has
 * the atlas's layout (a bake from before E-496), or null (no maps).
 * @param {{ frame: { x: number, y: number }, maps?: { x: number, y: number } }} frameData
 * @param {boolean} atlasLayout
 */
export function frameWindow(frameData, atlasLayout) {
  const maps = frameData?.maps;
  if (maps && Number.isFinite(maps.x) && Number.isFinite(maps.y)) return { x: maps.x, y: maps.y };
  return atlasLayout ? { x: frameData.frame.x, y: frameData.frame.y } : null;
}

/** A frame's marks: a window, a height map, a relief map, unshaded (mapsTable.js's MAPS_* in words). */
function marksOf(frameData, win) {
  return {
    twin: win !== null,
    heights: frameData?.maps?.heights === true,
    relief: frameData?.maps?.relief === true,
    unshaded: frameData?.unshaded === true,
  };
}

/** The page has the atlas's layout: no frame names a window and the page is the atlas's size (a bake before E-496). */
function isAtlasLayout(json, full) {
  const size = json?.meta?.size;
  if (!size || full.w !== size.w || full.h !== size.h) return false;
  for (const name in json.frames) if (json.frames[name].maps) return false;
  return true;
}

/** 0 blue, 0.5 orange, 1 white: the render views' height ramp. */
function ramp(t, out, at) {
  const v = t < 0 ? 0 : t > 1 ? 1 : t;
  if (v < 0.5) {
    const k = v * 2;
    out[at] = 13 + (255 - 13) * k;
    out[at + 1] = 13 + (115 - 13) * k;
    out[at + 2] = 90 + (13 - 90) * k;
  } else {
    const k = v * 2 - 1;
    out[at] = 255;
    out[at + 1] = 115 + (255 - 115) * k;
    out[at + 2] = 13 + (255 - 13) * k;
  }
  out[at + 3] = 255;
}

/**
 * The maps in `mode` as an RGBA image of the atlas's size:
 * - height: each texel's height above the floor, a ramp from 0 (blue) to the page's highest (white);
 * - normals: the stored normal as 0.5 + 0.5·n (format B keeps none: grey where there is a map);
 * - relief: as height, for the frames of a relief sheet only; the other mapped texels grey;
 * - marks: where a frame has a map, grey a window, blue a height map, orange a relief map; magenta an unshaded frame.
 * Texels with no map, and the rest of the atlas, stay clear.
 * @param {{ texels: Uint8ClampedArray, width: number, height: number }} page the twin page as computed
 * @param {{ frames: object, meta: { size: { w: number, h: number }, mapsFormat?: string } }} json the atlas's json
 * @param {string} mode one of ATLAS_MAP_MODES but 'colour'
 * @returns {{ rgba: Uint8ClampedArray, width: number, height: number, maxZ: number, frames: number }}
 */
export function atlasMapsImage(page, json, mode) {
  const width = json.meta.size.w;
  const height = json.meta.size.h;
  const rgba = new Uint8ClampedArray(width * height * 4);
  const format = json.meta.mapsFormat || 'A';
  const full = twinFullSize(page, format);
  const atlasLayout = isAtlasLayout(json, full);
  const frames = [];
  for (const name in json.frames) {
    const data = json.frames[name];
    const win = frameWindow(data, atlasLayout);
    const marks = marksOf(data, win);
    if (win !== null || marks.unshaded) frames.push({ rect: data.frame, win, marks });
  }
  // The page's highest point, for the ramp.
  let maxZ = 0;
  if (mode === 'height' || mode === 'relief') {
    for (const f of frames) {
      if (f.win === null || (mode === 'relief' && !f.marks.relief)) continue;
      for (let dy = 0; dy < f.rect.h; dy++) {
        for (let dx = 0; dx < f.rect.w; dx++) {
          const tx = f.win.x + dx;
          const ty = f.win.y + dy;
          if (tx >= full.w || ty >= full.h) continue;
          const t = twinPageTexel(page.texels, page.width, page.height, tx, ty, format);
          if (t.present && t.z > maxZ) maxZ = t.z;
        }
      }
    }
  }
  const scale = maxZ > 0 ? 1 / maxZ : 0;
  for (const f of frames) {
    const { rect, win, marks } = f;
    for (let dy = 0; dy < rect.h; dy++) {
      const ay = rect.y + dy;
      if (ay >= height) break;
      for (let dx = 0; dx < rect.w; dx++) {
        const ax = rect.x + dx;
        if (ax >= width) break;
        const at = (ay * width + ax) * 4;
        if (win === null) {
          // An unshaded frame without a window: its rectangle in magenta, in the marks mode alone.
          if (mode === 'marks') {
            rgba[at] = 230;
            rgba[at + 1] = 40;
            rgba[at + 2] = 230;
            rgba[at + 3] = 255;
          }
          continue;
        }
        const tx = win.x + dx;
        const ty = win.y + dy;
        if (tx >= full.w || ty >= full.h) continue;
        const t = twinPageTexel(page.texels, page.width, page.height, tx, ty, format);
        if (!t.present) continue;
        if (mode === 'height') {
          ramp(t.z * scale, rgba, at);
        } else if (mode === 'relief') {
          if (marks.relief) ramp(t.z * scale, rgba, at);
          else {
            rgba[at] = rgba[at + 1] = rgba[at + 2] = 70;
            rgba[at + 3] = 255;
          }
        } else if (mode === 'normals') {
          const n = t.normal;
          if (n === null) {
            rgba[at] = rgba[at + 1] = rgba[at + 2] = 128;
          } else {
            rgba[at] = 127.5 + 127.5 * n[0];
            rgba[at + 1] = 127.5 + 127.5 * n[1];
            rgba[at + 2] = 127.5 + 127.5 * n[2];
          }
          rgba[at + 3] = 255;
        } else {
          // marks
          if (marks.relief) {
            rgba[at] = 255;
            rgba[at + 1] = 140;
            rgba[at + 2] = 20;
          } else if (marks.heights) {
            rgba[at] = 40;
            rgba[at + 1] = 110;
            rgba[at + 2] = 255;
          } else {
            rgba[at] = rgba[at + 1] = rgba[at + 2] = 160;
          }
          rgba[at + 3] = 255;
        }
      }
    }
  }
  return { rgba, width, height, maxZ, frames: frames.length };
}

/**
 * What lies under atlas point (x, y): the frame there (its name and marks), and when it has a map there, the twin texel
 * (its height in px and stored normal). Null outside every frame.
 * @param {{ texels: Uint8ClampedArray, width: number, height: number } | null} page
 * @param {object} json
 * @param {number} x
 * @param {number} y
 */
export function atlasMapsAt(page, json, x, y) {
  const format = json?.meta?.mapsFormat || 'A';
  const full = page ? twinFullSize(page, format) : null;
  const atlasLayout = page ? isAtlasLayout(json, full) : false;
  for (const name in json.frames) {
    const data = json.frames[name];
    const r = data.frame;
    if (x < r.x || y < r.y || x >= r.x + r.w || y >= r.y + r.h) continue;
    const win = frameWindow(data, atlasLayout);
    const out = { name, frame: r, marks: marksOf(data, win), texel: null };
    if (page && win !== null) {
      const tx = win.x + (x - r.x);
      const ty = win.y + (y - r.y);
      if (tx < full.w && ty < full.h) {
        const t = twinPageTexel(page.texels, page.width, page.height, tx, ty, format);
        if (t.present) out.texel = { z: t.z, normal: t.normal };
      }
    }
    return out;
  }
  return null;
}
