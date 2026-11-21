// E-537: a MeshRenderer's setters and methods have statics by entity index (MeshRenderer.setTint(i, v) is
// meshRenderer.tint = v, MeshRenderer.setPlane(i, ...) is meshRenderer.setPlane(...)). Each step runs the component's
// form on one entity and the static on a twin from the same columns, and compares the mesh row, the paint and outset
// epochs and the geometry the arena holds for each.
import test from 'node:test';
import assert from 'node:assert/strict';

import { MeshRenderer, MESH_NO_TEXTURE } from '../../src/components/meshRenderer.js';
import { MeshGeometry } from '../../src/core/meshGeometry.js';

const N = 8;
const f = Math.fround;

function bind() {
  MeshRenderer.initializeArrays(new SharedArrayBuffer(MeshRenderer.getBufferSize(N)), N);
  MeshGeometry.initializeArrays(new SharedArrayBuffer(MeshGeometry.getBufferSize(4096, 8192, N)), 4096, 8192, N);
  MeshRenderer.volumeColumn = null;
}

/** Row i of every MeshRenderer column, by name. */
function rowOf(i) {
  const out = {};
  for (const key of Object.keys(MeshRenderer.ARRAY_SCHEMA)) out[key] = MeshRenderer[key][i];
  return out;
}

/** Entity e's mesh as the arena holds it: its vertices, UVs and indices (not where they sit in the arena). */
function meshOf(e) {
  const G = MeshGeometry;
  const v0 = G.vertOffset[e];
  const n = G.vertCount[e];
  const i0 = G.indexOffset[e];
  const m = G.indexCount[e];
  const xy = [];
  for (let k = 0; k < n; k++) xy.push(G.vertexX[v0 + k], G.vertexY[v0 + k], G.hasUv[e] ? G.uvU[v0 + k] : 0, G.hasUv[e] ? G.uvV[v0 + k] : 0);
  return { n, m, hasUv: G.hasUv[e], xy, indices: m > 0 ? [...G.indices.subarray(i0, i0 + m)] : [] };
}

/** [label, component step, static step]. */
const STEPS = [
  ['tint', (c) => (c.tint = 0x336699), (i) => MeshRenderer.setTint(i, 0x336699)],
  ['tint again', (c) => (c.tint = 0x336699), (i) => MeshRenderer.setTint(i, 0x336699)],
  ['alpha', (c) => (c.alpha = 0.3), (i) => MeshRenderer.setAlpha(i, 0.3)],
  ['alpha above 1', (c) => (c.alpha = 7), (i) => MeshRenderer.setAlpha(i, 7)],
  ['alpha a tiny negative', (c) => (c.alpha = -1e-50), (i) => MeshRenderer.setAlpha(i, -1e-50)],
  ['alpha not a number', (c) => (c.alpha = 'x'), (i) => MeshRenderer.setAlpha(i, 'x')],
  ['textureId', (c) => (c.textureId = 0x10005), (i) => MeshRenderer.setTextureId(i, 0x10005)],
  ['setTexture none', (c) => c.setTexture(null), (i) => MeshRenderer.setTexture(i, null)],
  ['tileMode', (c) => (c.tileMode = 258), (i) => MeshRenderer.setTileMode(i, 258)],
  ['repeatX', (c) => (c.repeatX = 70000), (i) => MeshRenderer.setRepeatX(i, 70000)],
  ['repeatY', (c) => (c.repeatY = -4), (i) => MeshRenderer.setRepeatY(i, -4)],
  ['repeatY 33', (c) => (c.repeatY = 33.9), (i) => MeshRenderer.setRepeatY(i, 33.9)],
  ['tileOffsetU', (c) => (c.tileOffsetU = 1.25), (i) => MeshRenderer.setTileOffsetU(i, 1.25)],
  ['tileOffsetV', (c) => (c.tileOffsetV = -0.3), (i) => MeshRenderer.setTileOffsetV(i, -0.3)],
  ['visualOutset', (c) => (c.visualOutset = 2.5), (i) => MeshRenderer.setVisualOutset(i, 2.5)],
  ['visualOutset negative', (c) => (c.visualOutset = -3), (i) => MeshRenderer.setVisualOutset(i, -3)],
  ['setPlane', (c) => c.setPlane(40.5, 20.25, 3, 2), (i) => MeshRenderer.setPlane(i, 40.5, 20.25, 3, 2)],
  ['setVertices', (c) => c.setVertices(new Float32Array(24).map((_, k) => k * 1.5)), (i) => MeshRenderer.setVertices(i, new Float32Array(24).map((_, k) => k * 1.5))],
  ['setHeights', (c) => c.setHeights(new Float32Array(12).fill(3)), (i) => MeshRenderer.setHeights(i, new Float32Array(12).fill(3))],
  ['setRope', (c) => c.setRope([0, 0, 10, 5, 30, -2.5, 44, 1], 3.3), (i) => MeshRenderer.setRope(i, [0, 0, 10, 5, 30, -2.5, 44, 1], 3.3)],
  ['setRope of points', (c) => c.setRope([{ x: 1, y: 2 }, { x: 9, y: 9 }], 1.1), (i) => MeshRenderer.setRope(i, [{ x: 1, y: 2 }, { x: 9, y: 9 }], 1.1)],
  ['setRope no width: no-op', (c) => c.setRope([0, 0, 1, 1], 0), (i) => MeshRenderer.setRope(i, [0, 0, 1, 1], 0)],
  ['setPolygon', (c) => c.setPolygon([0, 0, 20, 0, 25, 10, 10, 18, -4, 9]), (i) => MeshRenderer.setPolygon(i, [0, 0, 20, 0, 25, 10, 10, 18, -4, 9])],
  ['setMesh', (c) => c.setMesh([0, 0, 5, 0, 5, 5], null, [0, 0, 1, 0, 1, 1]), (i) => MeshRenderer.setMesh(i, [0, 0, 5, 0, 5, 5], null, [0, 0, 1, 0, 1, 1])],
  ['setPlane not finite: no-op', (c) => c.setPlane(Infinity, 3, 1, 1), (i) => MeshRenderer.setPlane(i, Infinity, 3, 1, 1)],
  ['clearMesh', (c) => c.clearMesh(), (i) => MeshRenderer.clearMesh(i)],
];

