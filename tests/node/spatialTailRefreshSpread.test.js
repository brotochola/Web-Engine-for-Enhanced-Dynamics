import test from 'node:test';
import assert from 'node:assert/strict';

import { tickBucketPhase } from '../../src/util/logicOwner.js';
import { SPATIAL_DEFAULTS } from '../../src/util/configDefaults.js';
import { setupSpatialKernel } from '../bench/spatialWorkerMicrobench.mjs';

// E-476 (spatial.neighborRefreshSpread): a typed class's list may come before any of the P / T ticks a refresh period
// holds. 'none' (the default) takes the first for every slot, so Predator's civilians (T 4, P 16) refresh on 4 frames
// of 16; 'idBlocks' spreads the class over the period by blocks of its slots, and rebuilds a list that skin reuse kept
// past neighborReuseMaxFrames on its own refresh frame, not on the frame it reaches the cap. Either way each list still
// comes TYPED_NEIGHBOR_LEAD logic frames before a tick of its slot. With no skin every refresh is a rebuild, which resets
// the slot's frames-since-build to 0; a slot whose list was empty is searched every frame by design, so only slots that
// had neighbours before the frame count (as in spatialTypedStagger.test.js).

const LEAD = 2;
const TICK = 15;

async function kernel(spread, { still = false, skin = 0, maxFrames = 90 } = {}) {
  return setupSpatialKernel({
    n: 6000,
    workers: 1, // one owner: a row that changes owner starts from that worker's counts
    types: 'predator',
    still,
    spatial: { neighborReuseSkin: skin, neighborReuseMaxFrames: maxFrames, neighborTickInterval: TICK, neighborRefreshSpread: spread },
  });
}

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

/** Every typed list came LEAD frames before a tick of its slot (and, with `period`, the lists of a slot P apart). */
function assertOnTickEves(k, at, { from = 2, period = true } = {}) {
  let checked = 0;
  for (const c of k.classes) {
    const T = c.tickInterval;
    if (T <= 1) continue;
    const P = Math.ceil(TICK / T) * T;
    for (let i = c.startIndex; i < c.endIndex; i++) {
      const frames = (at.get(i) || []).filter((f) => f >= from);
      for (const f of frames) {
        const p = tickBucketPhase(i, T);
        assert.equal(((f + LEAD - p) % T + T) % T, 0, `${c.name} slot ${i}: list at logic frame ${f}, not ${LEAD} before a tick of phase ${p}`);
        checked++;
      }
      if (!period) continue;
      for (let j = 1; j < frames.length; j++) assert.equal((frames[j] - frames[j - 1]) % P, 0, `${c.name} slot ${i}: lists ${frames[j - 1]} and ${frames[j]}`);
    }
  }
  return checked;
}

/** Civilians' (T 4, P 16) refreshes on each logic frame of [from, to). */
function civilianRefreshes(k, at, from, to) {
  const c = k.classes.find((x) => x.name === 'Civilian');
  const per = new Array(to - from).fill(0);
  for (let i = c.startIndex; i < c.endIndex; i++) {
    for (const f of at.get(i) || []) if (f >= from && f < to) per[f - from]++;
  }
  return per;
}

const stats = (a) => {
  const mean = a.reduce((s, v) => s + v, 0) / a.length;
  return { mean, min: Math.min(...a), max: Math.max(...a), zeros: a.filter((v) => v === 0).length };
};

test("neighborRefreshSpread defaults to 'none': a class's refresh lands on T frames of every period", async () => {
  assert.equal(SPATIAL_DEFAULTS.neighborRefreshSpread, 'none');
  const k = await kernel(undefined);
  const at = rebuildFrames(k, 100);
  assertOnTickEves(k, at);
  const s = stats(civilianRefreshes(k, at, 20, 84)); // four periods of 16
  assert.equal(s.zeros, 48, `12 frames of every 16 refresh no civilian (${JSON.stringify(s)})`);
});

test("'idBlocks' refreshes each class on every frame of its period, each list still two frames before a tick", async () => {
  const k = await kernel('idBlocks');
  const at = rebuildFrames(k, 100);
  const checked = assertOnTickEves(k, at);
  assert.ok(checked > 3000, `the lists were checked (${checked})`);
  const s = stats(civilianRefreshes(k, at, 20, 84));
  assert.equal(s.zeros, 0, `a civilian list on every frame (${JSON.stringify(s)})`);
  assert.ok(s.max <= 2 * s.mean, `no frame takes twice its share (${JSON.stringify(s)})`);
});

test("'idBlocks' rebuilds a list kept past the reuse cap on its own refresh frame: no cycle of cap + 1 frames", async () => {
  // Nobody moves and skin reuse is on (Predator's 0.01 and 30 frames): a list is kept on its refresh frames until the cap.
  // Every list is built on the first frame, so without a spread they all reach the cap on the same frame, every 31.
  const opts = { still: true, skin: 0.01, maxFrames: 30 };
  const none = await kernel('none', opts);
  const sNone = stats(civilianRefreshes(none, rebuildFrames(none, 140), 40, 133)); // three cycles of 31
  assert.ok(sNone.zeros >= 80, `without a spread the civilians' lists come on a few frames (${JSON.stringify(sNone)})`);
  const k = await kernel('idBlocks', opts);
  assert.equal(k.workers[0]._scheduleReuseCap, 30 + 30, 'the cap plus the longest period (the boids\' 30)');
  const at = rebuildFrames(k, 140);
  assert.ok(assertOnTickEves(k, at, { period: false }) > 1000, 'each rebuild on a tick eve of its slot');
  // A kept list is rebuilt every other refresh (32 frames for a civilian), on its tick eve: the class's rebuilds on half
  // the frames of every 32 (the half its first rebuild after the start picked), not on one frame of every 31.
  const s = stats(civilianRefreshes(k, at, 40, 133));
  assert.ok(s.zeros <= 50, `civilian lists on half the frames or more (${JSON.stringify(s)})`);
  assert.ok(s.max * 4 < sNone.max, `the heaviest frame a quarter of the cycle's or less (${s.max} against ${sNone.max})`);
  // A list stands at most the cap plus a period.
  const w = k.workers[0];
  for (let i = 0; i < k.n; i++) assert.ok(w._entityFramesSinceBuild[i] < 30 + 30, `slot ${i}`);
});

test('an unknown neighborRefreshSpread is named once and not spread', async () => {
  const warned = [];
  const warn = console.warn;
  console.warn = (m) => warned.push(String(m));
  let k;
  try {
    k = await kernel('rows');
  } finally {
    console.warn = warn;
  }
  assert.equal(warned.filter((m) => m.includes('spatial.neighborRefreshSpread')).length, 1);
  assert.equal(k.workers[0]._neighborRefreshSpread, 0);
});
