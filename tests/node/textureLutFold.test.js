// N-111: the texture LUT (uTexLut) had one row per atlas frame, so an atlas with more frames than the GPU's
// MAX_TEXTURE_SIZE (9 020 on SwiftShader's 8 192) did not upload and nothing drew. Past TEX_LUT_MAX_ROWS frames the
// rows hold several now: textureLutLayout says how many, packTextureLutRgba puts each frame where every shader that
// reads the LUT fetches it, and below the limit the texture is the one it always was.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  packTextureLutRgba,
  TEX_LUT_FLOATS,
  TEX_LUT_MAX_ROWS,
  TEX_LUT_RGBA_WIDTH,
  textureLutLayout,
} from '../../src/render/instancedSpriteBatch.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** A CPU LUT of n frames whose floats say which frame and float they are. */
function cpuLut(n) {
  const lut = new Float32Array(n * TEX_LUT_FLOATS);
  for (let i = 0; i < lut.length; i++) lut[i] = i + 1;
  return lut;
}

/** What a shader reads for textureId `tid` from a texture `width` texels wide (its 12 floats), or null when out. */
function shaderRead(rgba, width, height, tid) {
  const perRow = Math.floor(width / 3);
  if (tid < 0 || tid >= perRow * height) return null;
  const x = 3 * (tid % perRow);
  const y = Math.floor(tid / perRow);
  const at = (y * width + x) * 4;
  return rgba.subarray(at, at + 12);
}

test('the layout: one frame a row up to TEX_LUT_MAX_ROWS, then several, never a side past it', () => {
  assert.equal(TEX_LUT_MAX_ROWS, 2048, "WebGL 2's promised MAX_TEXTURE_SIZE");
  assert.deepEqual(textureLutLayout(0), { perRow: 1, width: 3, height: 1 });
  assert.deepEqual(textureLutLayout(1), { perRow: 1, width: 3, height: 1 });
  assert.deepEqual(textureLutLayout(2048), { perRow: 1, width: 3, height: 2048 });
  assert.deepEqual(textureLutLayout(2049), { perRow: 2, width: 6, height: 1025 });
  assert.deepEqual(textureLutLayout(9020), { perRow: 5, width: 15, height: 1804 }, "Conurbano-weed's atlas");
  for (const n of [1, 7, 2047, 2048, 2049, 4097, 9020, 100000, 682 * 2048]) {
    const { perRow, width, height } = textureLutLayout(n);
    assert.ok(width <= TEX_LUT_MAX_ROWS && height <= TEX_LUT_MAX_ROWS, `${n}: ${width} x ${height}`);
    assert.ok(perRow * height >= n && perRow * (height - 1) < n, `${n}: every frame has a slot, the last row is used`);
  }
  assert.throws(() => textureLutLayout(682 * 2048 + 1), /the atlas has 1396737 frames; its texture table holds at most 1396736/);
});

test('below the limit the packed LUT is the one it always was, bit for bit', () => {
  for (const n of [1, 5, 2048]) {
    const lut = cpuLut(n);
    const rgba = packTextureLutRgba(lut, n);
    assert.equal(rgba.length, n * TEX_LUT_RGBA_WIDTH * 4);
    const old = new Float32Array(n * 12);
    for (let i = 0; i < n; i++) old.set(lut.subarray(i * TEX_LUT_FLOATS, (i + 1) * TEX_LUT_FLOATS), i * 12);
    assert.deepEqual(rgba, old, `${n} frames`);
  }
});

test('folded, every frame is where the shaders fetch it, and the slots past the last frame read zero', () => {
  // A small limit folds a small atlas the way 2048 folds a big one; then Conurbano-weed's 9 020 frames.
  for (const [n, maxRows] of [[20, 9], [9020, TEX_LUT_MAX_ROWS]]) {
    const lut = cpuLut(n);
    const rgba = packTextureLutRgba(lut, n, maxRows);
    const { perRow, width, height } = textureLutLayout(n, maxRows);
    assert.ok(perRow > 1, `${n} frames fold at ${maxRows} rows`);
    assert.equal(rgba.length, width * height * 4);
    for (let t = 0; t < n; t++) {
      const got = shaderRead(rgba, width, height, t);
      assert.deepEqual(Array.from(got.subarray(0, TEX_LUT_FLOATS)), Array.from(lut.subarray(t * TEX_LUT_FLOATS, (t + 1) * TEX_LUT_FLOATS)), `frame ${t}`);
      assert.deepEqual(Array.from(got.subarray(TEX_LUT_FLOATS)), [0, 0], `frame ${t}: the two unused floats`);
    }
    for (let t = n; t < perRow * height; t++) {
      assert.ok(shaderRead(rgba, width, height, t).every((v) => v === 0), `slot ${t} past the last frame: a zero size`);
    }
    assert.equal(shaderRead(rgba, width, height, perRow * height), null, 'out of the table: the shaders skip it');
  }
});

test('every shader that reads uTexLut reads it folded, by the texture width', () => {
  const dir = path.join(root, 'src/shaders');
  const readers = fs.readdirSync(dir).filter((f) => fs.readFileSync(path.join(dir, f), 'utf8').includes('uTexLut'));
  assert.equal(readers.length, 12, readers.join(', '));
  for (const f of readers) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    const wgsl = f.endsWith('.wgsl');
    assert.match(src, wgsl ? /let lutPerRow = i32\(lutSize\.x\) \/ 3;/ : /int lutPerRow = lutSize\.x \/ 3;/, f);
    assert.match(src, /tid < lutPerRow \* (i32\(lutSize\.y\)|lutSize\.y)\)/, `${f}: the bound covers the folded table`);
    assert.match(src, /lutAt = (ivec2|vec2<i32>)\(3 \* \(tid % lutPerRow\), tid \/ lutPerRow\)/, f);
    assert.doesNotMatch(src, wgsl ? /textureLoad\(uTexLut, vec2<i32>\(\d, tid\)/ : /texelFetch\(uTexLut, ivec2\(\d, tid\)/, `${f}: no unfolded read`);
  }
});
