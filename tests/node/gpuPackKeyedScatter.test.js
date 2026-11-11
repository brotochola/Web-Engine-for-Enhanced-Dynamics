import test from 'node:test';
import assert from 'node:assert/strict';

import { GPU_SPACE_WORLD, makePackContext } from '../../src/render/gpuQueueLayout.js';
import * as client from '../../src/render/gpuPackClient.js';
import { setup } from '../bench/gpuPackKeyedMicrobench.mjs';

// E-193: the keyed pack through the inverse of the painter's list (pack_sprites_keyed_scatter) writes what the gather
// (pack_sprites_keyed) writes: the pose and slot streams, the shadow terms, the particle and update counts, and the same
// updates (in queue order instead of draw order: compared as a set by key).

const ROWS = 6000;
const ENTITIES = 15000;
const WORDS = 16;

function packOnce(s, b, { shadow }) {
  const ctx = makePackContext(s.q, { space: GPU_SPACE_WORLD, indices: s.order, indexCount: ROWS, type: s.q.type }, ROWS, {});
  const keyed = {
    tableByte: s.keyTable.byteOffset, stampByte: s.stamps.byteOffset, keyBase: ENTITIES, epoch: 1,
    updatesByte: s.updates.byteOffset, updates: 0, shadowByte: shadow ? s.shadow.byteOffset : 0,
  };
  s.pose.fill(-1);
  s.slots.fill(-1);
  s.shadow.fill(-1);
  s.updates.fill(0xdeadbeef);
  const n = client.packKeyedRowsWasm(b, s.q, ctx, s.pose, s.slots, keyed, ROWS);
  const ups = [];
  for (let u = 0; u < keyed.updates; u++) ups.push(Array.from(s.updates.subarray(u * WORDS, u * WORDS + WORDS)));
  ups.sort((a, c) => a[12] - c[12]);
  return {
    n,
    particles: ctx.particleCount,
    updates: keyed.updates,
    pose: s.pose.slice(),
    slots: s.slots.slice(),
    shadow: s.shadow.slice(),
    ups,
  };
}

async function scene(order) {
  const s = await setup(ROWS, ENTITIES, order);
  // Changed statics on some sprite rows, glow and particle rows, and shadow terms, so every branch of the row runs.
  for (let i = 0; i < ROWS; i++) {
    if (i % 7 === 0 && s.q.key[i] !== 0xffffffff) s.q.key[i] |= 0x80000000;
    if (i % 11 === 0) s.q.type[i] = 1;
    if (i % 13 === 0) s.q.type[i] = 3;
    s.q.shadowH[i] = (i % 5) * 3.5;
    s.q.shadowOffX[i] = i % 3;
    s.q.shadowOffY[i] = -(i % 4);
  }
  return s;
}

for (const order of ['random', 'near']) {
  for (const shadow of [false, true]) {
    test(`the keyed pack through the inverse writes the gather's frame (${order} order${shadow ? ', with shadow terms' : ''})`, async () => {
      const s = await scene(order);
      assert.ok(s.b.spritesKeyedScatter, 'the engine has pack_sprites_keyed_scatter');
      const gather = packOnce(s, { ...s.b, keyedInverseByte: 0 }, { shadow });
      const scatter = packOnce(s, s.b, { shadow });
      assert.equal(scatter.n, ROWS);
      assert.equal(scatter.n, gather.n);
      assert.equal(scatter.particles, gather.particles);
      assert.equal(scatter.updates, gather.updates);
      assert.ok(gather.updates > ROWS / 10, `rows send their statics (${gather.updates})`);
      assert.deepEqual(scatter.pose, gather.pose);
      assert.deepEqual(scatter.slots, gather.slots);
      if (shadow) assert.deepEqual(scatter.shadow, gather.shadow);
      assert.deepEqual(scatter.ups, gather.ups);
    });
  }
}

test('a painter list with a repeated row goes back to the gather, with the same frame', async () => {
  const s = await scene('random');
  s.order[5] = s.order[6];
  const gather = packOnce(s, { ...s.b, keyedInverseByte: 0 }, { shadow: false });
  const scatter = packOnce(s, s.b, { shadow: false });
  assert.equal(scatter.n, gather.n);
  assert.deepEqual(scatter.pose, gather.pose);
  assert.deepEqual(scatter.slots, gather.slots);
  assert.deepEqual(scatter.ups, gather.ups);
});
