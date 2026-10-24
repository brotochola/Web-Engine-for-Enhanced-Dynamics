import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { rewriteExplicitMeshCorners, COLLIDER_FILL_FLOATS, MESH_UV_FILL_FLOATS } from '../../src/render/colliderFillBatch.js';

// B24. A logic worker edits a mesh in place: it stores the vertices, then bumps
// that entity's vertex generation. Pixi redrew entities whose generation moved,
// and only afterwards copied the live generations as "drawn". A write landing
// between Pixi's vertex read and that copy was recorded as drawn although its
// vertices were not: the edit stayed invisible until the mesh changed again.
// Pixi now copies the generations before reading vertices and records that copy.

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const pixi = readFileSync(join(root, 'src/workers/pixiWorker.js'), 'utf8');

function vertGenMethods() {
  const start = pixi.indexOf('// vertgen-start');
  const end = pixi.indexOf('// vertgen-end');
  assert.ok(start >= 0 && end > start, 'vertex generation methods missing in pixiWorker.js');
  const Methods = new Function(`return class { ${pixi.slice(start, end)} };`)();
  return new Methods();
}

/** One entity, one triangle, explicit mesh (no index buffer). */
function views() {
  return {
    entityCount: 1,
    meshVertGen: new Uint32Array([1]),
    meshVertexX: new Float32Array([0, 10, 0]),
    meshVertexY: new Float32Array([0, 0, 10]),
    meshVertOffset: new Int32Array([0]),
    meshVertCount: new Int32Array([3]),
  };
}

function drawnX(out) {
  return [out[0], out[2], out[4]];
}

test('a write between the vertex read and the bookkeeping is drawn next frame', () => {
  const px = vertGenMethods();
  const v = views();
  const skip = { lastVertGen: new Uint32Array([0]), frameVertGen: null };
  const out = new Float32Array(COLLIDER_FILL_FLOATS);
  const instance = new Uint32Array([0]);

  // Frame 1: draw edit A.
  let genNow = px._captureVertGen(skip, v);
  assert.equal(rewriteExplicitMeshCorners(out, 1, instance, v, COLLIDER_FILL_FLOATS, skip.lastVertGen, genNow), 1);
  assert.deepEqual(drawnX(out), [0, 10, 0]);
  // Edit B lands now: vertices, then the generation.
  v.meshVertexX.set([5, 25, 5]);
  v.meshVertGen[0] = 2;
  px._commitVertGen(skip, v);

  // Frame 2: B must be redrawn.
  genNow = px._captureVertGen(skip, v);
  rewriteExplicitMeshCorners(out, 1, instance, v, COLLIDER_FILL_FLOATS, skip.lastVertGen, genNow);
  assert.deepEqual(drawnX(out), [5, 25, 5], 'edit B is on screen');
  px._commitVertGen(skip, v);

  // Frame 3: nothing new, nothing rewritten.
  out.fill(-1);
  genNow = px._captureVertGen(skip, v);
  rewriteExplicitMeshCorners(out, 1, instance, v, COLLIDER_FILL_FLOATS, skip.lastVertGen, genNow);
  assert.deepEqual(drawnX(out), [-1, -1, -1]);
});

test('the dirty check reads the captured generations, not the live ones', () => {
  const v = views();
  const out = new Float32Array(COLLIDER_FILL_FLOATS).fill(-1);
  const instance = new Uint32Array([0]);
  // Captured before a write: unchanged against last, so nothing is drawn
  // even though the live generation already moved (it is caught next frame).
  v.meshVertGen[0] = 9;
  rewriteExplicitMeshCorners(out, 1, instance, v, COLLIDER_FILL_FLOATS, new Uint32Array([1]), new Uint32Array([1]));
  assert.deepEqual(drawnX(out), [-1, -1, -1]);
});

