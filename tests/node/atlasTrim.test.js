import test from 'node:test';
import assert from 'node:assert/strict';

import { SpriteSheetRegistry } from '../../src/core/spriteSheetRegistry.js';
import { getTrimBoundsFromCanvas } from '../reference/atlasTrim.mjs';

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s ^ (s >>> 15), 2246822507) + 0x9e3779b9) >>> 0;
    s = Math.imul(s ^ (s >>> 13), 3266489909) >>> 0;
    return ((s ^ (s >>> 16)) >>> 0) / 4294967296;
  };
}

/** A sheet of w x h RGBA pixels: transparent, with a few opaque-ish blobs. */
function sheet(r, w, h) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let b = 0; b < 12; b++) {
    const cx = (r() * w) | 0;
    const cy = (r() * h) | 0;
    const rad = 1 + ((r() * 9) | 0);
    const alpha = (r() * 255) | 0;
    for (let y = Math.max(0, cy - rad); y < Math.min(h, cy + rad); y++) {
      for (let x = Math.max(0, cx - rad); x < Math.min(w, cx + rad); x++) data[(y * w + x) * 4 + 3] = alpha;
    }
  }
  return data;
}

/** The frame on a canvas of its own (outside the sheet transparent), as the per-frame trim read it back. */
function frameContext(data, w, h, fx, fy, fw, fh) {
  return {
    getImageData() {
      const out = new Uint8ClampedArray(fw * fh * 4);
      for (let y = 0; y < fh; y++) {
        for (let x = 0; x < fw; x++) {
          const sx = fx + x;
          const sy = fy + y;
          if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
          out.set(data.subarray((sy * w + sx) * 4, (sy * w + sx) * 4 + 4), (y * fw + x) * 4);
        }
      }
      return { data: out };
    },
  };
}

/** Rows [ry, ry + rh) and columns [rx, rx + rw) of the sheet, as _readImagePixels returns them. */
function region(data, w, rx, ry, rw, rh) {
  const out = new Uint8ClampedArray(rw * rh * 4);
  for (let y = 0; y < rh; y++) out.set(data.subarray(((ry + y) * w + rx) * 4, ((ry + y) * w + rx + rw) * 4), y * rw * 4);
  return { data: out, x: rx, y: ry, width: rw, height: rh };
}

test("a frame's trim from the sheet's pixels, read once, is the trim of the frame read back alone", () => {
  for (let seed = 1; seed <= 20; seed++) {
    const r = rng(seed * 104729);
    const w = 40 + ((r() * 60) | 0);
    const h = 40 + ((r() * 60) | 0);
    const data = sheet(r, w, h);
    // The rectangle read: the whole sheet, or part of it holding the frames below.
    const rx = seed % 2 ? 0 : (r() * 6) | 0;
    const ry = seed % 2 ? 0 : (r() * 6) | 0;
    const pixels = region(data, w, rx, ry, w - rx, h - ry);
    for (let f = 0; f < 30; f++) {
      const fw = 1 + ((r() * 30) | 0);
      const fh = 1 + ((r() * 30) | 0);
      // Frames inside the read rectangle, some running past the sheet's right and bottom edges.
      const fx = rx + ((r() * (w - rx)) | 0);
      const fy = ry + ((r() * (h - ry)) | 0);
      const threshold = f % 3 === 0 ? 0 : (r() * 200) | 0;
      const want = getTrimBoundsFromCanvas(frameContext(data, w, h, fx, fy, fw, fh), fw, fh, threshold);
      const got = SpriteSheetRegistry._getTrimBoundsInPixels(pixels, fx, fy, fw, fh, threshold);
      assert.deepEqual(got, want, `seed ${seed} frame ${f} at ${fx},${fy} ${fw}x${fh} threshold ${threshold}`);
    }
  }
});

test('an all-transparent frame trims to nothing, and an opaque one keeps its size', () => {
  const w = 8;
  const h = 4;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 4; x < 8; x++) data[(y * w + x) * 4 + 3] = 255;
  const pixels = region(data, w, 0, 0, w, h);
  assert.equal(SpriteSheetRegistry._getTrimBoundsInPixels(pixels, 0, 0, 4, 4, 0), null);
  assert.deepEqual(SpriteSheetRegistry._getTrimBoundsInPixels(pixels, 4, 0, 4, 4, 0), { x: 0, y: 0, width: 4, height: 4 });
  // Half past the sheet's edge: only the part on it counts.
  assert.deepEqual(SpriteSheetRegistry._getTrimBoundsInPixels(pixels, 6, 2, 4, 4, 0), { x: 0, y: 0, width: 2, height: 2 });
});
