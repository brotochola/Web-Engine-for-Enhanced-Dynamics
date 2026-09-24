/**
 * Bake a normal atlas from a color atlas (normalmap23 4-tap bevel).
 * RGB straight; alpha 0 reads as black so silhouette bevels against empty.
 * Output: same size RGBA, XY packed as 0.5 + 0.5*n.xy, Z reconstructed in shader.
 */

import { create2dCanvas } from '../util/utils.js';
import { LIGHTING_DEFAULTS } from '../util/configDefaults.js';

const GRAY_R = 0.299;
const GRAY_G = 0.587;
const GRAY_B = 0.114;

function grayRgb(r, g, b) {
  return r * GRAY_R + g * GRAY_G + b * GRAY_B;
}

/**
 * Sample straight RGB in [0,1]. Out-of-frame or a≈0 → black.
 * @param {Uint8ClampedArray} src
 * @param {number} atlasW
 * @param {number} fx
 * @param {number} fy
 * @param {number} fw
 * @param {number} fh
 * @param {number} lx local x in frame
 * @param {number} ly local y in frame
 */
function sampleFrame(src, atlasW, fx, fy, fw, fh, lx, ly) {
  const cx = lx < 0 ? 0 : lx >= fw ? fw - 1 : lx;
  const cy = ly < 0 ? 0 : ly >= fh ? fh - 1 : ly;
  const i = ((fy + cy) * atlasW + (fx + cx)) << 2;
  const a = src[i + 3];
  if (a < 1) return 0;
  // Straight RGB (canvas getImageData is not premultiplied)
  return grayRgb(src[i] / 255, src[i + 1] / 255, src[i + 2] / 255);
}

/**
 * Fill padding around a frame with the edge texel (avoids linear bleed).
 * @param {Uint8ClampedArray} out
 * @param {number} atlasW
 * @param {number} atlasH
 * @param {number} fx
 * @param {number} fy
 * @param {number} fw
 * @param {number} fh
 * @param {number} pad
 */
function fillFramePadding(out, atlasW, atlasH, fx, fy, fw, fh, pad) {
  if (!(pad > 0) || fw < 1 || fh < 1) return;
  const x0 = Math.max(0, fx - pad);
  const y0 = Math.max(0, fy - pad);
  const x1 = Math.min(atlasW, fx + fw + pad);
  const y1 = Math.min(atlasH, fy + fh + pad);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (x >= fx && x < fx + fw && y >= fy && y < fy + fh) continue;
      const cx = x < fx ? fx : x >= fx + fw ? fx + fw - 1 : x;
      const cy = y < fy ? fy : y >= fy + fh ? fy + fh - 1 : y;
      const si = ((cy * atlasW + cx) << 2);
      const di = ((y * atlasW + x) << 2);
      out[di] = out[si];
      out[di + 1] = out[si + 1];
      out[di + 2] = out[si + 2];
      out[di + 3] = out[si + 3];
    }
  }
}

/**
 * @param {ImageData|{ data: Uint8ClampedArray }|Uint8ClampedArray} colorPixels
 * @param {number} width
 * @param {number} height
 * @param {Record<string, { frame: { x: number, y: number, w: number, h: number } }>} frames
 * @param {object} [opts]
 * @param {number} [opts.bevel=64]
 * @param {number} [opts.padding=2]
 * @returns {{ data: Uint8ClampedArray, width: number, height: number }}
 */
export function bakeNormalAtlasPixels(colorPixels, width, height, frames, opts = {}) {
  const bevel = opts.bevel != null ? +opts.bevel : LIGHTING_DEFAULTS.normalBevel;
  const padding = opts.padding != null ? opts.padding | 0 : 2;
  const src = colorPixels.data ? colorPixels.data : colorPixels;
  const out = new Uint8ClampedArray(width * height * 4);
  // Neutral flat fill
  for (let i = 0; i < out.length; i += 4) {
    out[i] = 128;
    out[i + 1] = 128;
    out[i + 2] = 255;
    out[i + 3] = 255;
  }

  const p = bevel;
  const frameList = frames ? Object.values(frames) : [];
  for (let fi = 0; fi < frameList.length; fi++) {
    const fr = frameList[fi]?.frame;
    if (!fr) continue;
    const fx = fr.x | 0;
    const fy = fr.y | 0;
    const fw = fr.w | 0;
    const fh = fr.h | 0;
    if (fw < 1 || fh < 1) continue;

    for (let ly = 0; ly < fh; ly++) {
      for (let lx = 0; lx < fw; lx++) {
        const right = sampleFrame(src, width, fx, fy, fw, fh, lx + 1, ly);
        const left = sampleFrame(src, width, fx, fy, fw, fh, lx - 1, ly);
        const up = sampleFrame(src, width, fx, fy, fw, fh, lx, ly - 1);
        const down = sampleFrame(src, width, fx, fy, fw, fh, lx, ly + 1);
        // normalmap23: b1 horizontal, b2 vertical (top vs bottom)
        const b1 = 0.5 + (right - left) * p;
        const b2 = 0.5 + (up - down) * p;
        let nx = 1 - 2 * b1;
        let ny = 1 - 2 * b2;
        const nz = 2;
        const len = Math.hypot(nx, ny, nz) || 1;
        nx /= len;
        ny /= len;
        const di = (((fy + ly) * width + (fx + lx)) << 2);
        out[di] = Math.max(0, Math.min(255, Math.round((0.5 + 0.5 * nx) * 255)));
        out[di + 1] = Math.max(0, Math.min(255, Math.round((0.5 + 0.5 * ny) * 255)));
        out[di + 2] = 255;
        out[di + 3] = 255;
      }
    }
    fillFramePadding(out, width, height, fx, fy, fw, fh, padding);
  }

  return { data: out, width, height };
}

/**
 * @param {HTMLCanvasElement|OffscreenCanvas} colorCanvas
 * @param {{ frames?: object }} atlasJson
 * @param {object} [opts]
 * @returns {{ canvas: HTMLCanvasElement|OffscreenCanvas, pixels: { data: Uint8ClampedArray, width: number, height: number } }}
 */
export function bakeNormalAtlasFromCanvas(colorCanvas, atlasJson, opts = {}) {
  const width = colorCanvas.width | 0;
  const height = colorCanvas.height | 0;
  const ctx = colorCanvas.getContext('2d', { willReadFrequently: true });
  const colorData = ctx.getImageData(0, 0, width, height);
  const frames = atlasJson?.frames || {};
  const pixels = bakeNormalAtlasPixels(colorData, width, height, frames, opts);
  const canvas = create2dCanvas(width, height);
  const outCtx = canvas.getContext('2d');
  const imageData =
    typeof ImageData !== 'undefined'
      ? new ImageData(pixels.data, width, height)
      : pixels;
  outCtx.putImageData(imageData, 0, 0);
  return { canvas, pixels };
}
