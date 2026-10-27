import test from 'node:test';
import assert from 'node:assert/strict';

import { bootEmitWorker } from '../helpers/preRenderEmitBoot.mjs';
import { ParticleComponent } from '../../src/components/particleComponent.js';
import { Layer } from '../../src/core/layer.js';
import { CAMERA_TYPES, DECORATION_Y_SORT_SCALE, PARTICLE_SORT_BIAS } from '../../src/util/configDefaults.js';
import { spriteYSortKey } from '../../src/util/sortIndexByKey.js';

// A heighted particle y-sorts by its ground row (round(y)), as a sprite sorts by its feet, and is still drawn at
// y + z. Before, it sorted by y + z: a spark in the air sorted as if it stood further north and slipped behind a
// tree it is in front of. Flat particles take the same key; zenithal ones keep sorting by height.

const K = DECORATION_Y_SORT_SCALE;

async function collectKeys(rows) {
  Layer.reset();
  Layer.initializeFromConfig({}, { decals: {}, castedShadows: {}, entities: {}, lighting: {} }, true);
  try {
    const n = rows.length;
    const visible = new SharedArrayBuffer(2 * (n + 1));
    const { worker: w } = await bootEmitWorker(4, { maxItems: Math.max(8, n), particles: n, extra: { visibleParticlesData: visible } });
    const entities = Layer.entitiesMask();
    rows.forEach((r, i) => {
      ParticleComponent.active[i] = 1;
      ParticleComponent.x[i] = 100;
      ParticleComponent.y[i] = r.y;
      ParticleComponent.z[i] = r.z ?? 0;
      ParticleComponent.flat[i] = r.flat ? 1 : 0;
      ParticleComponent.viewMode[i] = r.zenithal ? CAMERA_TYPES.ZENITHAL : CAMERA_TYPES.TOPDOWN;
      ParticleComponent.scaleX[i] = 1;
      ParticleComponent.scaleY[i] = 1;
      ParticleComponent.alpha[i] = 1;
      ParticleComponent.layerMask[i] = entities;
    });
    new Uint16Array(visible).set([n, ...rows.map((_, i) => i)]);
    w._renderableCount = 0;
    w._bindCollectPoses();
    w.collectVisibleParticles();
    const keys = new Array(n);
    for (let k = 0; k < w._renderableCount; k++) {
      assert.equal(w._renderableType[k], 1, 'a particle row');
      keys[w._renderableIndex[k]] = w._renderableY[k];
    }
    const yRows = [];
    w.buildRenderQueue(16);
    for (let k = 0; k < w.renderQueueCount[0]; k++) yRows.push(w.renderQueueY[k]);
    return { keys, yRows };
  } finally {
    Layer.reset();
  }
}

test('a heighted particle sorts by its ground row and is drawn at y + z', async () => {
  const { keys, yRows } = await collectKeys([
    { y: 200.4, z: -60 }, // a spark 60 px up over row 200
    { y: 200.4, z: 0 }, // the same spot on the floor
    { y: 140.4, z: 0 }, // a particle 60 px north, on the floor
  ]);
  const row200 = spriteYSortKey(200.4, K) + PARTICLE_SORT_BIAS;
  assert.equal(keys[0], row200, 'the airborne spark keys on its ground row');
  assert.equal(keys[1], row200, 'height does not change the key');
  assert.ok(keys[0] > keys[2], 'the spark sorts in front of a particle 60 px north, though it is drawn at the same screen y');
  assert.deepEqual(yRows.map((v) => Math.round(v * 10) / 10).sort((a, b) => a - b), [140.4, 140.4, 200.4], 'drawn at y + z');
});

test('a particle draws in front of a body standing on its row, behind the next row', async () => {
  const { keys } = await collectKeys([{ y: 300.2, z: -12 }, { y: 299.6, z: -3 }]);
  const footOfRow300 = spriteYSortKey(300, K); // a sprite whose feet are on row 300
  assert.ok(keys[0] > footOfRow300 && keys[0] < spriteYSortKey(301, K), 'between the body on row 300 and row 301');
  assert.equal(keys[1], keys[0], 'sub-pixel ground positions on the same row tie, as sprites do');
});

test('the collected key is spriteYSortKey\'s row: halves, negatives, tiny values', async () => {
  // The collector keeps keys as float32, exact while |key| < 2^24 (|y| up to 131 071).
  const ys = [
    0, -0, 0.5, -0.5, 1.5, -1.5, 2.5, -2.5, 0.49999997, -0.49999997, 0.50000006, 1e-30, -1e-30, 1.4e-45, -1.4e-45,
    123.5, -123.5, 2999.4999, 2999.5, 65535.5, -65535.5, 131070.5, -131070.5,
  ].map(Math.fround);
  const { keys } = await collectKeys(ys.map((y) => ({ y, z: -7 })));
  ys.forEach((y, i) => {
    assert.ok(Object.is(keys[i], spriteYSortKey(y, K) + PARTICLE_SORT_BIAS), `y = ${y}: ${keys[i]}`);
  });
});

test('floor(y + 0.5) is Math.round(y) for float32 y, as the particle key uses it', () => {
  // y + 0.5 is exact in double for a float32 y, so the floor rounds the true value. Huge, tiny, and near-half values.
  const f32 = new Float32Array(1);
  const u32 = new Uint32Array(f32.buffer);
  const seen = [];
  for (let e = 0; e < 255; e++) {
    for (const m of [0, 1, 0x3fffff, 0x400000, 0x400001, 0x7fffff]) {
      for (const s of [0, 0x80000000]) {
        u32[0] = (s | (e << 23) | m) >>> 0;
        seen.push(f32[0]);
      }
    }
  }
  for (const y of seen) {
    assert.ok(Object.is(Math.floor(y + 0.5) * K + PARTICLE_SORT_BIAS, Math.round(y) * K + PARTICLE_SORT_BIAS), `y = ${y}`);
  }
});

test('flat particles take the same key; zenithal ones keep sorting by height', async () => {
  const { keys } = await collectKeys([
    { y: 80.3, flat: true },
    { y: 80.3, z: -30, zenithal: true },
  ]);
  assert.equal(keys[0], spriteYSortKey(80.3, K) + PARTICLE_SORT_BIAS);
  assert.equal(keys[1], 30);
});