test('Pixi captures before both vertex-reading paths and commits the capture', () => {
  const block = pixi.slice(pixi.indexOf('const vertsMoved = vertEpoch'), pixi.indexOf('copyMeshFillPoseScratch(views, skip.prevPose);'));
  const capture = block.indexOf('this._captureVertGen(skip, views)');
  const rewrite = block.indexOf('this._rewriteMeshCorners(');
  assert.ok(capture > 0, 'captured');
  assert.ok(rewrite > 0 && capture < rewrite, 'before the rewrite');
  assert.ok(capture < block.indexOf('packColliderFill('), 'before the full pack');
  // E-118: the UV generations right after the vertex ones, committed with them.
  const uvCapture = block.indexOf('this._captureUvGen(skip, views)');
  assert.ok(uvCapture > capture && uvCapture < rewrite, 'the UV generations after the vertex ones, before the rewrite');
  assert.equal((block.match(/_commitVertGen\(skip, views\)/g) || []).length, 2);
  assert.equal((block.match(/_commitUvGen\(skip, views\)/g) || []).length, 2);
  assert.ok(!/_snapshotVertGen/.test(pixi), 'no copy of the live generations after the reads');
});

/** One entity, one fan triangle with UVs (the UV batch's rows), and its skip state with UV generations. */
function uvViews() {
  return {
    ...views(),
    meshUvU: new Float32Array([0, 1, 0]),
    meshUvV: new Float32Array([0, 0, 1]),
    meshUvGen: new Uint32Array([1]),
  };
}

function uvSkip() {
  return { lastVertGen: new Uint32Array([0]), frameVertGen: null, lastUvGen: new Uint32Array(1), frameUvGen: new Uint32Array(0) };
}

function drawnU(out) {
  return [out[18], out[20], out[22]];
}

function uvFrame(px, out, instance, v, skip) {
  const genNow = px._captureVertGen(skip, v);
  const uvNow = px._captureUvGen(skip, v);
  const code = rewriteExplicitMeshCorners(out, 1, instance, v, MESH_UV_FILL_FLOATS, skip.lastVertGen, genNow, skip.lastUvGen, uvNow);
  px._commitVertGen(skip, v);
  px._commitUvGen(skip, v);
  return code;
}

test('E-118: a write whose UV bump a capture missed draws its UVs the next frame', () => {
  const px = vertGenMethods();
  const v = uvViews();
  const skip = uvSkip();
  const out = new Float32Array(MESH_UV_FILL_FLOATS);
  const instance = new Uint32Array([0]);
  assert.equal(uvFrame(px, out, instance, v, skip), 1);
  assert.deepEqual(drawnU(out), [0, 1, 0]);
  // A UV write whose vertex bump the next capture sees and whose UV bump it does not.
  v.meshUvU.set([0.5, 0.75, 0.25]);
  v.meshVertexX.set([5, 25, 5]);
  v.meshVertGen[0] = 2;
  uvFrame(px, out, instance, v, skip);
  assert.deepEqual(drawnX(out), [5, 25, 5], 'the positions are drawn');
  assert.deepEqual(drawnU(out), [0, 1, 0], 'the UVs wait for their bump');
  v.meshUvGen[0] = 2;
  // The vertex generation is the drawn one now; the UV generation alone moved: the run is rewritten.
  uvFrame(px, out, instance, v, skip);
  assert.deepEqual(drawnU(out), [0.5, 0.75, 0.25], 'the UVs are on screen');
});

test('E-118: a write whose vertex bump a capture missed is drawn whole by the two frames', () => {
  const px = vertGenMethods();
  const v = uvViews();
  const skip = uvSkip();
  const out = new Float32Array(MESH_UV_FILL_FLOATS);
  const instance = new Uint32Array([0]);
  uvFrame(px, out, instance, v, skip);
  v.meshUvU.set([0.5, 0.75, 0.25]);
  v.meshVertexX.set([5, 25, 5]);
  v.meshUvGen[0] = 2;
  // The capture sees the UV bump only: the run is rewritten from what is in the columns.
  uvFrame(px, out, instance, v, skip);
  assert.deepEqual(drawnU(out), [0.5, 0.75, 0.25]);
  v.meshVertGen[0] = 2;
  out.fill(-1);
  uvFrame(px, out, instance, v, skip);
  assert.deepEqual(drawnX(out), [5, 25, 5], 'the vertex bump rewrites the positions');
  assert.deepEqual(drawnU(out), [-1, -1, -1], 'and leaves the UVs, drawn the frame before');
});
