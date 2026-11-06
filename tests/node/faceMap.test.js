/** DX-FACES: what a decoration says about its face, what the shaders are made of, on the real sources. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  FACE_DEFAULTS,
  decodeFaceNormal,
  encodeFaceHeight,
  encodeFaceNormal,
  faceMapVertex,
  faceMapWgsl,
  resolveFaces,
  shaderWithFlag,
} from '../../src/render/faceMap.js';
import { spriteIndexedVertex, spriteIndexedWgsl } from '../../src/render/spriteIndexed.js';
import { DecorationComponent } from '../../src/components/decorationComponent.js';
import { DecorationPool } from '../../src/core/decorationPool.js';
import { buildPoolScene } from '../helpers/poolScene.mjs';

const shader = (name) => fs.readFileSync(new URL(`../../src/shaders/${name}`, import.meta.url), 'utf8');

const angleDeg = (a, b) => (Math.acos(Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])) * 180) / Math.PI;

test('a normal comes back within a degree, whichever way it looks, and no code has a zero byte', () => {
  const out = [0, 0, 0];
  let seed = 7;
  const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let i = 0; i < 20000; i++) {
    const v = [r(), r(), r()];
    const len = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
    const n = v.map((c) => c / len);
    const code = encodeFaceNormal(n[0], n[1], n[2]);
    assert.ok(code >> 8 > 0 && (code & 255) > 0, `code ${code} would read as no face`);
    assert.ok(angleDeg(n, decodeFaceNormal(code, out)) < 1, `${n} came back as ${out}`);
  }
});

test('walls on the axes and at 45 degrees come back exact', () => {
  const s = Math.SQRT1_2;
  const out = [0, 0, 0];
  for (const n of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1], [s, s, 0], [-s, s, 0], [s, -s, 0], [-s, -s, 0]]) {
    decodeFaceNormal(encodeFaceNormal(n[0], n[1], n[2]), out);
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(out[i] - n[i]) < 1e-12, `${n}: ${out}`);
  }
});

test('a normal need not be unit length, and a zero one is no face', () => {
  assert.equal(encodeFaceNormal(0, 0, 0), 0);
  assert.equal(encodeFaceNormal(3, 4, 0), encodeFaceNormal(0.6, 0.8, 0));
});

test('a height is kept in eighths of a px, inside 16 bits', () => {
  assert.equal(encodeFaceHeight(0), 0);
  assert.equal(encodeFaceHeight(1.25), 10);
  assert.equal(encodeFaceHeight(-3), 0);
  assert.equal(encodeFaceHeight(1e6), 65535);
});

test('resolveFaces: off without the option or with raycasted lighting, and the defaults under what the scene sets', () => {
  assert.deepEqual(resolveFaces(null), { ...FACE_DEFAULTS });
  assert.deepEqual(resolveFaces({ faces: { enabled: false, wrap: 1 } }), { ...FACE_DEFAULTS });
  assert.equal(resolveFaces({ raycasted: true, faces: { enabled: true } }).enabled, false);
  const on = resolveFaces({ faces: { enabled: true, wrap: 0.5 } });
  assert.equal(on.enabled, true);
  assert.equal(on.wrap, 0.5);
  assert.equal(on.gain, FACE_DEFAULTS.gain);
});

test('without faces the light pass is the old one: no face code left in either shader', () => {
  for (const name of ['lightingBasic.frag.glsl', 'lightingBasic.wgsl']) {
    const source = shader(name);
    const off = shaderWithFlag(source, 'FACES', false);
    assert.doesNotMatch(off, /uFace|faceLight|#if|#endif/, name);
    const on = shaderWithFlag(source, 'FACES', true);
    assert.match(on, /uFaceMap/, name);
    assert.doesNotMatch(on, /#if|#endif/, name);
  }
});

test('the face map is made from every sprite vertex shader the batch uses', () => {
  for (const name of ['instancedSprite.vert.glsl', 'instancedSpritePose.vert.glsl']) {
    const v = faceMapVertex(shader(name));
    assert.match(v, /flat out vec2 vFaceOct;/, name);
    assert.match(v, /vFaceZ = aInstTileOff\.y \* /, name);
  }
  const indexed = spriteIndexedVertex(faceMapVertex(shader('instancedSprite.vert.glsl')));
  assert.match(indexed, /vFaceZ = aInstTileOff\.y \* /);
  assert.throws(() => faceMapVertex('void main() {\n}\n'), /vTileOff/);
  for (const name of ['instancedSprite.wgsl', 'instancedSpritePose.wgsl']) {
    const w = faceMapWgsl(shader(name));
    assert.match(w, /fn mainFragFace/, name);
    assert.match(w, /@interpolate\(flat\) vFaceOct/, name);
  }
  assert.match(spriteIndexedWgsl(faceMapWgsl(shader('instancedSprite.wgsl'))), /fn mainFragFace/);
  assert.throws(() => faceMapWgsl('struct S {}\n'), /uTileWorld/);
});

test('the height scale of the shaders is the encoder\'s', () => {
  // A face at 100 px reads back as 100 in the vertex shader's float: u16 / 65535 * scale.
  const scale = Number(faceMapVertex(shader('instancedSprite.vert.glsl')).match(/aInstTileOff\.y \* ([\d.]+)/)[1]);
  const code = encodeFaceHeight(100);
  assert.ok(Math.abs((code / 65535) * scale - 100) < 1e-3);
  assert.match(shader('faceMap.frag.glsl'), /vFaceZ \* 8\.0/);
  assert.match(shader('lightingBasic.frag.glsl'), /\/ 8\.0;/);
});

test('a decoration spawned with a face holds it, and its slot does not hand it to the next one', () => {
  buildPoolScene({ decorations: 8 });
  const D = DecorationComponent;
  const wall = DecorationPool.spawn({ x: 10, y: 20, faceNormalX: 0, faceNormalY: 1, faceNormalZ: 0, faceHeight: 40 });
  assert.equal(D.faceOct[wall], encodeFaceNormal(0, 1, 0));
  assert.equal(D.faceZ[wall], encodeFaceHeight(40));
  const plain = DecorationPool.spawn({ x: 10, y: 20 });
  assert.equal(D.faceOct[plain], 0, 'no normal, no face');
  assert.ok(DecorationPool.despawn(wall));
  const next = DecorationPool.spawn({ x: 1, y: 1 });
  assert.equal(next, wall, 'the test needs the slot back');
  assert.equal(D.faceOct[next], 0);
});

test('spawnMany takes a face per decoration', () => {
  buildPoolScene({ decorations: 8 });
  const D = DecorationComponent;
  const out = new Int32Array(3);
  const made = DecorationPool.spawnMany({
    x: [1, 2, 3],
    y: 5,
    faceNormalX: [1, 0, 0],
    faceNormalY: [0, 1, 0],
    faceNormalZ: [0, 0, 1],
    faceHeight: [10, 20, 30],
    out,
  });
  assert.equal(made, 3);
  assert.deepEqual([...out].map((i) => D.faceOct[i]), [encodeFaceNormal(1, 0, 0), encodeFaceNormal(0, 1, 0), encodeFaceNormal(0, 0, 1)]);
  assert.deepEqual([...out].map((i) => D.faceZ[i]), [80, 160, 240]);
});
