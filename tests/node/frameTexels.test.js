// H-EDGE on real code: what a frame's texels hold, from the registry's scans to DX-DEPTH's edge pass. The registry reads
// each frame's alphas (frameBase.js frameAlphaKinds: a texel of 1 to 127 is soft, 128 to 254 half) and whether its
// rectangle of the atlas's twin page glows (spriteMaps.js twinHasGlow, spriteSheetRegistry.js _paintMapsPage), and writes
// them in the frame's json base (_markFrameTexels). The texture table keeps them a frame on the CPU
// (instancedSpriteBatch.js buildTextureLut, textureLutTexels) and their soft-or-glow bit in each row's flags texel
// (packTextureLutRgba), where the depth programs' vertex stage reads it (pixelDepth.js), as shaderSoftOrGlow below does:
// the edge pass leaves a solid pixel of a frame with neither (a plain one) before reading the twin page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { HEIGHT_UNITS, frameTwinTexels, twinHasGlow } from '../../src/render/spriteMaps.js';
import { SpriteSheetRegistry } from '../../src/core/spriteSheetRegistry.js';
import {
  FRAME_GLOW, FRAME_HALF, FRAME_SOFT, FRAME_UNSCANNED, TEX_LUT_FLAG_BITS, TEX_LUT_FLAGS_PER_ROW, frameAlphaKinds,
  lutBaseFloats, sheetCastsSolid,
} from '../../src/render/frameBase.js';
import { buildTextureLut, packTextureLutRgba, textureLutLayout, textureLutTexels } from '../../src/render/instancedSpriteBatch.js';
import { pixelDepthFragment, pixelDepthVertex, pixelDepthWgsl } from '../../src/render/pixelDepth.js';

const shader = (name) => fs.readFileSync(new URL(`../../src/shaders/${name}`, import.meta.url), 'utf8');

/** A frame's colour, w × h RGBA: alpha(x, y) a texel's alpha. */
function colour(w, h, alpha) {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out.set([200, 100, 50, alpha(x, y)], (y * w + x) * 4);
  return out;
}

/** Heights 3 px wherever the frame is. */
function heights(w, h) {
  const out = new Uint8ClampedArray(w * h * 4);
  const z = 3 * HEIGHT_UNITS;
  for (let i = 0; i < w * h; i++) out.set([z >> 8, z & 255, 0, 255], i * 4);
  return out;
}

// Frames of 6 x 4: binary alpha (0 or 255), a soft edge (alpha 60), a half one (alpha 200).
const W = 6;
const H = 4;
const binary = colour(W, H, (x) => (x >= 1 && x <= 4 ? 255 : 0));
const soft = colour(W, H, (x) => (x === 0 || x === 5 ? 60 : 255));
const half = colour(W, H, (x) => (x === 0 ? 200 : 255));
const pixelsOf = (data, x = 0, y = 0) => ({ data, x, y, width: W, height: H });

test('a frame\'s alphas: soft (1 to 127), half (128 to 254), or binary', () => {
  assert.equal(frameAlphaKinds(pixelsOf(binary), 0, 0, W, H), 0, 'binary');
  assert.equal(frameAlphaKinds(pixelsOf(soft), 0, 0, W, H), FRAME_SOFT, 'a soft texel');
  assert.equal(frameAlphaKinds(pixelsOf(half), 0, 0, W, H), FRAME_HALF, 'a half one');
  const both = colour(W, H, (x) => [1, 127, 128, 254, 0, 255][x]);
  assert.equal(frameAlphaKinds(pixelsOf(both), 0, 0, W, H), FRAME_SOFT | FRAME_HALF, 'both, at their limits');
  // Only the rectangle drawn counts (a trimmed frame's), and what lies outside the pixels read is transparent.
  assert.equal(frameAlphaKinds(pixelsOf(soft), 1, 0, 4, H), 0, 'the soft columns left out');
  assert.equal(frameAlphaKinds(pixelsOf(soft, 10, 20), 14, 20, 6, H), FRAME_SOFT, 'in the read rectangle\'s coordinates');
  assert.equal(frameAlphaKinds(pixelsOf(binary, 10, 20), 30, 30, 6, H), 0, 'outside it: nothing');
});

