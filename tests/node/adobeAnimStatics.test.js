// E-537: an Adobe clip's methods have statics by entity index (AdobeAnimComponent.play(i, clip, loop) is
// adobeAnimComponent.play(clip, loop)), and frameCount and currentFrame read with no object made: the getters spread a
// clip object per read before. Each case runs the component's method on one entity and the static on a twin from the
// same columns and compares every column; a sampling heap profile shows what the reads allocate.
import test from 'node:test';
import assert from 'node:assert/strict';
import inspector from 'node:inspector/promises';

import { AdobeAnimComponent } from '../../src/components/adobeAnimComponent.js';
import { AdobeAnimRegistry } from '../../src/core/adobeAnimRegistry.js';

const N = 8;
const A = AdobeAnimComponent;
const f = Math.fround;

/** An asset of three clips: 10 frames at 24 fps, 1 frame at 30, 12 at 12 (a whole-second clip). */
function registerAsset() {
  AdobeAnimRegistry.clearForSceneUnload();
  const clips = 3;
  const bounds = (v) => Float32Array.from({ length: clips }, (_, k) => v * (k + 1));
  AdobeAnimRegistry.register('hero', {
    clipNames: ['walk', 'pose', 'beat'],
    clipNameToId: { walk: 0, pose: 1, beat: 2 },
    clipFrameCount: Uint16Array.of(10, 1, 12),
    clipFrameRate: Float32Array.of(24, 30, 12),
    clipBoundsMinX: bounds(-10),
    clipBoundsMinY: bounds(-20),
    clipBoundsMaxX: bounds(10),
    clipBoundsMaxY: bounds(5),
    clipBoundsHalfW: bounds(10),
    clipBoundsHalfH: bounds(12.5),
    assetBoundsMinX: -10,
    assetBoundsMinY: -20,
    assetBoundsMaxX: 10,
    assetBoundsMaxY: 5,
  });
}

function bind() {
  A.initializeArrays(new SharedArrayBuffer(A.getBufferSize(N)), N);
  registerAsset();
}

/** Every column of row i, by name. */
function rowOf(i) {
  const out = {};
  for (const key of Object.keys(A.ARRAY_SCHEMA)) out[key] = A[key][i];
  return out;
}

/** [label, component step, static step]: the same work both ways. */
const STEPS = [
  ['setAsset', (c) => c.setAsset('hero', 'walk'), (i) => A.setAsset(i, 'hero', 'walk')],
  [
    'setAsset with options',
    (c) => c.setAsset('hero', 'pose', { loop: false, playbackRate: 0.35, scaleX: 2, rotation: 0.4, alpha: 0.5, tint: 0x112233, layerMask: 6, visible: false }),
    (i) => A.setAsset(i, 'hero', 'pose', { loop: false, playbackRate: 0.35, scaleX: 2, rotation: 0.4, alpha: 0.5, tint: 0x112233, layerMask: 6, visible: false }),
  ],
  ['play', (c) => c.play('walk'), (i) => A.play(i, 'walk')],
  ['play once', (c) => c.play('beat', false), (i) => A.play(i, 'beat', false)],
  ['gotoAndStop', (c) => c.gotoAndStop(7.8), (i) => A.gotoAndStop(i, 7.8)],
  ['gotoAndPlay', (c) => c.gotoAndPlay(3), (i) => A.gotoAndPlay(i, 3)],
  ['gotoAndPlay past the end', (c) => c.gotoAndPlay(99), (i) => A.gotoAndPlay(i, 99)],
  ['gotoAndStop not a number', (c) => c.gotoAndStop(NaN), (i) => A.gotoAndStop(i, NaN)],
  ['pause', (c) => c.pause(), (i) => A.pause(i)],
  ['resume', (c) => c.resume(), (i) => A.resume(i)],
  ['play an unknown clip', (c) => c.play('nope'), (i) => A.play(i, 'nope')],
  ['setAsset of an unknown asset', (c) => c.setAsset('missing', 'walk'), (i) => A.setAsset(i, 'missing', 'walk')],
  ['gotoAndStop without a clip: no-op', (c) => c.gotoAndStop(2), (i) => A.gotoAndStop(i, 2)],
];

