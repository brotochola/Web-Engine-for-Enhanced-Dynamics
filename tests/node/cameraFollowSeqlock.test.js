import test from 'node:test';
import assert from 'node:assert/strict';

import { Camera } from '../../src/core/camera.js';
import { RigidBody } from '../../src/components/rigidBody.js';

// B18. Pre-render builds the drawn camera from the follow snapshot, which a
// seqlock guards. Two holes: zoom was read outside the snapshot (once to pack,
// once to center), and clearFollowTarget wrote NaN into the follow target
// outside the lock while the entity stamp was still set. Each test injects the
// other thread at the exact point between two reads or two writes.

const W = 1280;
const H = 720;
const N = 4;

function boot() {
  const data = new Float32Array(new SharedArrayBuffer(Camera.FLOAT_COUNT * 4));
  Camera.initialize(data, W, H);
  Camera.setWorldBounds(Infinity, Infinity);
  data[0] = 1;
  data[5] = 1;
  RigidBody.active = new Uint8Array(N);
  RigidBody.active[0] = 1;
  return data;
}

/** One logic frame: publish pose generation `f`, then followEntity on it. */
function followFrame(f, x, y) {
  const poseX = new Float32Array(N);
  const poseY = new Float32Array(N);
  poseX[0] = x;
  poseY[0] = y;
  Camera.bindDisplayPose(poseX, poseY, null, null, f);
  Camera.followEntity(0, 0, 0.1, 1);
  return { poseX, poseY };
}

const cam = () => ({ zoom: 0, x: 0, y: 0, rotation: 0 });

test('clearFollowTarget never shows the drawn camera a NaN target', () => {
  const data = boot();
  let pose;
  for (let f = 1; f <= 5; f++) pose = followFrame(f, 1000 + f * 10, 500);
  Camera.resolveDrawnCamera(pose.poseX, pose.poseY, cam());

  // Pre-render reads at the moment the stamp is being cleared.
  const seen = [];
  const orig = Camera._clearFollowEntityStamp;
  Camera._clearFollowEntityStamp = function () {
    seen.push(Camera.resolveDrawnCamera(pose.poseX, pose.poseY, cam()));
    orig.call(this);
    seen.push(Camera.resolveDrawnCamera(pose.poseX, pose.poseY, cam()));
  };
  try {
    Camera.clearFollowTarget();
  } finally {
    Camera._clearFollowEntityStamp = orig;
  }
  assert.ok(seen.length >= 1);
  for (const c of seen) {
    assert.ok(Number.isFinite(c.x) && Number.isFinite(c.y), `drawn camera ${c.x}, ${c.y}`);
  }
  assert.ok(Number.isNaN(data[3]) && Number.isNaN(data[4]), 'the target is still cleared');
  assert.equal(data[6], 0, 'and the stamp');
});

test('the drawn camera packs the zoom it centered with', () => {
  const data = boot();
  let pose;
  for (let f = 1; f <= 5; f++) pose = followFrame(f, 2000, 900);

  // Logic's follow write lands right after pre-render took the snapshot.
  const orig = Camera._readFollowSnapshot;
  Camera._readFollowSnapshot = function () {
    const snap = orig.call(this);
    data[0] = 0.8;
    return snap;
  };
  let out;
  try {
    out = Camera.resolveDrawnCamera(pose.poseX, pose.poseY, cam());
  } finally {
    Camera._readFollowSnapshot = orig;
  }
  const centerX = out.x + W / (2 * out.zoom);
  const centerY = out.y + H / (2 * out.zoom);
  assert.ok(Math.abs(centerX - 2000) < 1e-3, `view center x ${centerX} (zoom ${out.zoom})`);
  assert.ok(Math.abs(centerY - 900) < 1e-3, `view center y ${centerY}`);
});

test('a Camera.follow view keeps x/y and zoom from one write', () => {
  const data = boot();
  data[1] = 100;
  data[2] = 50;
  Camera.follow(800, 400, 0.1, 1);
  const before = { x: data[1], y: data[2], zoom: data[0] };
  const orig = Camera._readFollowSnapshot;
  Camera._readFollowSnapshot = function () {
    const snap = orig.call(this);
    data[0] = 0.5; // a later write
    data[1] = -999;
    return snap;
  };
  let out;
  try {
    out = Camera.resolveDrawnCamera(null, null, cam());
  } finally {
    Camera._readFollowSnapshot = orig;
  }
  assert.equal(out.zoom, before.zoom);
  assert.equal(out.x, before.x);
  assert.equal(out.y, before.y);
});

test('camera writes hold the lock, and nested ones keep its parity', () => {
  const data = boot();
  const seq = Camera._followSeq;
  assert.ok(seq, 'SAB camera binds the seqlock');
  const parity = [];
  const orig = Camera._clampToWorldBounds;
  Camera._clampToWorldBounds = function () {
    parity.push(Atomics.load(seq, 0) & 1);
    orig.call(this);
  };
  const s0 = Atomics.load(seq, 0);
  try {
    Camera.setZoom(1.5); // zoom setter inside setZoom
    Camera.setPosition(10, 20);
    Camera.centerOn(400, 300);
    Camera.x = 5;
    Camera.y = 6;
  } finally {
    Camera._clampToWorldBounds = orig;
  }
  assert.deepEqual(parity, [1, 1, 1, 1, 1], 'every clamp ran inside the lock');
  const s1 = Atomics.load(seq, 0);
  assert.equal(s1 & 1, 0, 'lock released');
  assert.ok(s1 > s0);
  assert.equal(data[0], 1.5);
});

test('free-cam zoom toward the pointer writes inside the lock', () => {
  const data = boot();
  const seq = Camera._followSeq;
  data[5] = 2; // targetZoom: zooming
  Camera._freeZoomAnchorX = 300;
  Camera._freeZoomAnchorY = 200;
  Camera._freeFollowX = 640;
  Camera._freeFollowY = 360;
  const parity = [];
  const orig = Camera._clearFollowEntityStamp;
  Camera._clearFollowEntityStamp = function () {
    parity.push(Atomics.load(seq, 0) & 1);
    orig.call(this);
  };
  try {
    Camera._zoomFreeTowardPointer(1, data[0]);
  } finally {
    Camera._clearFollowEntityStamp = orig;
    Camera._freeZoomAnchorX = null;
    Camera._freeZoomAnchorY = null;
  }
  assert.deepEqual(parity, [1]);
  assert.equal(Atomics.load(seq, 0) & 1, 0);
  assert.ok(data[0] > 1, 'zoom moved toward the target');
});

test('a load that lands during another thread\'s camera write leaves the lock usable', async () => {
  const { applyCameraGlobals, readCameraGlobals } = await import('../../src/core/save/entitySaveSnapshot.js');
  const data = boot();
  data[1] = 10;
  const saved = readCameraGlobals();
  saved[1] = 777;
  saved[2] = 333;
  const seq = Camera._followSeq;

  Atomics.add(seq, 0, 1); // logic is inside followEntity on its own thread
  applyCameraGlobals(saved); // main applies the save
  Atomics.add(seq, 0, 1); // logic's write ends

  assert.equal(Atomics.load(seq, 0) & 1, 0, 'the lock is even again');
  const out = Camera.resolveDrawnCamera(null, null, cam());
  assert.equal(out.x, 777, 'readers take fresh values, not the fallback');
  assert.equal(out.y, 333);
});