test('a frame glows in the twin page when it has a glowing texel there: soft and binary alpha alike do not', () => {
  assert.equal(twinHasGlow(frameTwinTexels({ color: binary, height: heights(W, H), normal: null, w: W, h: H })), false, 'binary alpha');
  assert.equal(twinHasGlow(frameTwinTexels({ color: soft, height: heights(W, H), normal: null, w: W, h: H })), false, 'soft texels');
  assert.equal(twinHasGlow(frameTwinTexels({ color: binary, height: heights(W, H), normal: null, w: W, h: H, emissive: true })), true, 'an emissive sheet');
  assert.equal(twinHasGlow(frameTwinTexels({ color: binary, height: null, normal: null, w: W, h: H, emissive: true })), true, 'emissive, no heights');
  assert.equal(twinHasGlow(frameTwinTexels({ color: colour(W, H, () => 0), height: null, normal: null, w: W, h: H, emissive: true })), false, 'emissive, no opaque texel');
  assert.equal(twinHasGlow(null), false, 'no maps');
});

/** A 2D canvas in memory: what _paintMapsPage draws and reads (spriteMaps.test.js's). */
class MemCanvas {
  constructor(w, h) {
    this.width = w;
    this.height = h;
    this.data = new Uint8ClampedArray(w * h * 4);
  }
  getContext() {
    const c = this;
    return {
      drawImage(img, sx, sy, sw, sh, dx, dy) {
        for (let y = 0; y < sh; y++) {
          for (let x = 0; x < sw; x++) {
            const s = ((sy + y) * img.width + sx + x) * 4;
            const d = ((dy + y) * c.width + dx + x) * 4;
            for (let k = 0; k < 4; k++) c.data[d + k] = img.data[s + k];
          }
        }
      },
      getImageData(x, y, w, h) {
        const out = new Uint8ClampedArray(w * h * 4);
        for (let r = 0; r < h; r++) out.set(c.data.subarray(((y + r) * c.width + x) * 4, ((y + r) * c.width + x + w) * 4), r * w * 4);
        return { data: out, width: w, height: h };
      },
      putImageData(img, dx, dy) {
        for (let r = 0; r < img.height; r++) c.data.set(img.data.subarray(r * img.width * 4, (r + 1) * img.width * 4), ((dy + r) * c.width + dx) * 4);
      },
    };
  }
}

test('the twin page marks each frame it paints: glowing, or not', () => {
  const saved = [globalThis.OffscreenCanvas, globalThis.ImageData];
  globalThis.OffscreenCanvas = MemCanvas;
  globalThis.ImageData = class {
    constructor(data, width, height) {
      Object.assign(this, { data, width, height });
    }
  };
  try {
    const img = (data) => ({ width: W, height: H, data });
    const hm = img(heights(W, H));
    const frames = [
      { name: 'a', sourceImg: img(binary), sourceRect: { x: 0, y: 0, w: W, h: H }, rect: { x: 0, y: 0, width: W, height: H }, maps: { heightImg: hm, normalImg: null, gray: 0 } },
      { name: 'b', sourceImg: img(soft), sourceRect: { x: 0, y: 0, w: W, h: H }, rect: { x: 8, y: 0, width: W, height: H }, maps: { heightImg: hm, normalImg: null, gray: 0 } },
      { name: 'c', sourceImg: img(binary), sourceRect: { x: 0, y: 0, w: W, h: H }, rect: { x: 0, y: 6, width: W, height: H }, maps: { heightImg: null, normalImg: null, gray: 0, emissive: true } },
    ];
    assert.notEqual(SpriteSheetRegistry._paintMapsPage(frames, 16, 12), null);
    assert.deepEqual(frames.map((d) => d.glow), [false, false, true]);
  } finally {
    [globalThis.OffscreenCanvas, globalThis.ImageData] = saved;
  }
});

