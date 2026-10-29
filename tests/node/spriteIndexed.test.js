import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { GPU_INDEXED_STATIC_FLOATS, GPU_STATIC_FLOATS } from '../../src/render/gpuQueueLayout.js';
import {
  STATICS_TEXELS_PER_ROW,
  STATICS_TEX_ROW,
  STATICS_TEX_ROW_SHIFT,
  spriteIndexedVertex,
  staticsTextureHeight,
} from '../../src/render/spriteIndexed.js';

// E-162: the indexed sprite vertex shader takes its statics from three texels of a statics row, the row and the depth
// from one instance attribute (the slot pair). tests/bench/spriteIndexedCompileCheck.mjs compiles and links it in a
// browser's WebGL2.

const shipped = readFileSync(new URL('../../src/shaders/instancedSprite.vert.glsl', import.meta.url), 'utf8');

test('a statics row is three RGBA texels: the 11 words of the split statics and a zero', () => {
  assert.equal(STATICS_TEXELS_PER_ROW * 4, GPU_INDEXED_STATIC_FLOATS);
  assert.equal(GPU_INDEXED_STATIC_FLOATS, GPU_STATIC_FLOATS + 1);
  assert.equal(1 << STATICS_TEX_ROW_SHIFT, STATICS_TEX_ROW);
  assert.deepEqual([0, 1, 1024, 1025, 300000].map(staticsTextureHeight), [1, 1, 1, 2, 293]);
});

test('the indexed shader reads the slot pair and the texture, and fills every static', () => {
  const out = spriteIndexedVertex(shipped);
  for (const name of ['aInstScale', 'aInstAnchor', 'aInstDepth', 'aInstTintBits', 'aInstTexId', 'aInstTileInv', 'aInstTileOff']) {
    assert.doesNotMatch(out, new RegExp(`^in \\w+ ${name};`, 'm'), `${name} is no attribute`);
    assert.match(out, new RegExp(`^\\s+${name} = `, 'm'), `${name} is filled in main`);
  }
  for (const kept of ['aQuad', 'aInstXY', 'aInstRotCS']) assert.match(out, new RegExp(`^in vec2 ${kept};`, 'm'), `${kept} stays`);
  assert.match(out, /^in vec2 aInstSlot;/m, 'the slot pair, an attribute of its own name');
  assert.match(out, /aInstDepth = aInstSlot\.y;/);
  assert.match(out, /^uniform highp usampler2D uStatics;/m);
  assert.doesNotMatch(out, /gl_InstanceID|uFirstInstance/, 'nothing depends on where a chunk starts');
  assert.equal(out.split('void main() {').length, 2, 'one main');
});

test('the rewrite refuses a shader it does not know', () => {
  assert.throws(() => spriteIndexedVertex(shipped.replace('in vec2 aInstTileOff;', '')), /aInstTileOff/);
  assert.throws(() => spriteIndexedVertex(shipped.replace('void main() {', 'void notMain() {')), /void main/);
});
