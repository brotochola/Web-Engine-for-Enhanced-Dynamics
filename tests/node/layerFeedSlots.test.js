// E-354: the layer feed lists find an index through their slot index, not a walk, and change as they did: an add
// appends (a member or a full list is left as it is), a remove moves the last entry into the slot it frees. A long
// random sequence of adds and removes over two layers keeps every list equal, entry for entry and in order, to that
// model; the index holds exactly the listed indices at their slots; a worker's binding (initializeFromBuffers) shares
// the index; a list buffer without the index is walked as before.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Layer } from '../../src/core/layer.js';
import { LAYER_DENSITY_SOURCE } from '../../src/util/configDefaults.js';
import { syncParticleFeed } from '../../src/util/layerFeed.js';
import { mulberry32 } from '../bench/microbenchHelpers.mjs';

const BUILT_IN = { decals: {}, castedShadows: {}, entities: {}, lighting: {} };
const CAP = 64;

function layers() {
  Layer.reset();
  Layer.initializeFromConfig(
    {
      oil: { shader: { fragment: 'f', densitySource: LAYER_DENSITY_SOURCE.LIQUID_FUN, maxParticles: CAP } },
      heat: { shader: { fragment: 'f', compute: 's', maxBodies: 8, maxParticles: CAP } },
    },
    BUILT_IN,
    true
  );
  return [Layer.getId('oil'), Layer.getId('heat')];
}

/** The lists as they were kept before the index: append if absent and not full, swap the last into a removed slot. */
function modelAdd(list, i) {
  if (list.includes(i) || list.length >= CAP) return;
  list.push(i);
}
function modelRemove(list, i) {
  const s = list.indexOf(i);
  if (s < 0) return;
  const last = list.pop();
  if (s < list.length) list[s] = last;
}

function listed(id) {
  return Array.from(Layer._particleFeedIndices[id].subarray(0, Layer._particleFeedCount[id]));
}

/** Every listed index is in the slot index at its slot, and the index holds nothing else. */
function checkIndex(id) {
  const table = Layer._particleFeedSlots[id];
  const list = listed(id);
  const at = new Map(list.map((i, s) => [i + 1, s]));
  let entries = 0;
  for (let e = 0; e < table.length; e += 2) {
    if (table[e] === 0) continue;
    entries++;
    assert.ok(at.has(table[e]), `index entry ${table[e] - 1} is listed`);
    assert.equal(table[e + 1], at.get(table[e]), `index entry ${table[e] - 1}: its slot`);
  }
  assert.equal(entries, list.length);
}

test('E-354: adds and removes through the slot index keep the lists the swap-remove gives, in order', () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    const [oil, heat] = layers();
    assert.ok(Layer._particleFeedSlots[oil] instanceof Int32Array, 'the density feed has its index');
    assert.ok(Layer._particleFeedSlots[heat] instanceof Int32Array, 'the compute feed has its index');
    const model = { [oil]: [], [heat]: [] };
    const masks = new Int32Array(4096);
    const rng = mulberry32(0x354);
    // Keys from a pool far larger than the table, half of them strided by its size (one home without a spread hash).
    const key = () => (rng() < 0.5 ? ((rng() * 4096) | 0) : (((rng() * 16) | 0) * 256 + 7));
    for (let op = 0; op < 20000; op++) {
      const i = key();
      const old = masks[i];
      const r = rng();
      const next = r < 0.4 ? 0 : r < 0.7 ? 1 << oil : r < 0.85 ? 1 << heat : (1 << oil) | (1 << heat);
      syncParticleFeed(i, old, next);
      for (const id of [oil, heat]) {
        const had = (old >> id) & 1;
        const has = (next >> id) & 1;
        if (had && !has) modelRemove(model[id], i);
        if (!had && has) modelAdd(model[id], i);
      }
      // As a particle's mask does: it keeps a bit a full list left it out of, and its later remove finds nothing.
      masks[i] = next;
      if (op % 97 === 0 || op > 19900) {
        for (const id of [oil, heat]) {
          assert.deepEqual(listed(id), model[id], `op ${op}: layer ${id}'s list`);
          checkIndex(id);
        }
      }
    }
    assert.ok(model[oil].length > CAP / 2, 'the lists filled up');
    // A second add of a member and a remove of a non-member change nothing.
    const member = model[oil][3];
    syncParticleFeed(member, 0, 1 << oil);
    syncParticleFeed(4095 + 1, 1 << oil, 0);
    assert.deepEqual(listed(oil), model[oil]);
    checkIndex(oil);
  } finally {
    console.warn = warn;
    Layer.reset();
  }
});

test('E-354: a worker binds the same index; a list buffer without one is walked', () => {
  try {
    const [oil] = layers();
    syncParticleFeed(5, 0, 1 << oil);
    syncParticleFeed(9, 0, 1 << oil);
    const data = Layer.getSerializableData();
    // A worker: the same buffers bound again.
    Layer.initializeFromBuffers(data);
    assert.ok(Layer._particleFeedSlots[oil] instanceof Int32Array);
    assert.equal(Layer._particleFeedIndices[oil].length, CAP);
    syncParticleFeed(5, 1 << oil, 0);
    syncParticleFeed(11, 0, 1 << oil);
    assert.deepEqual(listed(oil), [9, 11]);
    checkIndex(oil);

    // The list alone in its buffer (no index after it): the walk, the same lists.
    const bare = new SharedArrayBuffer(CAP * 4);
    const sabs = data.particleFeedIndexSABs.slice();
    sabs[oil] = bare;
    Atomics.store(Layer._particleFeedCount, oil, 0);
    Layer.initializeFromBuffers({ ...data, particleFeedIndexSABs: sabs });
    assert.equal(Layer._particleFeedSlots[oil], null);
    for (const i of [1, 2, 3, 4]) syncParticleFeed(i, 0, 1 << oil);
    syncParticleFeed(2, 1 << oil, 0);
    syncParticleFeed(3, 0, 1 << oil);
    assert.deepEqual(listed(oil), [1, 4, 3]);
  } finally {
    Layer.reset();
  }
});
