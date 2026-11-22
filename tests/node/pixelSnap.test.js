import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyPixelSnap, pixelSnapGlsl, pixelSnapWgsl } from '../../src/render/pixelSnap.js';

const shaders = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/shaders');
const read = (name) => fs.readFileSync(path.join(shaders, name), 'utf8');
const count = (s, part) => s.split(part).length - 1;

test('N-271, N-302: the sprite sources snap their drawn corners (axis-aligned) or origin, and keep aInstXY true', () => {
  const square = '!isShear && abs(s) < 1e-4';
  const vert = pixelSnapGlsl(read('instancedSprite.vert.glsl'));
  assert.equal(count(vert, 'vec2 weedSnapXY(vec2 v)'), 1);
  assert.equal(count(vert, 'vec2 weedSnapWorld(vec2 origin, vec2 corner, bool square)'), 1);
  assert.ok(vert.includes(`vec2 world = weedSnapWorld(aInstXY, isShear ? sheared : spun, ${square});`));
  assert.ok(vert.indexOf('vec2 weedSnapWorld') < vert.indexOf('void main()'), 'the functions come before main');

  const pose = pixelSnapGlsl(read('instancedSpritePose.vert.glsl'));
  assert.ok(pose.includes('vec2 xy = mix(aInstPrevXY, aInstXY, uPoseAlpha);'), 'the blend is untouched');
  assert.ok(pose.includes(`vec2 world = weedSnapWorld(xy, isShear ? sheared : spun, ${square});`), 'a blended pose snaps after its blend');

  const wgsl = pixelSnapWgsl(read('instancedSprite.wgsl'));
  assert.equal(count(wgsl, 'fn weedSnapXY('), 1);
  assert.equal(count(wgsl, 'fn weedSnapWorld('), 1);
  assert.ok(wgsl.includes(`let world = weedSnapWorld(aInstXY, select(spun, sheared, isShear), ${square});`));
  const wgslPose = pixelSnapWgsl(read('instancedSpritePose.wgsl'));
  assert.ok(wgslPose.includes(`let world = weedSnapWorld(xy, select(spun, sheared, isShear), ${square});`));

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

// N-302: a floor of 16 px pieces edge to edge at zoom 1.2 (19.2 px on screen). Each piece's left edge is its origin, its
// right edge its origin plus 16. Origins rounded alone leave a column every fifth piece (a 0.8 px gap swallows a pixel
// centre); corners rounded put both sides of a shared edge on the same pixel.
test('N-302: corners on the grid leave no seam between pieces edge to edge at a fractional zoom, origins alone did', () => {
  for (const zoom of [1.2, 1.3, 1.45, 2.7]) {
    const cam = 1000.37;
    const m = [[zoom, 0, 0], [0, zoom, 0], [-cam * zoom, 0, 1]];
    const stageX = (x) => m[0][0] * x + m[2][0];
    const covered = (left, right) => {
      // Pixels whose centres a span covers, as the rasterizer fills them: [ceil(left - 0.5), ceil(right - 0.5)).
      const set = new Set();
      for (let p = Math.ceil(left - 0.5); p < Math.ceil(right - 0.5); p++) set.add(p);
      return set;
    };
    const holes = (corners) => {
      const all = new Set();
      let lo = Infinity;
      let hi = -Infinity;
      for (let c = 0; c < 60; c++) {
        const [l, r] = corners(1000 + c * 16);
        for (const p of covered(stageX(l), stageX(r))) all.add(p);
        lo = Math.min(lo, Math.ceil(stageX(l) - 0.5));
        hi = Math.max(hi, Math.ceil(stageX(r) - 0.5));
      }
      let n = 0;
      for (let p = lo; p < hi; p++) if (!all.has(p)) n++;
      return n;
    };
    const snap = (x) => snapLikeShader(m, [x, 0])[0];
    const byOrigin = holes((x) => [snap(x), snap(x) + 16]);
    const byCorner = holes((x) => [snap(x), snap(x + 16)]);
    assert.equal(byCorner, 0, `zoom ${zoom}: corners on the grid`);
    if (zoom === 1.2 || zoom === 1.45) assert.ok(byOrigin > 0, `zoom ${zoom}: origins alone left ${byOrigin} holes`);
  }
});

test('N-302: renderer.pixelSnapCorners false snaps every sprite\'s origin, its size on screen kept', () => {
  const gl = { spriteVert: read('instancedSprite.vert.glsl'), spriteVertPose: read('instancedSpritePose.vert.glsl') };
  applyPixelSnap(gl, false, false);
  assert.ok(gl.spriteVert.includes('vec2 world = weedSnapWorld(aInstXY, isShear ? sheared : spun, false);'));
  assert.ok(gl.spriteVertPose.includes('vec2 world = weedSnapWorld(xy, isShear ? sheared : spun, false);'));
  const gpu = { sprite: read('instancedSprite.wgsl'), spritePose: read('instancedSpritePose.wgsl') };
  applyPixelSnap(gpu, true, false);
  assert.ok(gpu.sprite.includes('let world = weedSnapWorld(aInstXY, select(spun, sheared, isShear), false);'));
  assert.ok(gpu.spritePose.includes('let world = weedSnapWorld(xy, select(spun, sheared, isShear), false);'));
});