test('each frame\'s json base says what its texels hold; with no padding, every frame may glow once one does', () => {
  const json = () => ({ a: { base: { cx: 3, rx: 2, ry: 1.2 } }, b: {}, c: {}, d: {} });
  const packed = [
    { name: 'a', texels: 0, glow: false },
    { name: 'b', texels: FRAME_SOFT },
    { name: 'c', texels: FRAME_HALF, glow: true },
    { name: 'd' },
    { name: 'gone', texels: 0, glow: true },
  ];
  const f = json();
  SpriteSheetRegistry._markFrameTexels(f, packed, 2);
  assert.deepEqual(f.a.base, { cx: 3, rx: 2, ry: 1.2, texels: 0 }, 'binary, its stand base kept');
  assert.deepEqual(f.b.base, { texels: FRAME_SOFT });
  assert.deepEqual(f.c.base, { texels: FRAME_HALF | FRAME_GLOW });
  assert.equal(f.d.base, undefined, 'a frame no scan read keeps no key');
  assert.equal(f.gone, undefined, 'only the json\'s frames');
  // The page's read can reach a texel past a frame's border, the next frame's when nothing pads them.
  const g = json();
  SpriteSheetRegistry._markFrameTexels(g, packed, 0);
  assert.deepEqual([g.a.base.texels, g.b.base.texels], [FRAME_GLOW, FRAME_SOFT | FRAME_GLOW]);
  const h = json();
  SpriteSheetRegistry._markFrameTexels(h, packed.slice(0, 2), 0);
  assert.deepEqual([h.a.base.texels, h.b.base.texels], [0, FRAME_SOFT], 'no glowing frame: none may glow');
  // A base that only says what its texels hold stands nowhere: the shadow passes read it as no base, and a sheet with it
  // casts no solid.
  const out = [7, 7];
  lutBaseFloats({ texels: 0 }, out, 0);
  assert.deepEqual(out, [0, 0]);
  lutBaseFloats({ cx: 3, rx: 2, ry: 1.2, texels: FRAME_SOFT }, out, 0);
  assert.deepEqual(out, [4, 2], 'a stand base reads as before');
  const atlas = { animations: { s_a: ['a'] }, frames: { a: { base: { texels: 0 } } } };
  assert.equal(sheetCastsSolid(atlas, { animations: { a: { prefixedName: 's_a' } } }), false);
});

/**
 * What the depth programs' vertex stage reads for textureId `tid` (pixelDepth.js plainGlsl, without the word): 1 when the
 * frame has a soft or glowing texel (or the table cannot say), 0 for a plain frame.
 */
function shaderSoftOrGlow(rgba, width, height, tid) {
  const perRow = Math.floor(width / 3);
  if (tid < 0 || tid >= perRow * height || width <= 3 * perRow) return 1;
  const slot = tid % perRow;
  if (slot >= TEX_LUT_FLAGS_PER_ROW) return 1;
  const c = Math.floor(slot / TEX_LUT_FLAG_BITS);
  const f = rgba[(Math.floor(tid / perRow) * width + 3 * perRow) * 4 + c];
  assert.equal(Math.fround(f), f, 'a float32 holds the bits exactly');
  return (Math.trunc(f) >>> (slot - TEX_LUT_FLAG_BITS * c)) & 1;
}

/** Textures as the Pixi worker makes them: a json base's texels, or none (an older atlas, a frame no scan read). */
function textures(n, texelsOf) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = texelsOf(i);
    out.push({
      orig: { width: 8, height: 8 }, uvs: { x0: 0, y0: 0, x2: 0.5, y2: 0.5 }, trim: null, width: 8, height: 8,
      ...(t === undefined ? {} : { weedBase: { texels: t } }),
    });
  }
  return out;
}

