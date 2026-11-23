// DX-GBUFSHADER: a SCREEN pass's look shader that names uGbufFace or uGbufIds reads the frame's G-buffer (the face map
// and the entity ids map). WGSL: the look prelude declares both textures after uScene's binding and gives gbufTexel(uv);
// the look program's layout binds them. GLSL: the shader declares them, and the engine gives gbufUv(uv), since WebGL's
// render targets hold the G-buffer upside down against vTextureCoord. uGbufSize is an engine look uniform.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildLookPrelude } from '../../src/render/webgpu/wgslPrelude.js';
import { lookGpuProgram } from '../../src/render/webgpu/pixiMeshWgsl.js';
import { withGbufUvGlsl } from '../../src/render/pixi/lookShaders.js';
import { RESERVED_LOOK_UNIFORMS } from '../../src/core/layer.js';

test('the WGSL look prelude declares the G-buffer after uScene, with gbufTexel', () => {
  const plain = buildLookPrelude(null, null, {});
  assert.doesNotMatch(plain, /uGbuf/);
  const gbuf = buildLookPrelude(null, null, { gbuf: true });
  assert.match(gbuf, /@group\(2\) @binding\(3\) var uGbufFace: texture_2d<f32>;/);
  assert.match(gbuf, /@group\(2\) @binding\(4\) var uGbufIds: texture_2d<f32>;/);
  assert.match(gbuf, /fn gbufTexel\(uv: vec2<f32>\) -> vec2<i32>/);
  const both = buildLookPrelude(null, null, { scene: true, gbuf: true });
  assert.match(both, /@binding\(3\) var uScene/);
  assert.match(both, /@binding\(4\) var uGbufFace/);
  assert.match(both, /@binding\(5\) var uGbufIds/);
});

test('the look program binds the G-buffer at the prelude\'s bindings', () => {
  const GpuProgram = { from: (o) => o };
  const layout = (scene, gbuf) => lookGpuProgram(GpuProgram, 'fn mainFrag() {}', 'look', 'fn mainVert() {}', { scene, gbuf });
  const at = (p, name) => p.layout[2][name];
  const g = layout(false, true);
  assert.equal(at(g, 'uGbufFace'), 3);
  assert.equal(at(g, 'uGbufIds'), 4);
  const s = layout(true, true);
  assert.equal(at(s, 'uScene'), 3);
  assert.equal(at(s, 'uGbufFace'), 4);
  assert.equal(at(s, 'uGbufIds'), 5);
  assert.equal(at(layout(false, false), 'uGbufFace'), undefined);
  const bindings = g.gpuLayout[g.gpuLayout.length - 1].map((e) => e.binding);
  assert.deepEqual(bindings, [0, 1, 2, 3, 4]);
});

test('a GLSL look that reads the G-buffer gets gbufUv after its float precision (or first)', () => {
  const src = 'precision mediump float;\nvarying vec2 vTextureCoord;\nvoid main() {}\n';
  const out = withGbufUvGlsl(src);
  assert.equal(out, 'precision mediump float;\nvec2 gbufUv(vec2 uv) { return vec2(uv.x, 1.0 - uv.y); }\nvarying vec2 vTextureCoord;\nvoid main() {}\n');
  assert.ok(withGbufUvGlsl('void main() {}\n').startsWith('vec2 gbufUv'));
  assert.match(withGbufUvGlsl('#version 300 es\nvoid main() {}\n'), /^#version 300 es\nvec2 gbufUv/);
});

test('uGbufSize is an engine look uniform', () => {
  assert.deepEqual(RESERVED_LOOK_UNIFORMS.uGbufSize, { value: [0, 0], type: 'vec2<f32>' });
});
