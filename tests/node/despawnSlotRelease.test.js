import test from 'node:test';
import assert from 'node:assert/strict';

import { GameObject } from '../../src/core/gameObject.js';
import { Transform } from '../../src/components/transform.js';
import { RigidBody } from '../../src/components/rigidBody.js';
import { Collider } from '../../src/components/collider.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { ColliderFixture } from '../../src/core/colliderFixture.js';
import { ChainPoints } from '../../src/core/chainPoints.js';
import { ShapeType } from '../../src/util/configDefaults.js';
import { resetFreeList } from '../../src/util/atomicFreeList.js';
import { packChains } from '../../src/core/save/worldBufferSave.js';

// B29 (despawnAll drift). despawnAll had drifted from despawn: it never freed
// an entity's extra collider fixtures or its collider layer feeds, and left the
// sprite fields a recycled slot must not draw with. A save restore runs
// despawnAll on every serializable type, so each load leaked the terrain's
// fixtures. Neither path freed chain points: a recycled slot kept the previous
// occupant's chain, and the next save wrote it for an entity that is no chain.

const N = 4;
const FIX = 16;
const INV = 0xffff;

function setup() {
  Transform.initializeArrays(new SharedArrayBuffer(Transform.getBufferSize(N)), N);
  RigidBody.initializeArrays(new SharedArrayBuffer(RigidBody.getBufferSize(N)), N);
  Collider.initializeArrays(new SharedArrayBuffer(Collider.getBufferSize(N)), N);
  SpriteRenderer.initializeArrays(new SharedArrayBuffer(SpriteRenderer.getBufferSize(N)), N);
  RigidBody.sleeping = new Uint8Array(N);
  ColliderFixture.initializeArrays(new SharedArrayBuffer(ColliderFixture.getBufferSize(FIX, N)), FIX, N);
  const freeList = new Uint16Array(new SharedArrayBuffer(FIX * 2));
  const freeListTop = new Int32Array(new SharedArrayBuffer(8));
  resetFreeList(freeListTop, freeList, FIX, 1);
  ColliderFixture.initialize(FIX);
  ColliderFixture.initializeFreeList(freeList.buffer, freeListTop.buffer);
  ChainPoints.initializeArrays(new SharedArrayBuffer(ChainPoints.getBufferSize(64, N)), 64, N);
  for (let i = 0; i < N; i++) {
    Transform.active[i] = 1;
    Collider.active[i] = 1;
    SpriteRenderer.active[i] = 1;
    SpriteRenderer.renderVisible[i] = 1;
    SpriteRenderer.spritesheetId[i] = 3;
    SpriteRenderer.animationState[i] = 2;
  }
  return { freeListTop };
}

const tris = new Float32Array([0, 0, 10, 0, 0, 10, 10, 0, 10, 10, 0, 10]);
const chain = new Float32Array([0, 0, 50, 0, 50, 20, 0, 20]);

class SlotEntity extends GameObject {}
function bindClass() {
  SlotEntity.startIndex = 0;
  SlotEntity.endIndex = 2;
  SlotEntity.poolSize = 2;
  SlotEntity.entityType = 0;
  SlotEntity.freeList = null;
  SlotEntity.freeListTop = null;
  SlotEntity._activeList = null;
  SlotEntity.instances = [{}, {}];
}

test('despawnAll frees fixtures and chain points and clears the sprite slot', () => {
  const { freeListTop } = setup();
  bindClass();
  const freeBefore = freeListTop[1];
  assert.equal(ColliderFixture.replaceForEntityFlat(0, tris, new Uint8Array([3, 3]), 2), true);
  assert.equal(freeListTop[1], freeBefore - 2);
  assert.equal(ChainPoints.setForEntity(1, chain, 4, true), true);

  SlotEntity.despawnAll();

  assert.equal(ColliderFixture.head[0], INV, 'fixtures unlinked');
  assert.equal(freeListTop[1], freeBefore, 'fixtures back in the pool');
  assert.equal(ChainPoints.begin[1], -1, 'chain span released');
  assert.equal(ChainPoints.count[1], 0);
  for (const i of [0, 1]) {
    assert.equal(SpriteRenderer.renderVisible[i], 0);
    assert.equal(SpriteRenderer.spritesheetId[i], 0);
    // despawn writes -1; the typed array stores its own sentinel for it.
    assert.equal(SpriteRenderer.animationState[i], SpriteRenderer.animationState.constructor.from([-1])[0]);
  }
  assert.equal(SpriteRenderer.spritesheetId[2], 3, 'other types untouched');
});

test('despawn releases a chain span too', () => {
  setup();
  bindClass();
  assert.equal(ChainPoints.setForEntity(1, chain, 4, true), true);
  const e = Object.create(SlotEntity.prototype);
  e.index = 1;
  e._hasComponents = { Collider: true };
  e.collider = true;
  e.despawn();
  assert.equal(ChainPoints.begin[1], -1);
  assert.equal(ChainPoints.count[1], 0);
});

test('a save writes chains only for entities whose collider is a chain', () => {
  setup();
  assert.equal(ChainPoints.setForEntity(1, chain, 4, true), true);
  assert.equal(Collider.shapeType[1], ShapeType.Chain);
  assert.equal(packChains([1]).length, 1);
  // A slot whose occupant is a box now, with chain data left behind.
  Collider.shapeType[1] = ShapeType.Box;
  assert.deepEqual(packChains([1]), []);
});
