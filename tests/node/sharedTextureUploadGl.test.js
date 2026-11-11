// N-127: a worldRect layer's float pictures went up on WebGL as bytes with type FLOAT, which WebGL 2 refuses ("type
// FLOAT but ArrayBufferView not Float32Array", for the picture's first allocation as for each upload), and r32float as
// RGBA. A probe on a real WebGL2 Pixi renderer read both float formats back empty before and exact after; here
// uploadSharedImage's call to texSubImage2D and the pictures' first contents, on a stand-in for GL.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createSharedTextureSource } from '../../src/render/worldTextureMesh.js';
import { uploadSharedImage } from '../../src/render/sharedTextureUpload.js';

function fakeGl() {
  const calls = [];
  const gl = {
    TEXTURE_2D: 1, TEXTURE_BINDING_2D: 2, UNPACK_ALIGNMENT: 3, UNPACK_ROW_LENGTH: 4,
    RED: 10, RGBA: 11, FLOAT: 20, UNSIGNED_BYTE: 21,
    getParameter: () => null,
    bindTexture() {},
    pixelStorei() {},
    texSubImage2D: (...args) => calls.push(args),
  };
  return { gl, calls };
}

function upload(format, bytes, width, height, rect) {
  const { gl, calls } = fakeGl();
  const renderer = { texture: { bind() {}, getGlSource: () => ({ texture: {} }) } };
  uploadSharedImage({ useWebGpu: false, gl, renderer, source: { update() {} }, bytes, width, height, format, rect, glReady: true });
  assert.equal(calls.length, 1, `${format}: one upload`);
  const [target, level, x, y, w, h, fmt, type, data, offset] = calls[0];
  return { gl, target, level, x, y, w, h, fmt, type, data, offset };
}

test('a float picture goes up as floats, offset in floats, and r32float as RED', () => {
  const width = 16;
  const height = 8;
  const rect = { x: 3, y: 2, w: 9, h: 4 };
  for (const [format, channels] of [['r32float', 1], ['rgba32float', 4]]) {
    const sab = new SharedArrayBuffer(64 + width * height * channels * 4);
    const bytes = new Uint8Array(sab, 64, width * height * channels * 4);
    const u = upload(format, bytes, width, height, rect);
    assert.equal(u.type, u.gl.FLOAT, `${format}: FLOAT`);
    assert.equal(u.fmt, channels === 1 ? u.gl.RED : u.gl.RGBA, `${format}: its channels`);
    assert.ok(u.data instanceof Float32Array, `${format}: a Float32Array`);
    assert.equal(u.data.buffer, sab, `${format}: over the same memory`);
    assert.equal(u.data.byteOffset, 64);
    assert.equal(u.data.length, width * height * channels);
    assert.equal(u.offset, (rect.y * width + rect.x) * channels, `${format}: the rectangle's first float`);
    assert.deepEqual([u.x, u.y, u.w, u.h], [rect.x, rect.y, rect.w, rect.h]);
  }
});

test('a byte picture goes up as bytes, offset in bytes, one channel as RED', () => {
  const width = 16;
  const height = 8;
  const rect = { x: 1, y: 3, w: 5, h: 2 };
  for (const [format, channels] of [['r8unorm', 1], ['rgba8unorm', 4]]) {
    const bytes = new Uint8Array(new SharedArrayBuffer(width * height * channels));
    const u = upload(format, bytes, width, height, rect);
    assert.equal(u.type, u.gl.UNSIGNED_BYTE, `${format}: UNSIGNED_BYTE`);
    assert.equal(u.fmt, channels === 1 ? u.gl.RED : u.gl.RGBA);
    assert.equal(u.data, bytes, `${format}: the bytes themselves`);
    assert.equal(u.offset, (rect.y * width + rect.x) * channels);
  }
});

test('a float picture starts as floats, a byte picture as bytes', () => {
  const made = (format) => createSharedTextureSource({ name: format, width: 4, height: 2, format }, null, false).resource;
  assert.ok(made('r32float') instanceof Float32Array);
  assert.equal(made('r32float').length, 4 * 2);
  assert.ok(made('rgba32float') instanceof Float32Array);
  assert.equal(made('rgba32float').length, 4 * 2 * 4);
  assert.ok(made('r8unorm') instanceof Uint8Array);
  assert.ok(made('rgba8unorm') instanceof Uint8Array);
});
