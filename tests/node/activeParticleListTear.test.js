// N-136: Pixi walks the active particle list for the particle light field while the particle worker writes the next
// one, each on its own loop. With one list a read that overlapped a write mixed the two, and a light was missing or
// drawn twice that frame. A real particle worker in a thread of its own writes the active list as fast as it goes,
// the live particles alternating between the even slots and the odd ones; a real Pixi worker on the main thread,
// bound by its own init path, takes the list as the light field does, as fast as it goes, and every take must be one
// of the two lists whole.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';

import { ParticleComponent } from '../../src/components/particleComponent.js';
import { loadWorker, quietly } from '../bench/workerHarness.mjs';
import { buildPoolScene } from '../helpers/poolScene.mjs';

const CHANGES = 300;
const RACE_MS = 1000;
const N = 4000;
const VIEW = [0, 0, 9000, 2000];

/** The list taken, as the parity it is (0 or 1), or -1 when it is neither list whole. */
function classify(list, sizes, seen, gen) {
  const count = list[0];
  // Both lists hold as many: the first entry's parity names the one this should be, and every entry must match it.
  const parity = list[1] & 1;
  if (count !== sizes[parity]) return -1;
  for (let k = 1; k <= count; k++) {
    const i = list[k];
    if (i >= N || seen[i] === gen || (i & 1) !== parity) return -1;
    seen[i] = gen;
  }
  return parity;
}

test('Pixi takes one whole active particle list while the particle worker writes the next', async (t) => {
  const scene = buildPoolScene({ particles: N, world: [9000, 2000] });
  for (let k = 0; k < N; k++) {
    ParticleComponent.x[k] = 5 + k * 2;
    ParticleComponent.y[k] = 100;
  }
  const b = scene.buffers;
  const stop = new SharedArrayBuffer(4);
  const writer = new Worker(new URL('../helpers/visibleListWriter.mjs', import.meta.url), {
    workerData: {
      kind: 'activeParticles',
      config: scene.config,
      n: N,
      views: [VIEW, VIEW],
      stop,
      buffers: {
        component: b.componentData.ParticleComponent,
        componentByte: b.componentDataByte?.ParticleComponent | 0,
        freeList: b.particleFreeList,
        freeListTop: b.particleFreeListTop,
        active: b.activeParticlesData,
        visible: b.visibleParticlesData,
        activeByte: b.activeParticlesByte | 0,
        visibleByte: b.visibleParticlesByte | 0,
        memory: scene.particleMemory.memory,
        layout: scene.particleMemory.layout,
      },
    },
  });
  const next = () =>
    new Promise((resolve, reject) => {
      writer.once('message', resolve);
      writer.once('error', reject);
    });
  try {
    const { expected } = await next();
    const sizes = expected.map((list) => list.length);
    assert.deepEqual(sizes, [N / 2, N / 2], 'each list holds half the pool');
    assert.ok(expected[0].every((i) => (i & 1) === 0) && expected[1].every((i) => (i & 1) === 1), 'the two parities');

    const px = await loadWorker('pixiWorker.js', 'pixiRenderer');
    await quietly(() =>
      px.initializeCommonBuffers({
        config: scene.config,
        globalEntityCount: scene.totalEntityCount,
        maxParticles: N,
        activeParticlesData: b.activeParticlesData,
        activeParticlesByte: b.activeParticlesByte | 0,
        buffers: {
          componentData: { ParticleComponent: b.componentData.ParticleComponent },
          componentDataByte: { ParticleComponent: b.componentDataByte?.ParticleComponent | 0 },
        },
      }),
    );
    // Both halves list as many, so the count alone cannot tell them apart: the parity of every entry does.
    const seen = new Uint32Array(N);
    const done = next();
    writer.postMessage('go');
    let reads = 0;
    let torn = 0;
    let switches = 0;
    let last = -1;
    const t0 = performance.now();
    while (switches < CHANGES && performance.now() - t0 < RACE_MS) {
      reads++;
      const parity = classify(px._takeActiveParticles(), sizes, seen, reads);
      if (parity < 0) torn++;
      else {
        if (last >= 0 && parity !== last) switches++;
        last = parity;
      }
    }
    Atomics.store(new Int32Array(stop), 0, 1);
    const { frames } = await done;
    t.diagnostic(`${reads} takes, ${frames} lists written, ${switches} changes seen, ${torn} torn`);
    assert.equal(torn, 0, `${torn} of ${reads} takes were neither list whole (${frames} writes)`);
    assert.ok(switches >= 30, `the reader saw the list change under it (${switches} times in ${reads} takes)`);
  } finally {
    Atomics.store(new Int32Array(stop), 0, 1);
    await writer.terminate();
  }
});
