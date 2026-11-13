import test from 'node:test';
import assert from 'node:assert/strict';

import { packColliderFill, COLLIDER_FILL_FLOATS } from '../../src/render/colliderFillBatch.js';
import { ShapeType } from '../../src/util/configDefaults.js';

// E-277: the collider fill's bytes on a random world that takes every path (fixtures, primary polygon, box and circle,
// explicit meshes with and without indices; outsets, turned poses, offsets, alphas across 0..1, so packed colours
// outside the small-integer range), at three caps (room for all, cut short twice). The hashes were taken with the
// fill as it was before its doubles went through a module Float64Array; a change that moves a byte changes them.

let seed = 0x277;
const rnd = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let r = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
  return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
};

const N = 240;
const FX = 400;
const INV = 0xffff;
function world() {
  seed = 0x277;
  const v = {
    entityCount: N,
    meshActive: new Uint8Array(N).fill(1),
    meshVisible: new Uint8Array(N).fill(1),
    meshLayerMask: new Uint16Array(N).fill(1),
    meshTint: new Uint32Array(N),
    meshAlpha: new Float32Array(N),
    fixtureCount: new Uint16Array(N),
    fixtureHead: new Uint16Array(N).fill(INV),
    fixtureNext: new Uint16Array(FX).fill(INV),
    fixtureActive: new Uint8Array(FX),
    vertCount: new Uint8Array(FX),
    vertexX: new Float32Array(FX * 8),
    vertexY: new Float32Array(FX * 8),
    x: new Float32Array(N),
    y: new Float32Array(N),
    rotC: new Float32Array(N),
    rotS: new Float32Array(N),
    offsetX: new Float32Array(N),
    offsetY: new Float32Array(N),
    meshBits: 1,
    maxFixtures: FX,
    primaryShapeType: new Uint8Array(N).fill(255),
    primaryPolyCount: new Uint8Array(N),
    primaryPolyVertexX: new Float32Array(N * 8),
    primaryPolyVertexY: new Float32Array(N * 8),
    primaryWidth: new Float32Array(N),
    primaryHeight: new Float32Array(N),
    primaryRadius: new Float32Array(N),
    meshVisualOutset: new Float32Array(N),
    meshVertOffset: new Int32Array(N).fill(-1),
    meshVertCount: new Int32Array(N),
    meshIndexOffset: new Int32Array(N).fill(-1),
    meshIndexCount: new Int32Array(N),
    meshVertexX: new Float32Array(N * 8),
    meshVertexY: new Float32Array(N * 8),
    meshIndices: new Int32Array(N * 18),
    instanceEntity: new Int32Array(4096),
  };
  let fx = 0;
  let mv = 0;
  let mi = 0;
  for (let i = 0; i < N; i++) {
    const a = rnd() * Math.PI * 2;
    v.x[i] = (rnd() - 0.5) * 4000;
    v.y[i] = (rnd() - 0.5) * 4000;
    v.rotC[i] = Math.cos(a);
    v.rotS[i] = Math.sin(a);
    v.offsetX[i] = rnd() < 0.5 ? 0 : (rnd() - 0.5) * 40;
    v.offsetY[i] = rnd() < 0.5 ? 0 : (rnd() - 0.5) * 40;
    v.meshAlpha[i] = rnd() * 1.2 - 0.1;
    v.meshTint[i] = (rnd() * 0xffffff) >>> 0;
    v.meshVisualOutset[i] = rnd() < 0.4 ? 0 : rnd() * 12;
    const kind = i % 6;
    if (kind === 0 && fx + 3 < FX) {
      // Fixtures: one to three polygons of 3..8 vertices, one of them inactive sometimes.
      const k = 1 + ((rnd() * 3) | 0);
      let prev = -1;
      for (let f = 0; f < k; f++) {
        const n = 3 + ((rnd() * 6) | 0);
        v.fixtureActive[fx] = rnd() < 0.9 ? 1 : 0;
        v.vertCount[fx] = n;
        for (let q = 0; q < n; q++) {
          const t = (q / n) * Math.PI * 2;
          const r = 5 + rnd() * 30;
          v.vertexX[fx * 8 + q] = Math.cos(t) * r;
          v.vertexY[fx * 8 + q] = Math.sin(t) * r;
        }
        if (prev < 0) v.fixtureHead[i] = fx;
        else v.fixtureNext[prev] = fx;
        prev = fx;
        fx++;
      }
      v.fixtureCount[i] = k;
    } else if (kind === 1) {
      v.primaryShapeType[i] = ShapeType.Polygon;
      const n = 3 + ((rnd() * 6) | 0);
      v.primaryPolyCount[i] = n;
      for (let q = 0; q < n; q++) {
        const t = (q / n) * Math.PI * 2;
        v.primaryPolyVertexX[i * 8 + q] = Math.cos(t) * (4 + rnd() * 20);
        v.primaryPolyVertexY[i * 8 + q] = Math.sin(t) * (4 + rnd() * 20);
      }
    } else if (kind === 2) {
      v.primaryShapeType[i] = ShapeType.Box;
      v.primaryWidth[i] = rnd() * 80;
      v.primaryHeight[i] = rnd() * 80;
    } else if (kind === 3) {
      v.primaryShapeType[i] = ShapeType.Circle;
      v.primaryRadius[i] = rnd() * 50;
    } else {
      // An explicit mesh: a fan (kind 4) or indexed triangles (kind 5).
      const n = 3 + ((rnd() * 6) | 0);
      v.meshVertOffset[i] = mv;
      v.meshVertCount[i] = n;
      for (let q = 0; q < n; q++) {
        const t = (q / n) * Math.PI * 2;
        v.meshVertexX[mv + q] = Math.cos(t) * (6 + rnd() * 25);
        v.meshVertexY[mv + q] = Math.sin(t) * (6 + rnd() * 25);
      }
      if (kind === 5) {
        v.meshIndexOffset[i] = mi;
        v.meshIndexCount[i] = (n - 2) * 3;
        for (let q = 0; q < n - 2; q++) {
          v.meshIndices[mi + q * 3] = 0;
          v.meshIndices[mi + q * 3 + 1] = q + 1;
          v.meshIndices[mi + q * 3 + 2] = q + 2;
        }
        mi += (n - 2) * 3;
      }
      mv += n;
    }
  }
  return v;
}

const GOLDEN = [
  [4096, 941, 469208740],
  [300, 300, 3415386507],
  [37, 37, 1010612134],
];

test('the collider fill writes the bytes it wrote before E-277, on every path', () => {
  for (const [cap, wantWritten, wantHash] of GOLDEN) {
    const out = new Float32Array(cap * COLLIDER_FILL_FLOATS);
    const views = world();
    // Twice, so a scratch the first pack left is in play.
    let written = 0;
    for (let r = 0; r < 2; r++) written = packColliderFill(out, cap, 0, views);
    assert.equal(written, wantWritten, `cap ${cap}: triangles`);
    const words = new Uint32Array(out.buffer, 0, written * COLLIDER_FILL_FLOATS);
    let h = 2166136261;
    for (let k = 0; k < words.length; k++) h = Math.imul(h ^ words[k], 16777619) >>> 0;
    for (let k = 0; k < written; k++) h = Math.imul(h ^ views.instanceEntity[k], 16777619) >>> 0;
    assert.equal(h >>> 0, wantHash, `cap ${cap}: the bytes changed`);
  }
});
