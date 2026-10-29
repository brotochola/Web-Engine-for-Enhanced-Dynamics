// E-161: emitGpu calls a few ms apart on one ring share a group, so a call per entity per tick does not spend a
// group each (a ring keeps 2 048). A joined group is the calls' records back to back, the union of their bounds, the
// earliest birth and the latest end; what each call writes is what it would write on its own. A call opens its own
// group past the join window, on another epoch, with other flags, in a sorted layer on another row, in a sorted
// look layer, when the last group is near its end, or when the group would outgrow the ring.
import test from 'node:test';
import assert from 'node:assert/strict';

import { GpuParticles, GPU_GROUP_JOIN_MS } from '../../src/core/gpuParticles.js';
import { Layer } from '../../src/core/layer.js';
import { ParticleEmitter } from '../../src/core/particleEmitter.js';
import { CLOCK_BYTES, Time } from '../../src/core/timeScale.js';
import { LAYER_KIND } from '../../src/util/configDefaults.js';
import { seededRandom } from '../../src/util/utils.js';
import { GPU_GROUP, GPU_GROUP_WORDS, GPU_REC, GPU_RECORD_FLOATS, GPU_RING } from '../../src/util/gpuParticleLayout.js';

const BUILT_INS = { decals: {}, castedShadows: {}, entities: {}, lighting: {} };

function setup(layer = {}) {
  const layers = { smoke: { kind: LAYER_KIND.GPU_PARTICLES, maxParticles: 4096, ...layer } };
  Layer.reset();
  Layer.initializeFromConfig(layers, BUILT_INS);
  GpuParticles.initializeFromConfig(layers, 1);
  GpuParticles.writerSlot = 0;
  const clock = new SharedArrayBuffer(CLOCK_BYTES);
  new Float32Array(clock, 0, 1)[0] = 1;
  Time.bind(clock);
  globalThis.rng = seededRandom(4242, 'join');
  Time._advanceSimNow(1000);
  return () => {
    GpuParticles.reset();
    Layer.reset();
    Time.unbind();
  };
}

const ring = () => GpuParticles.layerOf('smoke').rings[0];
const groups = () => Atomics.load(ring().header, GPU_RING.GROUPS) >>> 0;
const row = (g) => {
  const r = ring();
  const b = g * GPU_GROUP_WORDS;
  return {
    first: r.groupBits[b + GPU_GROUP.FIRST],
    count: r.groupBits[b + GPU_GROUP.COUNT],
    birth: r.groups[b + GPU_GROUP.BIRTH_F],
    end: r.groups[b + GPU_GROUP.END_F],
    sortY: r.groups[b + GPU_GROUP.SORT_Y_F],
    box: [r.groups[b + GPU_GROUP.MIN_X_F], r.groups[b + GPU_GROUP.MIN_Y_F], r.groups[b + GPU_GROUP.MAX_X_F], r.groups[b + GPU_GROUP.MAX_Y_F]],
  };
};

const A = { layer: 'smoke', count: 5, x: { min: 0, max: 10 }, y: 0, angleXY: { min: 0, max: 360 }, speed: 1, lifespan: 500 };
const B = { layer: 'smoke', count: 3, x: 500, y: 300, vx: -2, vy: 1, lifespan: 900, delay: 100, scale: 2 };

/** A then B, `gapMs` apart; the ring's records and group rows after. */
function emitPair(gapMs, layer) {
  const restore = setup(layer);
  try {
    ParticleEmitter.emitGpu(A);
    Time._advanceSimNow(gapMs);
    ParticleEmitter.emitGpu(B);
    const r = ring();
    return {
      groups: groups(),
      published: Atomics.load(r.header, GPU_RING.PUBLISHED) >>> 0,
      rows: [row(0), row(1)],
      records: Float32Array.from(r.records.subarray(0, 8 * GPU_RECORD_FLOATS)),
    };
  } finally {
    restore();
  }
}

test('calls a few ms apart share a group: their records, the union of their bounds, the earliest birth and latest end', { concurrency: false }, () => {
  const joined = emitPair(2);
  const apart = emitPair(GPU_GROUP_JOIN_MS + 40);
  assert.equal(apart.groups, 2, 'past the window, a group each');
  assert.equal(joined.groups, 1, 'within it, one group');
  assert.equal(joined.published, 8);
  const g = joined.rows[0];
  const [a, b] = apart.rows;
  assert.equal(g.first, 0);
  assert.equal(g.count, a.count + b.count);
  assert.deepEqual(g.box, [Math.min(a.box[0], b.box[0]), Math.min(a.box[1], b.box[1]), Math.max(a.box[2], b.box[2]), Math.max(a.box[3], b.box[3])]);
  assert.equal(g.birth, 0, "A's birth, the earliest");
  assert.equal(g.end, 2 + 100 + 900, "B's end: 2 ms later, a 100 ms delay, 900 ms of life");
  assert.equal(g.sortY, a.sortY, 'the group keeps its first sortY');
  // Each call wrote what it writes alone; only B's births moved with the gap.
  const shift = apart.rows[1].birth - (2 + 100);
  for (let k = 0; k < 8; k++) {
    for (let f = 0; f < GPU_RECORD_FLOATS; f++) {
      const i = k * GPU_RECORD_FLOATS + f;
      if (f === GPU_REC.BIRTH && k >= 5) assert.equal(apart.records[i] - joined.records[i], shift, `record ${k} birth`);
      else assert.equal(joined.records[i], apart.records[i], `record ${k} field ${f}`);
    }
  }
});

