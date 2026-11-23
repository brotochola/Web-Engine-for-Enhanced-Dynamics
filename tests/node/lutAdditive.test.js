// N-418: the texture table's additive flags texel. In a 'sorted' scene the lights' halos' own frame (_lightHalo) is marked
// additive, so its sprite vertex shader sends its alpha negative and the fragments add its colour (alpha 0): a sorted
// halo adds its light as the 'add' layer does, and what stands in front still covers it. A table without such a frame
// keeps its one flags texel, so its shaders read nothing more.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TEX_LUT_FLOATS, TEX_LUT_RGBA_WIDTH, lutFlagTexels, packTextureLutRgba, textureLutLayout,
} from '../../src/render/instancedSpriteBatch.js';
import { TEX_LUT_FLAG_BITS } from '../../src/render/frameBase.js';
import { BUILTIN_TEXTURES } from '../../src/core/atlas/atlasBuiltins.js';
import { readEngineShader } from './engineShaderSources.mjs';

test('a table with an additive frame holds a second flags texel with its bit; one without keeps its width', () => {
  const n = 5;
  const lut = new Float32Array(n * TEX_LUT_FLOATS);
  assert.equal(lutFlagTexels(null), 1);
  assert.equal(lutFlagTexels(new Uint8Array(n)), 1, 'no frame flagged');
  const additive = new Uint8Array(n);
  additive[3] = 1;
  assert.equal(lutFlagTexels(additive), 2);
  const plain = textureLutLayout(n);
  const wide = textureLutLayout(n, undefined, 2);
  assert.equal(wide.width, plain.width + 1);
  assert.equal(Math.floor(wide.width / TEX_LUT_RGBA_WIDTH), wide.perRow, 'the shaders still find perRow as width / 3');
  const rgba = packTextureLutRgba(lut, n, undefined, additive);
  assert.equal(rgba.length, wide.width * wide.height * 4);
  // One row a frame (perRow 1): frame 3's additive texel, channel 0, bit 0.
  const { perRow, width } = wide;
  for (let i = 0; i < n; i++) {
    const row = (i / perRow) | 0;
    const slot = i % perRow;
    const v = rgba[(row * width + perRow * TEX_LUT_RGBA_WIDTH + 1) * 4 + ((slot / TEX_LUT_FLAG_BITS) | 0)];
    assert.equal(((v >>> (slot % TEX_LUT_FLAG_BITS)) & 1) === 1, i === 3, `frame ${i}`);
  }
  assert.equal(packTextureLutRgba(lut, n).length, plain.width * plain.height * 4);
});

test("the halos' frame is a built-in of its own, drawn as the compact glow, unshaded where the halos join the entities", () => {
  const halo = BUILTIN_TEXTURES.find((b) => b.name === '_lightHalo');
  assert.ok(halo, 'a built-in');
  assert.equal(halo.glow, true);
});

test('the sprite shaders send an additive frame\'s alpha negative and add its colour, in both dialects', () => {
  assert.match(readEngineShader('instancedSprite.vert.glsl'), /vColor = vec4\(rgb, instA \* uColor\.a \* weedAddSign\);/);
  assert.match(readEngineShader('instancedSprite.frag.glsl'), /float a = vColor\.a < 0\.0 \? 0\.0 : t\.a \* ia;/);
  const wgsl = readEngineShader('instancedSprite.wgsl');
  assert.match(wgsl, /instA \* localUniforms\.uColor\.a \* weedAddSign/);
  assert.match(wgsl, /let a = select\(t\.a \* ia, 0\.0, in\.vColor\.a < 0\.0\);/);
});
