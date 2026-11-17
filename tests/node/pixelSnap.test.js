import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyPixelSnap, pixelSnapGlsl, pixelSnapWgsl } from '../../src/render/pixelSnap.js';

const shaders = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/shaders');
const read = (name) => fs.readFileSync(path.join(shaders, name), 'utf8');
const count = (s, part) => s.split(part).length - 1;

test('N-271: the sprite sources snap their drawn origin and keep aInstXY true', () => {
  const vert = pixelSnapGlsl(read('instancedSprite.vert.glsl'));
  assert.equal(count(vert, 'vec2 weedSnapXY(vec2 v)'), 1);
  assert.ok(vert.includes('vec2 world = (isShear ? sheared : spun) + weedSnapXY(aInstXY);'));
  assert.ok(vert.indexOf('vec2 weedSnapXY') < vert.indexOf('void main()'), 'the function comes before main');

  const pose = pixelSnapGlsl(read('instancedSpritePose.vert.glsl'));
  assert.ok(pose.includes('vec2 xy = weedSnapXY(mix(aInstPrevXY, aInstXY, uPoseAlpha));'), 'a blended pose snaps after its blend');

  const wgsl = pixelSnapWgsl(read('instancedSprite.wgsl'));
  assert.equal(count(wgsl, 'fn weedSnapXY('), 1);
  assert.ok(wgsl.includes('let world = select(spun, sheared, isShear) + weedSnapXY(aInstXY);'));
  const wgslPose = pixelSnapWgsl(read('instancedSpritePose.wgsl'));
  assert.ok(wgslPose.includes('let xy = weedSnapXY(mix(aInstPrevXY, aInstXY, uniforms.uPoseAlpha));'));

  assert.throws(() => pixelSnapGlsl('void main() {}'), /pixel snap/);
});

test('N-271: applyPixelSnap changes the backend\'s sprite sources once', () => {
  const gl = { spriteVert: read('instancedSprite.vert.glsl'), spriteVertPose: read('instancedSpritePose.vert.glsl'), sprite: 'untouched' };
  applyPixelSnap(gl, false);
  applyPixelSnap(gl, false);
  assert.equal(count(gl.spriteVert, 'vec2 weedSnapXY('), 1);
  assert.equal(count(gl.spriteVertPose, 'vec2 weedSnapXY('), 1);
  assert.equal(gl.sprite, 'untouched');
  const gpu = { sprite: read('instancedSprite.wgsl'), spritePose: read('instancedSpritePose.wgsl') };
  applyPixelSnap(gpu, true);
  assert.equal(count(gpu.sprite, 'fn weedSnapXY('), 1);
  assert.equal(count(gpu.spritePose, 'fn weedSnapXY('), 1);
});

/** weedSnapXY as the shaders write it (column-major mat3: m[col][row]), in float64. */
function snapLikeShader(m, v) {
  const px = m[0][0] * v[0] + m[1][0] * v[1] + m[2][0];
  const py = m[0][1] * v[0] + m[1][1] * v[1] + m[2][1];
  const dx = Math.floor(px + 0.5) - px;
  const dy = Math.floor(py + 0.5) - py;
  const det = m[0][0] * m[1][1] - m[1][0] * m[0][1];
  return [v[0] + (m[1][1] * dx - m[1][0] * dy) / det, v[1] + (m[0][0] * dy - m[0][1] * dx) / det];
}

test('N-271: the snap lands on the grid the packs used, and on whole pixels under a turned camera', () => {
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 2000; i++) {
    const zoom = 0.25 + rand() * 3.75;
    const cam = [rand() * 20000, rand() * 9000];
    const v = [cam[0] + rand() * 1500, cam[1] + rand() * 900];
    // The camera's transform (pixiWorker: a = d = zoom, tx = -cameraX * zoom): column-major.
    const m = [[zoom, 0, 0], [0, zoom, 0], [-cam[0] * zoom, -cam[1] * zoom, 1]];
    const s = snapLikeShader(m, v);
    for (let k = 0; k < 2; k++) {
      const packs = Math.round((v[k] - cam[k]) * zoom) / zoom + cam[k];
      assert.ok(Math.abs(s[k] - packs) < 1e-6, `axis ${k}: ${s[k]} vs ${packs}`);
    }
  }
  const rot = 0.4;
  const z = 1.7;
  const m = [[z * Math.cos(rot), z * Math.sin(rot), 0], [-z * Math.sin(rot), z * Math.cos(rot), 0], [312.25, -97.6, 1]];
  for (let i = 0; i < 200; i++) {
    const s = snapLikeShader(m, [rand() * 900, rand() * 600]);
    const px = m[0][0] * s[0] + m[1][0] * s[1] + m[2][0];
    const py = m[0][1] * s[0] + m[1][1] * s[1] + m[2][1];
    assert.ok(Math.abs(px - Math.round(px)) < 1e-6 && Math.abs(py - Math.round(py)) < 1e-6);
  }
});