test('E-537: each AdobeAnimComponent static writes the columns its method writes, and reads what its getter reads', () => {
  bind();
  const a = 1;
  const b = 2;
  const clip = new A(a);
  for (const [label, viaMethod, viaStatic] of STEPS) {
    assert.equal(viaMethod(clip), clip, `${label}: the method chains`);
    assert.equal(viaStatic(b), undefined, `${label}: the static returns nothing`);
    assert.deepEqual(rowOf(b), rowOf(a), label);
    assert.equal(A.frameCount(b), clip.frameCount, `${label}: frameCount`);
    assert.equal(A.currentFrame(b), clip.currentFrame, `${label}: currentFrame`);
  }
});

test('E-537: frameCount and currentFrame as before: the clip\'s frames, the frame its time shows (looped or held)', () => {
  bind();
  const c = new A(3);
  c.setAsset('hero', 'walk');
  assert.equal(c.frameCount, 10);
  for (const [time, loop, frame] of [[0, 1, 1], [0.2, 1, 5], [0.5, 1, 2], [-0.1, 1, 8], [0.2, 0, 5], [5, 0, 10], [-3, 0, 1]]) {
    A.time[3] = time;
    A.loop[3] = loop;
    // 24 fps, 10 frames: duration 10/24 s; a looped time wraps into it, a held one stops at its ends.
    assert.equal(c.currentFrame, frame, `time ${time} loop ${loop}`);
    assert.equal(A.currentFrame(3), frame);
  }
  c.gotoAndStop(4);
  assert.equal(A.time[3], f(3 / 24));
  assert.equal(c.currentFrame, 4);
  c.play('pose');
  assert.equal(A.frameCount(3), 1);
  assert.equal(A.currentFrame(3), 1, 'one frame: always the first');
  A.assetId[4] = 0;
  assert.equal(A.frameCount(4), 0, 'no asset: no frames');
  assert.equal(A.currentFrame(4), 0);
});

/** Bytes a sampling heap profile attributes to functions of adobeAnimComponent.js while `fn` runs. */
async function bytesAllocatedIn(file, fn) {
  const session = new inspector.Session();
  session.connect();
  try {
    await session.post('HeapProfiler.enable');
    await session.post('HeapProfiler.startSampling', {
      samplingInterval: 64,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    fn();
    const { profile } = await session.post('HeapProfiler.stopSampling');
    let bytes = 0;
    const walk = (node) => {
      if (node.callFrame.url.endsWith(file)) bytes += node.selfSize;
      for (const child of node.children || []) walk(child);
    };
    walk(profile.head);
    return bytes;
  } finally {
    session.disconnect();
  }
}

test('E-537: frameCount and currentFrame make no object per read, as statics and as getters', async () => {
  bind();
  for (const i of [5, 6]) {
    A.setAsset(i, 'hero', 'walk');
    A.time[i] = 0.3;
    A.loop[i] = i === 5 ? 1 : 0;
  }
  const clip = new A(6);
  // Cold, frameCount reads ints only, so nothing it does is boxed: what is left is the clip object the old getter made
  // every read below TurboFan (the interpreter, Sparkplug; 258 KB for 2000 reads in Node 22). currentFrame computes
  // with the clip's float columns, which those tiers box at every read whatever the code; it is checked warm.
  const READS = 2000;
  let counted = 0;
  const cold = await bytesAllocatedIn('adobeAnimComponent.js', () => {
    for (let k = 0; k < READS; k++) counted += A.frameCount(5) + clip.frameCount;
  });
  assert.equal(counted, READS * 20);
  assert.ok(cold < 8 * 1024, `cold: ${cold} bytes allocated by ${2 * READS} frameCount reads`);

  // Warm (TurboFan): no read of either kind allocates. (The old getters' object was taken out here by escape analysis
  // once they were inlined; Chrome's Maglev, which runs much code before TurboFan, did not.)
  const reads = (n) => {
    let sum = 0;
    for (let k = 0; k < n; k++) sum += A.frameCount(5) + A.currentFrame(5) + clip.frameCount + clip.currentFrame;
    return sum;
  };
  for (let k = 0; k < 3000; k++) reads(10);
  await new Promise((resolve) => setTimeout(resolve, 20)); // the optimized code installed
  let sum = 0;
  const warm = await bytesAllocatedIn('adobeAnimComponent.js', () => {
    sum = reads(50_000);
  });
  assert.equal(sum, 50_000 * (10 + 8 + 10 + 8));
  assert.ok(warm < 8 * 1024, `warm: ${warm} bytes allocated by 200 000 reads`);
});