test('E-537: each MeshRenderer static writes the row, the epochs and the mesh its component form writes', () => {
  bind();
  const a = 2;
  const b = 5;
  MeshRenderer.renderDirty.fill(0);
  const mesh = new MeshRenderer(a);
  for (const [label, viaComponent, viaStatic] of STEPS) {
    const paint = MeshRenderer.paintEpoch[0];
    const outset = MeshRenderer.outsetEpoch[0];
    const result = viaComponent(mesh);
    if (typeof result === 'object' && result !== null && !(typeof result === 'number')) assert.equal(result, mesh, `${label}: chains`);
    const paintSteps = MeshRenderer.paintEpoch[0] - paint;
    const outsetSteps = MeshRenderer.outsetEpoch[0] - outset;
    assert.equal(viaStatic(b), undefined, `${label}: a static returns nothing`);
    assert.deepEqual(rowOf(b), rowOf(a), label);
    assert.equal(MeshRenderer.paintEpoch[0] - paint, 2 * paintSteps, `${label}: the paint epoch moved alike`);
    assert.equal(MeshRenderer.outsetEpoch[0] - outset, 2 * outsetSteps, `${label}: the outset epoch moved alike`);
    assert.deepEqual(meshOf(b), meshOf(a), `${label}: the mesh`);
    MeshRenderer.renderDirty[a] = 0;
    MeshRenderer.renderDirty[b] = 0;
  }
  assert.ok(Number.isNaN(MeshRenderer.alpha[b]), 'not a number, kept as the component kept it');
  MeshRenderer.setAlpha(b, 0.5);
  MeshRenderer.setAlpha(b, -1e-50);
  assert.ok(Object.is(MeshRenderer.alpha[b], 0), 'a tiny negative alpha is clamped to 0 before the column rounds it to -0');
  assert.equal(MeshRenderer.textureId[b], MESH_NO_TEXTURE);
  assert.equal(MeshRenderer.repeatY[b], 33);
  assert.equal(MeshRenderer.visualOutset[b], 0);
  assert.equal(MeshGeometry.vertCount[b], 0, 'cleared');
});

test('E-537: a static leaves alone the mesh a ShadowCaster\'s volume holds, as the component\'s method does', () => {
  bind();
  MeshRenderer.volumeColumn = new Float32Array(N);
  MeshRenderer.volumeColumn[3] = 0.5;
  const warn = console.warn;
  const warned = [];
  console.warn = (...args) => warned.push(args.join(' '));
  try {
    MeshRenderer.setPlane(3, 10, 10, 1, 1);
    MeshRenderer.setPolygon(3, [0, 0, 1, 0, 0, 1]);
    MeshRenderer.clearMesh(3);
  } finally {
    console.warn = warn;
    MeshRenderer.volumeColumn = null;
  }
  assert.equal(MeshGeometry.vertCount[3], 0);
  assert.ok(warned.length <= 1);
  MeshRenderer.setPlane(4, 10, 10, 1, 1);
  assert.equal(MeshGeometry.vertCount[4], 4);
  assert.deepEqual([MeshGeometry.vertexX[MeshGeometry.vertOffset[4] + 3], MeshGeometry.vertexY[MeshGeometry.vertOffset[4] + 3]], [f(5), f(5)]);
});