test('the texture table keeps each frame\'s texels on the CPU and its soft-or-glow bit where the vertex stage reads it', () => {
  const kinds = [0, FRAME_SOFT, FRAME_HALF, FRAME_GLOW, FRAME_SOFT | FRAME_HALF, undefined];
  const texelsOf = (i) => kinds[i % kinds.length];
  const softOrGlow = (i) => {
    const t = texelsOf(i);
    return t === undefined || (t & (FRAME_SOFT | FRAME_GLOW)) !== 0 ? 1 : 0;
  };
  // One frame a row; then folded at 10 rows (3 a row) and at 400 rows (100 a row: slots past 96 have no bit).
  for (const [n, maxRows] of [[7, 2048], [25, 10], [40000, 400]]) {
    const lut = buildTextureLut(textures(n, texelsOf));
    const cpu = textureLutTexels(lut);
    assert.equal(cpu.length, n);
    for (let t = 0; t < n; t++) assert.equal(cpu[t], texelsOf(t) ?? FRAME_UNSCANNED, `frame ${t} on the CPU`);
    const rgba = packTextureLutRgba(lut, n, maxRows);
    const { perRow, width, height } = textureLutLayout(n, maxRows);
    for (let t = 0; t < n; t++) {
      const want = t % perRow < TEX_LUT_FLAGS_PER_ROW ? softOrGlow(t) : 1;
      assert.equal(shaderSoftOrGlow(rgba, width, height, t), want, `${n} frames at ${maxRows} rows, frame ${t}`);
    }
    // The frames' own texels are untouched by the flags: the size is the texture's.
    for (let t = 0; t < n; t++) {
      const at = (Math.floor(t / perRow) * width + 3 * (t % perRow)) * 4;
      assert.deepEqual(Array.from(rgba.subarray(at, at + 2)), [8, 8], `frame ${t}'s size`);
    }
  }
  // A table this module did not make (12 floats a frame and nothing beside): every frame may be soft or glow.
  const plain = packTextureLutRgba(new Float32Array(12 * 4), 4);
  assert.equal(textureLutTexels(new Float32Array(12)), null);
  for (let t = 0; t < 4; t++) assert.equal(shaderSoftOrGlow(plain, 4, 4, t), 1);
  // A table without the flags texel (three texels a row, as another layout would have it) reads as set too.
  assert.equal(shaderSoftOrGlow(new Float32Array(12), 3, 1, 0), 1);
});

test('the depth programs read the bit after their own LUT read and the edge pass uses it, in both languages', () => {
  for (const gbuf of [false, true]) {
    const vert = pixelDepthVertex(shader('instancedSprite.vert.glsl'), { gbuf });
    assert.match(vert, /flat out float vPlain;/);
    const read = vert.indexOf('texelFetch(uTexLut, ivec2(3 * lutPerRow, tid / lutPerRow), 0)');
    assert.ok(read > vert.indexOf('int lutPerRow = lutSize.x / 3;'), 'after the shader\'s own table read');
    assert.ok(vert.includes('lutSize.x > 3 * lutPerRow'), 'only when the table has the flags texel');
    assert.ok(vert.includes('& 1u) == 0u) vPlain = 1.0;'), 'plain when the bit is clear');
    assert.equal(vert.includes('if (((uint(aInstGbuf.x + 0.5) >> 19u) & 7u) != 0u) vPlain = 0.0;'), gbuf, 'an emissive word glows');
    const edge = pixelDepthFragment(shader('instancedSpriteBlend.frag.glsl'), { edge: true, gbuf });
    assert.match(edge, /flat in float vPlain;/);
    assert.match(edge, /if \(ad <= 0\.0 \|\| \(ad >= 0\.5 && vPlain > 0\.5\)\) discard;/);
    assert.doesNotMatch(pixelDepthFragment(shader('instancedSpriteBlend.frag.glsl'), { gbuf }), /vPlain/, 'the opaque pass does not read it');
    const wgsl = pixelDepthWgsl(shader('instancedSprite.wgsl'), { gbuf });
    assert.match(wgsl, /@location\(14\) @interpolate\(flat\) vPlain: f32,/);
    assert.ok(wgsl.indexOf('textureLoad(uTexLut, vec2<i32>(3 * lutPerRow, tid / lutPerRow), 0)') > wgsl.indexOf('let lutPerRow = i32(lutSize.x) / 3;'));
    assert.ok(wgsl.includes('& 1u) == 0u) { out.vPlain = 1.0; }'));
    assert.equal(wgsl.includes('if (((u32(aInstGbuf.x + 0.5) >> 19u) & 7u) != 0u) { out.vPlain = 0.0; }'), gbuf);
    assert.match(wgsl, /ad <= 0\.0 \|\| \(ad >= 0\.5 && in\.vPlain > 0\.5\)/);
  }
});
