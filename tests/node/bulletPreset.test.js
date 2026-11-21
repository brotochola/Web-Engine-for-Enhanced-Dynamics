import test from 'node:test';
import assert from 'node:assert/strict';

import { BulletComponent } from '../../src/components/bulletComponent.js';
import { Transform } from '../../src/components/transform.js';
import { BulletPool } from '../../src/core/bulletPool.js';
import { Layer } from '../../src/core/layer.js';
import { SpriteSheetRegistry } from '../../src/core/spriteSheetRegistry.js';
import { resetFreeList } from '../../src/util/atomicFreeList.js';
import { mulberry32 } from '../bench/microbenchHelpers.mjs';

// E-541: a bullet from a preset (BulletPool.define once, spawnPreset per shot) is the bullet spawn() writes from the
// preset's keys and the shot's: every column, the facing's three forms, layers, a missing texture. The shot's
// shooterEntityType is its owner's entity type, its damage the preset's (a weapon is a preset). A preset takes only the look's keys; a shot's offsetY left undefined
// is the preset's.

const COLUMNS = Object.keys(BulletComponent.ARRAY_SCHEMA);
const columnsAt = (i) => COLUMNS.map((key) => [key, BulletComponent[key][i]]);
const ENTITIES = 16;

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
  SpriteSheetRegistry.spritesheets.set('bigAtlas', { animations: { bullet: { index: 3 }, tracer: { index: 5 } } });
  Transform.initializeArrays(new SharedArrayBuffer(Transform.getBufferSize(ENTITIES)), ENTITIES);
  for (let e = 0; e < ENTITIES; e++) Transform.entityType[e] = (e * 3) % 7;
}

function quietConsole() {
  const saved = { warn: console.warn, error: console.error };
  console.warn = () => {};
  console.error = () => {};
  return () => {
    console.warn = saved.warn;
    console.error = saved.error;
  };
}

/** Preset looks: Predator's rifle, and every key and facing form. */
const LOOKS = [
  { damage: 0.66, texture: 'bullet', scale: 1, anchorX: 1, anchorY: 0.5, trailWidth: 4 },
  {},
  { texture: 'tracer', scale: 0.5, alpha: 0.25, tint: 0xff0000, rotation: 1.2, anchorX: 0.5, anchorY: 0.25, trailWidth: 2, layer: 'decals' },
  { damage: 2.5, spriteRotC: 0.6, spriteRotS: 0.8, rotation: 2 },
  { spriteRotation: 0.3, rotation: 2 },
  { spriteRotC: 0.6 },
  { layers: ['decals', 'entities'] },
  { texture: 'nope', offsetY: -7 },
];

test('a preset spawn writes every column spawn() writes from the same keys', () => {
  setupPool(8);
  const restore = quietConsole();
  try {
    const ids = LOOKS.map((look) => BulletPool.define(look));
    const r = mulberry32(0xe541);
    for (let k = 0; k < 200; k++) {
      const p = k % LOOKS.length;
      const shot = {
        x: r() * 4000, y: r() * 3000, offsetY: k % 5 === 0 ? undefined : -r() * 40,
        vx: (r() - 0.5) * 3000, vy: (r() - 0.5) * 3000, ownerId: k % 4 === 0 ? -1 : k % ENTITIES,
      };
      const a = BulletPool.spawnPreset(ids[p], shot.x, shot.y, shot.offsetY, shot.vx, shot.vy, shot.ownerId);
      assert.ok(a >= 0);
      const got = columnsAt(a);
      BulletPool.despawn(a);
      const literal = {
        ...LOOKS[p], ...shot,
        offsetY: shot.offsetY ?? LOOKS[p].offsetY,
        damage: LOOKS[p].damage ?? 1,
        shooterEntityType: shot.ownerId >= 0 ? Transform.entityType[shot.ownerId] : 0,
      };
      const b = BulletPool.spawn(literal);
      assert.deepEqual(got, columnsAt(b), `look ${p}, shot ${k}`);
      BulletPool.despawn(b);
    }
  } finally {
    restore();
    BulletPool.reset();
    Layer.reset();
  }
});

test('a preset takes only the look\'s keys, and an id define did not return throws', () => {
  setupPool(2);
  assert.throws(() => BulletPool.define({ texture: 'bullet', ownerId: 2 }), /"ownerId" is not a preset key/);
  assert.throws(() => BulletPool.define({ vx: 1 }), /is not a preset key/);
  assert.throws(() => BulletPool.define(null), TypeError);
  const id = BulletPool.define({ texture: 'bullet' });
  assert.throws(() => BulletPool.spawnPreset(id + 1000, 0, 0, 0, 1, 0, 0), RangeError);
  assert.throws(() => BulletPool.spawnPreset(-5, 0, 0, 0, 1, 0, 0), RangeError);
  BulletPool.reset();
  Layer.reset();
});

test('a full pool returns -1 from a preset spawn too', () => {
  setupPool(1);
  const restore = quietConsole();
  try {
    const id = BulletPool.define({ texture: 'bullet' });
    assert.ok(BulletPool.spawnPreset(id, 1, 1, 0, 10, 0, 0) >= 0);
    assert.equal(BulletPool.spawnPreset(id, 2, 2, 0, 10, 0, 0), -1);
  } finally {
    restore();
    BulletPool.reset();
    Layer.reset();
  }
});
