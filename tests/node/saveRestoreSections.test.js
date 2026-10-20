import test from 'node:test';
import assert from 'node:assert/strict';

import { Collider } from '../../src/components/collider.js';
import { RigidBody } from '../../src/components/rigidBody.js';
import { Transform } from '../../src/components/transform.js';
import { ChainPoints } from '../../src/core/chainPoints.js';
import { Tween, TWEEN_KIND_PAINT, TWEEN_KIND_ZOOM, tweenBufferBytes } from '../../src/core/tween.js';
import { encodeSaveUncompressed, decodeSaveUncompressed } from '../../src/core/save/entitySaveSnapshot.js';
import { applyChains, packChains, applyTweens } from '../../src/core/save/worldBufferSave.js';

// B13. A geometry section that is absent (a save older than 67a93c49, or a subsystem
// that was unbound when saving) must leave what the restored entity's onSpawned built.
// A section that is present and empty means "this entity had none": clear it.

function roundtrip(partial) {
  return decodeSaveUncompressed(encodeSaveUncompressed({
    sceneName: 'T',
    engineVersion: '0',
    layout: { types: [], totalEntityCount: 0 },
    camera: null,
    sun: null,
    entities: [],
    joints: [],
    ...partial,
  }));
}

function chains(n) {
  Collider.initializeArrays(new SharedArrayBuffer(Collider.getBufferSize(n)), n);
  RigidBody.initializeArrays(new SharedArrayBuffer(RigidBody.getBufferSize(n)), n);
  for (let i = 0; i < n; i++) {
    Collider.active[i] = 1;
    RigidBody.active[i] = 1;
    RigidBody.static[i] = 1;
  }
  ChainPoints.initializeArrays(new SharedArrayBuffer(ChainPoints.getBufferSize(32, n)), 32, n);
}

const SQUARE = new Float32Array([0, 0, 30, 0, 30, 20, 0, 20]);

test('a save without a CHAINS section keeps the chain onSpawned built', () => {
  chains(4);
  assert.equal(ChainPoints.setForEntity(3, SQUARE, 4, false), true); // built by onSpawned
  const decoded = roundtrip({});
  assert.equal(decoded.chains, null, 'absent section decodes to null');
  applyChains(decoded.chains, [{ old: 1, neu: 3 }]);
  assert.equal(ChainPoints.count[3], 4, 'an older save must not wipe it');
});

test('a save whose entities had no chains writes an empty section, and that clears', () => {
  chains(4);
  const packed = packChains([1]); // bound, entity 1 has no chain
  assert.deepEqual(packed, []);
  const decoded = roundtrip({ chains: packed });
  assert.deepEqual(decoded.chains, [], 'empty section is present');
  assert.equal(ChainPoints.setForEntity(3, SQUARE, 4, false), true);
  applyChains(decoded.chains, [{ old: 1, neu: 3 }]);
  assert.equal(ChainPoints.count[3], 0, 'the saved entity had no chain');
});

test('packChains returns null when the chain pool is not bound', () => {
  const prevCount = ChainPoints.count;
  try {
    ChainPoints.count = null;
    assert.equal(packChains([1]), null);
  } finally {
    ChainPoints.count = prevCount;
  }
});

function tweens(slots, entities) {
  Tween.bind(new SharedArrayBuffer(tweenBufferBytes(slots)), slots);
  Transform.active = new Uint8Array(entities);
}

function live(slot, kind, entity) {
  Tween.kind[slot] = kind;
  Tween.entity[slot] = entity;
  Tween.duration[slot] = 100;
  Atomics.store(Tween.active, slot, 1);
}

test('a load keeps tweens on entities the save does not own', () => {
  const prevActive = Transform.active;
  try {
    tweens(4, 16);
    // create() ran again for the load: a static (non-serializable) prop fading in.
    Transform.active[5] = 1;
    live(0, TWEEN_KIND_PAINT, 5);
    // A serializable entity create() spawned; the restore despawned it.
    live(1, TWEEN_KIND_PAINT, 2);
    // The restored entity's onSpawned started a tween; the saved one replaces it.
    Transform.active[7] = 1;
    live(2, TWEEN_KIND_PAINT, 7);

    const saved = [{
      kind: TWEEN_KIND_PAINT, ease: 0, mask: 1, entity: 3, duration: 100, elapsed: 40,
      from0: 0.25, to0: 1, from1: 0, to1: 0, from2: 0, to2: 0, from3: 0, to3: 0, tintFrom: 0, tintTo: 0,
    }, {
      kind: TWEEN_KIND_ZOOM, ease: 0, mask: 1, entity: 0, duration: 50, elapsed: 10,
      from0: 1, to0: 2, from1: 0, to1: 0, from2: 0, to2: 0, from3: 0, to3: 0, tintFrom: 0, tintTo: 0,
    }];
    applyTweens(saved, (old) => (old === 3 ? 7 : null), [{ old: 3, neu: 7 }]);

    const liveSlots = [];
    for (let i = 0; i < 4; i++) {
      if (Atomics.load(Tween.active, i) === 1) liveSlots.push([Tween.kind[i], Tween.entity[i], Tween.elapsed[i]]);
    }
    liveSlots.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    assert.deepEqual(liveSlots, [
      [TWEEN_KIND_PAINT, 5, 0], // the prop's fade-in survives
      [TWEEN_KIND_PAINT, 7, 40], // the saved tween, remapped 3 -> 7
      [TWEEN_KIND_ZOOM, 0, 10], // the saved zoom
    ]);
  } finally {
    Tween.unbind();
    Transform.active = prevActive;
  }
});

// The real save path, not a hand-built payload: buildSavePayload must survive unbound
// pools (pack returns null) and keep a bound pool's empty list so the section is written.
test('buildSavePayload with every geometry pool unbound does not throw and writes no section', async () => {
  const { buildSavePayload } = await import('../../src/core/save/entitySaveSnapshot.js');
  const { ColliderFixture } = await import('../../src/core/colliderFixture.js');
  const { MeshGeometry } = await import('../../src/core/meshGeometry.js');
  const prev = [ChainPoints.count, ColliderFixture.head, MeshGeometry.vertCount];
  try {
    ChainPoints.count = null;
    ColliderFixture.head = null;
    MeshGeometry.vertCount = null;
    const payload = buildSavePayload({ registeredClasses: [], totalEntityCount: 0 }, { camera: null, sun: null });
    assert.equal(payload.chains, undefined);
    assert.equal(payload.fixtures, undefined);
    assert.equal(payload.meshes, undefined);
  } finally {
    [ChainPoints.count, ColliderFixture.head, MeshGeometry.vertCount] = prev;
  }
});

test('buildSavePayload keeps a bound chain pool as an empty, present section', async () => {
  const { buildSavePayload } = await import('../../src/core/save/entitySaveSnapshot.js');
  chains(4);
  const payload = buildSavePayload({ registeredClasses: [], totalEntityCount: 0 }, { camera: null, sun: null });
  assert.deepEqual(payload.chains, []);
  assert.deepEqual(decodeSaveUncompressed(encodeSaveUncompressed(payload)).chains, []);
});
