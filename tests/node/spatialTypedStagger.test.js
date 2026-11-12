import test from 'node:test';
import assert from 'node:assert/strict';

import { tickBucketPhase } from '../../src/util/logicOwner.js';
import { setupSpatialKernel } from '../bench/spatialWorkerMicrobench.mjs';

// E-200: a class whose logic ticks every T frames gets its neighbour list two logic frames before a tick, at
// most every neighborTickInterval frames (every P frames, P the smallest multiple of T not under the interval).
// With no skin every refresh is a rebuild, which resets the slot's frames-since-build to 0. A slot whose list was
// empty is searched again every frame, by design (it skips nothing it has), so only slots that had neighbours
// before the frame count.

const LEAD = 2;

/** Runs `frames` kernel frames; returns, per slot, the logic frames on which its non-empty list was rebuilt. */
function rebuildFrames(k, frames) {
  const at = new Map();
  for (let f = 1; f <= frames; f++) {
    const before = k.workers.map((w) => w._candidateCountOf.slice());
    k.frame(); // logic frame f
    for (let wi = 0; wi < k.workers.length; wi++) {
      const w = k.workers[wi];
      const owned = w._ownedEntityList;
      for (let oi = 0; oi < w._ownedEntityCount; oi++) {
        const i = owned[oi];
        if (w._entityFramesSinceBuild[i] !== 0 || before[wi][i] === 0) continue;
        if (!at.has(i)) at.set(i, []);
        at.get(i).push(f);
      }
    }
  }
  return at;
}

function assertOnTickEves(k, at, { from = 2 } = {}) {
  let checked = 0;
  for (const c of k.classes) {
    const T = c.tickInterval;
    if (T <= 1) continue;
    const P = Math.ceil(k.cfg.neighborTickInterval / T) * T;
    for (let i = c.startIndex; i < c.endIndex; i++) {
      const frames = (at.get(i) || []).filter((f) => f >= from);
      for (const f of frames) {
        const p = tickBucketPhase(i, T);
        assert.equal(((f + LEAD - p) % P + P) % P, 0, `${c.name} slot ${i}: list at logic frame ${f}, not ${LEAD} before a tick of phase ${p} (period ${P})`);
        checked++;
      }
      // A list that went empty between two is searched every frame meanwhile (not counted): a multiple of P.
      for (let j = 1; j < frames.length; j++) assert.equal((frames[j] - frames[j - 1]) % P, 0, `${c.name} slot ${i}: lists ${frames[j - 1]} and ${frames[j]}`);
    }
  }
  return checked;
}

test('a class that ticks every 30 frames gets one list every 30 frames, two frames before its tick', async () => {
  const k = await setupSpatialKernel({
    n: 3000,
    workers: 1, // one owner: a row that changes owner starts from that worker's counts
    types: 'boids',
    spatial: { neighborReuseSkin: 0, neighborReuseMaxFrames: 90, neighborTickInterval: 15 },
  });
  const at = rebuildFrames(k, 120);
  const checked = assertOnTickEves(k, at);
  assert.ok(checked > 3000, `the lists were checked (${checked})`);
});

test('each class of a mixed scene gets its lists on its own tick eves, every multiple of its interval', async () => {
  const k = await setupSpatialKernel({
    n: 3000,
    workers: 1, // one owner: a row that changes owner starts from that worker's counts
    types: 'predator',
    spatial: { neighborReuseSkin: 0, neighborReuseMaxFrames: 90, neighborTickInterval: 15 },
  });
  const at = rebuildFrames(k, 120);
  assertOnTickEves(k, at);
  // A class that ticks every frame keeps the plain stagger: one list every 15 frames.
  const prop = k.classes.find((c) => c.tickInterval === 1);
  for (let i = prop.startIndex; i < prop.endIndex; i++) {
    const frames = (at.get(i) || []).filter((f) => f >= 2);
    for (let j = 1; j < frames.length; j++) assert.equal((frames[j] - frames[j - 1]) % 15, 0, `Prop slot ${i}`);
  }
});

test('without logic frames the lists keep the plain stagger', async () => {
  const k = await setupSpatialKernel({
    n: 2000,
    workers: 1, // one owner: a row that changes owner starts from that worker's counts
    spatial: { neighborReuseSkin: 0, neighborReuseMaxFrames: 90, neighborTickInterval: 15 },
  });
  const at = rebuildFrames(k, 60);
  let checked = 0;
  for (const frames of at.values()) {
    const later = frames.filter((f) => f >= 2);
    for (let j = 1; j < later.length; j++, checked++) assert.equal((later[j] - later[j - 1]) % 15, 0);
  }
  assert.ok(checked > 0);
});
