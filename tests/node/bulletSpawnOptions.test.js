import test from 'node:test';
import assert from 'node:assert/strict';

import { BulletComponent } from '../../src/components/bulletComponent.js';
import { BulletPool } from '../../src/core/bulletPool.js';
import { Layer } from '../../src/core/layer.js';
import { SpriteSheetRegistry } from '../../src/core/spriteSheetRegistry.js';
import { resetFreeList } from '../../src/util/atomicFreeList.js';
import { mulberry32 } from '../bench/microbenchHelpers.mjs';

// E-286: BulletPool.spawn is a small front that copies the options into a Float64Array and its arguments, and a body
// that never sees the options object (so a caller's literal can be removed once the front is inlined). Every column a
// spawn writes must come out as the spawn before E-286 wrote it, kept here as the reference: defaults, the facing's
// three forms, texture names found and missing, layer subscriptions, values that are not numbers.

/** BulletPool.spawn before E-286, writing slot `i` (the column writes of the shipped body, from the options). */
function referenceSpawn(i, config, warned) {
  const bc = BulletComponent;
  const px = config.x;
  const py = config.y;
  bc.x[i] = px;
  bc.y[i] = py;
  bc.startX[i] = px;
  bc.startY[i] = py;
  bc.trailWidth[i] = config.trailWidth ?? 0;
  bc.prevX[i] = px;
  bc.prevY[i] = py;
  bc.vx[i] = config.vx;
  bc.vy[i] = config.vy;
  bc.damage[i] = config.damage;
  bc.ownerId[i] = config.ownerId;
  bc.shooterEntityType[i] = config.shooterEntityType ?? 0;
  let texId = 0;
  if (config.texture) {
    const resolved = SpriteSheetRegistry.getAnimationIndex('bigAtlas', config.texture);
    if (resolved === undefined) warned.add(config.texture);
    else texId = resolved;
  }
  bc.textureId[i] = texId;
  bc.scale[i] = config.scale ?? 1;
  bc.alpha[i] = config.alpha ?? 1;
  bc.tint[i] = config.tint ?? 0xffffff;
  const speedSq = config.vx * config.vx + config.vy * config.vy;
  if (speedSq > 1e-12) {
    const inv = 1 / Math.sqrt(speedSq);
    bc.bulletRotC[i] = config.vx * inv;
    bc.bulletRotS[i] = config.vy * inv;
    bc.speed[i] = speedSq * inv;
  } else {
    bc.bulletRotC[i] = 1;
    bc.bulletRotS[i] = 0;
    bc.speed[i] = 0;
  }
  if (config.spriteRotC != null && config.spriteRotS != null) {
    bc.spriteRotC[i] = config.spriteRotC;
    bc.spriteRotS[i] = config.spriteRotS;
  } else if (config.spriteRotation == null && config.rotation == null) {
    bc.spriteRotC[i] = bc.bulletRotC[i];
    bc.spriteRotS[i] = bc.bulletRotS[i];
  } else {
    const a = config.spriteRotation ?? config.rotation ?? 0;
    bc.spriteRotC[i] = Math.cos(a);
    bc.spriteRotS[i] = Math.sin(a);
  }
  bc.anchorX[i] = config.anchorX ?? 0;
  bc.anchorY[i] = config.anchorY ?? 0.5;
  bc.offsetY[i] = config.offsetY ?? 0;
  bc.layerMask[i] = Layer.resolveSubscriptions(config);
  bc.isItOnScreen[i] = 0;
  bc.active[i] = 1;
}

const COLUMNS = Object.keys(BulletComponent.ARRAY_SCHEMA);

function columnsAt(i) {
  return COLUMNS.map((key) => [key, BulletComponent[key][i]]);
}

function scramble(i) {
  for (const key of COLUMNS) BulletComponent[key][i] = 77;
}

function setupPool(count) {
  Layer.reset();
  Layer.initializeFromConfig({}, { decals: {}, castedShadows: {}, entities: {}, lighting: {} });
  BulletComponent.initializeArrays(new SharedArrayBuffer(BulletComponent.getBufferSize(count)), count);
  BulletComponent.bulletCount = count;
  const freeList = new Uint16Array(new SharedArrayBuffer(count * 2));
  const top = new Int32Array(new SharedArrayBuffer(8));
  resetFreeList(top, freeList, count, 1);
  BulletPool.reset();
  BulletPool.initialize(count);
  BulletPool.initializeFreeList(freeList.buffer, top.buffer);
  SpriteSheetRegistry.spritesheets.set('bigAtlas', { animations: { tracer: { index: 5 }, slug: { index: 9 } } });
}

/** Console warnings and errors (missing textures, layers) counted, not printed. */
function quietConsole() {
  const saved = { warn: console.warn, error: console.error };
  const said = [];
  console.warn = (...args) => said.push(['warn', String(args[0])]);
  console.error = (...args) => said.push(['error', String(args[0])]);
  return {
    said,
    restore() {
      console.warn = saved.warn;
      console.error = saved.error;
    },
  };
}

