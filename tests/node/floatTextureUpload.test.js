// E-259: Pixi's float data textures (light data, the texture LUT, the animation start table, each batch's poses) are
// allocated once and then written in place. Before, every upload called source.update() (Pixi re-specified the texture
// with no data) and gl.texImage2D with the data, with the sampling parameters set again: two reallocations a frame.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadWorker } from '../bench/workerHarness.mjs';

/** A WebGL2 context that records the calls this path makes. */
function fakeGl() {
  const calls = [];
  const gl = {
    TEXTURE_2D: 0x0de1,
    TEXTURE_BINDING_2D: 0x8069,
    RGBA32F: 0x8814,
    RGBA: 0x1908,
    FLOAT: 0x1406,
    UNPACK_ALIGNMENT: 0x0cf5,
    UNPACK_FLIP_Y_WEBGL: 0x9240,
    UNPACK_PREMULTIPLY_ALPHA_WEBGL: 0x9241,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    NEAREST: 0x2600,
    CLAMP_TO_EDGE: 0x812f,
    calls,
  };
  for (const name of ['bindTexture', 'pixelStorei', 'texImage2D', 'texSubImage2D', 'texParameteri']) {
    gl[name] = (...args) => calls.push([name, ...args]);
  }
  gl.getParameter = () => 'previous-texture';
  return gl;
}

function rig(px) {
  const gl = fakeGl();
  const glTexture = { id: 'gl-texture' };
  let updates = 0;
  const glSources = new Map();
  const texture = {
    bind: (source) => glSources.set(source, { texture: glTexture, target: gl.TEXTURE_2D }),
    getGlSource: (source) => glSources.get(source) || null,
  };
  px.pixiApp = { renderer: { gl, texture } };
  const source = { update: () => updates++ };
  return { gl, source, glSources, updates: () => updates };
}

const names = (calls) => calls.map((c) => c[0]);

test('E-259: the first upload allocates the texture; the next ones write it in place', async () => {
  const px = await loadWorker('pixiWorker.js', 'pixiRenderer');
  const { gl, source, updates } = rig(px);
  const data = new Float32Array(256 * 3 * 4).fill(0.5);

  px._uploadRgba32FloatGl(source, data, 256, 3);
  assert.equal(updates(), 1, 'the first upload goes through the source');
  assert.equal(names(gl.calls).filter((n) => n === 'texImage2D').length, 1);
  assert.equal(names(gl.calls).filter((n) => n === 'texParameteri').length, 4);

  gl.calls.length = 0;
  for (let f = 0; f < 3; f++) px._uploadRgba32FloatGl(source, data, 256, 3);
  assert.equal(updates(), 1, 'no source.update after the first');
  const n = names(gl.calls);
  assert.equal(n.filter((x) => x === 'texImage2D').length, 0, 'no reallocation');
  assert.equal(n.filter((x) => x === 'texParameteri').length, 0, 'the parameters stay');
  const subs = gl.calls.filter((c) => c[0] === 'texSubImage2D');
  assert.equal(subs.length, 3);
  assert.deepEqual(subs[0].slice(1, 9), [gl.TEXTURE_2D, 0, 0, 0, 256, 3, gl.RGBA, gl.FLOAT]);
  assert.equal(subs[0][9], data);
  // The texture bound on the active unit before the upload is bound again after it (N-94).
  const binds = gl.calls.filter((c) => c[0] === 'bindTexture');
  assert.equal(binds.at(-1)[2], 'previous-texture');
  // Rows unpacked as written: no flip, no premultiplication.
  assert.ok(gl.calls.some((c) => c[0] === 'pixelStorei' && c[1] === gl.UNPACK_FLIP_Y_WEBGL && c[2] === 0));
  assert.ok(gl.calls.some((c) => c[0] === 'pixelStorei' && c[1] === gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL && c[2] === 0));
});

test('E-259: a new size, or a texture Pixi made again, is allocated again', async () => {
  const px = await loadWorker('pixiWorker.js', 'pixiRenderer');
  const { gl, source, glSources, updates } = rig(px);
  px._uploadRgba32FloatGl(source, new Float32Array(64 * 3 * 4), 64, 3);
  gl.calls.length = 0;
  px._uploadRgba32FloatGl(source, new Float32Array(128 * 3 * 4), 128, 3);
  assert.equal(names(gl.calls).filter((n) => n === 'texImage2D').length, 1, 'the size changed');
  gl.calls.length = 0;
  glSources.set(source, { texture: { id: 'after a context restore' }, target: gl.TEXTURE_2D });
  px._uploadRgba32FloatGl(source, new Float32Array(128 * 3 * 4), 128, 3);
  assert.equal(names(gl.calls).filter((n) => n === 'texImage2D').length, 1, 'Pixi holds another texture');
  assert.equal(updates(), 3);
});
