import test from 'node:test';
import assert from 'node:assert/strict';

import { bakeNormalAtlasPixels } from '../../src/render/bakeNormalAtlas.js';

function makeAtlas(width, height, paint) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i + 3] = 0; // transparent empty
  }
  paint(data, width, height);
  return data;
}

function fillRect(data, width, x, y, w, h, r, g, b, a = 255) {
  for (let py = y; py < y + h; py++) {
    for (let px = x; px < x + w; px++) {
      const i = (py * width + px) << 2;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = a;
    }
  }
}

function readXY(out, width, x, y) {
  const i = (y * width + x) << 2;
  return { x: out[i], y: out[i + 1] };
}

test('flat color frame bakes neutral normal XY (128,128)', () => {
  const W = 16;
  const H = 8;
  const color = makeAtlas(W, H, (data) => {
    fillRect(data, W, 0, 0, 8, 8, 200, 100, 50, 255);
  });
  const frames = {
    flat: { frame: { x: 0, y: 0, w: 8, h: 8 } },
  };
  const { data: out } = bakeNormalAtlasPixels(color, W, H, frames, { bevel: 64, padding: 0 });
  const mid = readXY(out, W, 4, 4);
  assert.equal(mid.x, 128);
  assert.equal(mid.y, 128);
});

test('dark left / bright right moves normal X; no bleed into neighbor frame', () => {
  const W = 16;
  const H = 8;
  const color = makeAtlas(W, H, (data) => {
    // Frame A: left dark, right bright
    fillRect(data, W, 0, 0, 4, 8, 20, 20, 20, 255);
    fillRect(data, W, 4, 0, 4, 8, 220, 220, 220, 255);
    // Frame B: flat mid gray (should stay neutral)
    fillRect(data, W, 8, 0, 8, 8, 128, 128, 128, 255);
  });
  const frames = {
    graded: { frame: { x: 0, y: 0, w: 8, h: 8 } },
    flat: { frame: { x: 8, y: 0, w: 8, h: 8 } },
  };
  const { data: out } = bakeNormalAtlasPixels(color, W, H, frames, { bevel: 64, padding: 0 });

  // At the dark→bright seam (x=3 vs x=4), nx should not be neutral
  const seam = readXY(out, W, 3, 4);
  assert.notEqual(seam.x, 128);

  // Neighbor flat frame center stays neutral (no bleed from graded)
  const flatMid = readXY(out, W, 12, 4);
  assert.equal(flatMid.x, 128);
  assert.equal(flatMid.y, 128);
});