test('a call opens its own group on another epoch, with other flags, near the last group\'s end, or past the ring', { concurrency: false }, () => {
  const restore = setup({ maxParticles: 64 * 3 });
  try {
    ParticleEmitter.emitGpu({ layer: 'smoke', count: 4, x: 0, y: 0, lifespan: 1000 });
    ParticleEmitter.emitGpu({ layer: 'smoke', count: 4, x: 0, y: 0, lifespan: 1000, heighted: true });
    assert.equal(groups(), 2, 'heighted and flat do not share a group');
    ParticleEmitter.emitGpu({ layer: 'smoke', count: 4, x: 0, y: 0, lifespan: 1000, heighted: true });
    assert.equal(groups(), 2, 'the same flags do');
    assert.equal(row(1).count, 8);
    ParticleEmitter.emitGpu({ layer: 'smoke', count: 60, x: 0, y: 0, lifespan: 1000, heighted: true });
    assert.equal(groups(), 3, 'a group never holds more than its ring');
    Time._advanceSimNow(GPU_GROUP_JOIN_MS + 1);
    ParticleEmitter.emitGpu({ layer: 'smoke', count: 2, x: 0, y: 0, lifespan: 50 });
    ParticleEmitter.emitGpu({ layer: 'smoke', count: 2, x: 0, y: 0, lifespan: 1000 });
    assert.equal(groups(), 5, 'a group about to end takes no more calls (a reader may already have passed it)');
    // A quiet ring moves its epoch on the next call; that call cannot join a group of the old epoch.
    Time._advanceSimNow(120000);
    ParticleEmitter.emitGpu({ layer: 'smoke', count: 2, x: 0, y: 0, lifespan: 1000 });
    assert.equal(groups(), 6);
  } finally {
    restore();
  }
});

test('a sorted layer joins only calls on the same row; a sorted look layer never joins', { concurrency: false }, () => {
  let restore = setup({ sortWithEntities: true });
  try {
    ParticleEmitter.emitGpu({ layer: 'smoke', count: 3, x: 0, y: 0, lifespan: 1000, sortY: 100.2 });
    ParticleEmitter.emitGpu({ layer: 'smoke', count: 3, x: 50, y: 0, lifespan: 1000, sortY: 99.8 });
    assert.equal(groups(), 1, 'both round to row 100: the same key, the same place among the entities');
    ParticleEmitter.emitGpu({ layer: 'smoke', count: 3, x: 0, y: 0, lifespan: 1000, sortY: 101 });
    assert.equal(groups(), 2, 'another row is another key');
  } finally {
    restore();
  }
  restore = setup({ sortWithEntities: true, shader: { fragment: 'look' } });
  try {
    ParticleEmitter.emitGpu({ layer: 'smoke', count: 3, x: 0, y: 0, lifespan: 1000, sortY: 100 });
    ParticleEmitter.emitGpu({ layer: 'smoke', count: 3, x: 0, y: 0, lifespan: 1000, sortY: 100 });
    assert.equal(groups(), 2, 'a look region is its groups\' rectangle: a joined group would sample what lies between');
  } finally {
    restore();
  }
});

test('a joined group widens before its count grows, and its records are published after both', { concurrency: false }, () => {
  const restore = setup();
  try {
    ParticleEmitter.emitGpu({ layer: 'smoke', count: 2, x: 0, y: 0, lifespan: 1000 });
    const r = ring();
    // A reader that sees the new published count sees the group's new end and bounds with it: the writer stores
    // them first. Record the order of the stores on the group row and the header.
    const order = [];
    const watch = (arr, label, idx) =>
      new Proxy(arr, {
        set(t, k, v) {
          if (idx.includes(Number(k))) order.push(label + k);
          t[k] = v;
          return true;
        },
      });
    const bits = r.groupBits;
    const floats = r.groups;
    r.groupBits = watch(bits, 'u', [GPU_GROUP.COUNT]);
    r.groups = watch(floats, 'f', [GPU_GROUP.END_F, GPU_GROUP.MAX_X_F]);
    const store = Atomics.store;
    Atomics.store = (a, i, v) => {
      if (a === r.header && i === GPU_RING.PUBLISHED) order.push('published');
      return store(a, i, v);
    };
    try {
      ParticleEmitter.emitGpu({ layer: 'smoke', count: 2, x: 900, y: 0, lifespan: 2000 });
    } finally {
      Atomics.store = store;
      r.groupBits = bits;
      r.groups = floats;
    }
    assert.equal(groups(), 1);
    assert.deepEqual(order, [`f${GPU_GROUP.END_F}`, `f${GPU_GROUP.MAX_X_F}`, `u${GPU_GROUP.COUNT}`, 'published']);
  } finally {
    restore();
  }
});
