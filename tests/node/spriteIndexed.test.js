import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { GPU_INDEXED_STATIC_FLOATS, GPU_STATIC_FLOATS } from '../../src/render/gpuQueueLayout.js';
import {
  STATICS_TEXELS_PER_ROW,
  STATICS_TEX_ROW,
  STATICS_TEX_ROW_SHIFT,
  spriteIndexedVertex,
  spriteIndexedWgsl,
  staticsTextureHeight,
} from '../../src/render/spriteIndexed.js';

// E-162: the indexed sprite vertex shader takes its statics from three texels of a statics row (WebGL) or three
// vec4<u32> of a storage buffer (WebGPU), the row and the depth from one instance attribute (the slot pair).
// tests/bench/spriteIndexedCompileCheck.mjs compiles both in a browser.

const shipped = readFileSync(new URL('../../src/shaders/instancedSprite.vert.glsl', import.meta.url), 'utf8');
const shippedWgsl = readFileSync(new URL('../../src/shaders/instancedSprite.wgsl', import.meta.url), 'utf8');
const STATICS = ['aInstScale', 'aInstAnchor', 'aInstDepth', 'aInstTexId', 'aInstTileInv', 'aInstTileOff'];

test('a statics row is three RGBA texels: the 11 words of the split statics and a zero', () => {
  assert.equal(STATICS_TEXELS_PER_ROW * 4, GPU_INDEXED_STATIC_FLOATS);
  assert.equal(GPU_INDEXED_STATIC_FLOATS, GPU_STATIC_FLOATS + 1);
  assert.equal(1 << STATICS_TEX_ROW_SHIFT, STATICS_TEX_ROW);
  assert.deepEqual([0, 1, 1024, 1025, 300000].map(staticsTextureHeight), [1, 1, 1, 2, 293]);
});

test('the indexed shader reads the slot pair and the texture, and fills every static', () => {
  const out = spriteIndexedVertex(shipped);
  for (const name of [...STATICS, 'aInstTintBits']) {
    assert.doesNotMatch(out, new RegExp(`^in \\w+ ${name};`, 'm'), `${name} is no attribute`);
  }
  for (const name of STATICS) assert.match(out, new RegExp(`^\\s+${name} = `, 'm'), `${name} is filled in main`);
  // The tint's bits as the uint they are: no float between the texture and the shader (a NaN pattern could change).
  assert.match(out, /^\s+uint tintBits = weedS1\.y;/m);
  assert.doesNotMatch(out, /floatBitsToUint\(aInstTintBits\)|aInstTintBits = /);
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
  assert.throws(() => spriteIndexedVertex(shipped.replace('floatBitsToUint(aInstTintBits)', 'floatBitsToUint(aInstTexId)')), /tintBits/);
});

test('the indexed WGSL reads the slot pair and the storage buffer, the statics as lets of their names', () => {
  const out = spriteIndexedWgsl(shippedWgsl);
  const from = out.indexOf('fn mainVert(');
  const head = out.slice(from, out.indexOf(') -> VertexOut {', from));
  for (const name of [...STATICS, 'aInstTintBits']) assert.doesNotMatch(head, new RegExp(`\\b${name}:`), `${name} is no input`);
  for (const name of STATICS) assert.match(out, new RegExp(`^  let ${name} = `, 'm'), `${name} is a let`);
  for (const kept of ['aQuad', 'aInstXY', 'aInstRotCS', 'aInstSlot']) {
    assert.match(head, new RegExp(`@location\\(\\d+\\) ${kept}: vec2<f32>,`), `${kept} is an input`);
  }
  const locations = [...head.matchAll(/@location\((\d+)\)/g)].map((m) => m[1]);
  assert.equal(new Set(locations).size, locations.length, `one input a location: ${locations}`);
  assert.match(out, /^@group\(2\) @binding\(4\) var<storage, read> uStatics: array<vec4<u32>>;/m);
  assert.match(out, /^  let tintBits = weedS1\.y;/m, 'the tint\'s bits as the u32 they are');
  assert.doesNotMatch(out, /aInstTintBits/);
  assert.match(out, /let aInstDepth = aInstSlot\.y;/);
  assert.equal(out.split('fn mainVert(').length, 2, 'one vertex entry');
  assert.throws(() => spriteIndexedWgsl(shippedWgsl.replace('  @location(9) aInstTileOff: vec2<f32>,\n', '')), /aInstTileOff/);
  assert.throws(() => spriteIndexedWgsl(shippedWgsl.replace('bitcast<u32>(aInstTintBits)', 'bitcast<u32>(aInstTexId)')), /tintBits/);
});