const CASES = [
  { x: 120.25, y: 33.5, vx: 1059.3, vy: -1062.1, damage: 1, ownerId: 7, shooterEntityType: 0 }, // the stress driver's
  { x: 1, y: 2, vx: 3, vy: 4 },
  {
    x: 10, y: 20, vx: 300, vy: 0, damage: 2.5, ownerId: 3, shooterEntityType: 4, texture: 'tracer', scale: 0.5,
    alpha: 0.25, tint: 0xff0000, rotation: 1.2, anchorX: 0.5, anchorY: 0.25, offsetY: -3, trailWidth: 2, layer: 'decals',
  },
  { x: 5, y: 6, vx: 0, vy: 100, spriteRotC: 0.6, spriteRotS: 0.8, rotation: 2 },
  { x: 5, y: 6, vx: 0, vy: 100, spriteRotation: 0.3, rotation: 2 },
  { x: 5, y: 6, vx: 0, vy: 100, spriteRotation: null, rotation: 0.7 },
  { x: 5, y: 6, vx: 0, vy: 100, spriteRotC: 0.6, rotation: 0.7 },
  { x: 5, y: 6, vx: 0, vy: 100, spriteRotC: 0.6 },
  { x: 0, y: 0, vx: 0, vy: 0, damage: 1, ownerId: 1 },
  { x: 9, y: 9, vx: 1, vy: 1, scale: null, alpha: null, tint: null, shooterEntityType: null, anchorY: null },
  { x: '12.5', y: '7', vx: '300', vy: '-40', damage: '3', ownerId: '2', rotation: '1' },
  { x: 1, y: 1, vx: 50, vy: 50, layers: ['decals', 'entities'] },
  { x: 1, y: 1, vx: 50, vy: 50, layers: null },
  { x: 1, y: 1, vx: 50, vy: 50, layers: 'lighting', layer: 'decals' },
  { x: 1, y: 1, vx: 50, vy: 50, layer: null },
  { x: 1, y: 1, vx: 50, vy: 50, layer: 'nowhere' },
  { x: 1, y: 1, vx: 50, vy: 50, texture: 'nope' },
  { x: 1, y: 1, vx: 50, vy: 50, texture: 'nope' },
  { x: 1, y: 1, vx: 50, vy: 50, texture: '' },
  { x: 1, y: 1, vx: 50, vy: 50, ownerId: 70000, tint: 0x1ffffffff, damage: NaN, offsetY: Infinity },
  { x: -1e-9, y: 3e38, vx: 1e-7, vy: -1e-7 },
];

test('every column a spawn writes matches the spawn before E-286', () => {
  setupPool(8);
  const quiet = quietConsole();
  try {
    const r = mulberry32(0xe286);
    const cases = [...CASES];
    for (let k = 0; k < 40; k++) {
      cases.push({
        x: r() * 4000, y: r() * 3000, vx: (r() - 0.5) * 3000, vy: (r() - 0.5) * 3000, damage: 1, ownerId: k,
        shooterEntityType: 0, scale: k % 3 ? 0.5 + r() : undefined, rotation: k % 4 ? undefined : r() * 6,
      });
    }
    const warnedBefore = new Set();
    for (const config of cases) {
      const i = BulletPool.spawn(config);
      assert.ok(i >= 0, `spawn ${JSON.stringify(config)}`);
      const got = columnsAt(i);
      scramble(i);
      referenceSpawn(i, config, warnedBefore);
      assert.deepEqual(got, columnsAt(i), `columns for ${JSON.stringify(config)}`);
      BulletPool.despawn(i);
    }
    assert.deepEqual([...BulletPool._warnedMissingTextures], [...warnedBefore]);
    assert.equal(quiet.said.filter(([, m]) => m.includes('BulletPool.spawn: texture "nope"')).length, 1, 'one warning');
  } finally {
    quiet.restore();
    BulletPool.reset();
    Layer.reset();
  }
});

test('a full pool returns -1 with one warning and leaves the taken slots as they are', () => {
  setupPool(2);
  const quiet = quietConsole();
  try {
    const a = BulletPool.spawn({ x: 1, y: 1, vx: 10, vy: 0, damage: 1, ownerId: 0 });
    const b = BulletPool.spawn({ x: 2, y: 2, vx: 10, vy: 0, damage: 1, ownerId: 0 });
    const before = [columnsAt(a), columnsAt(b)];
    assert.equal(BulletPool.spawn({ x: 3, y: 3, vx: 10, vy: 0, damage: 1, ownerId: 0 }), -1);
    assert.equal(BulletPool.spawn({ x: 4, y: 4, vx: 10, vy: 0, damage: 1, ownerId: 0 }), -1);
    assert.deepEqual([columnsAt(a), columnsAt(b)], before);
    assert.equal(quiet.said.filter(([, m]) => m.includes('pool exhausted')).length, 1);
    BulletPool.despawn(a);
    assert.equal(BulletPool.spawn({ x: 5, y: 5, vx: 10, vy: 0, damage: 1, ownerId: 0 }), a, 'the freed slot spawns');
    assert.equal(BulletComponent.x[a], 5);
  } finally {
    quiet.restore();
    BulletPool.reset();
    Layer.reset();
  }
});

test('a spawn keeps no reference to the layers it was given', () => {
  setupPool(2);
  try {
    const layers = ['decals'];
    const i = BulletPool.spawn({ x: 1, y: 1, vx: 1, vy: 0, layers });
    assert.equal(BulletComponent.layerMask[i], Layer.resolveSubscriptions({ layers }));
    const j = BulletPool.spawn({ x: 1, y: 1, vx: 1, vy: 0 });
    assert.equal(BulletComponent.layerMask[j], Layer.entitiesMask(), 'the next spawn without layers draws with the entities');
  } finally {
    BulletPool.reset();
    Layer.reset();
  }
});
