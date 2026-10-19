import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { Component } from '../../src/core/component.js';
import { Collider } from '../../src/components/collider.js';
import { RigidBody } from '../../src/components/rigidBody.js';
import { Camera } from '../../src/core/camera.js';
import { ChainPoints } from '../../src/core/chainPoints.js';
import { ColliderFixture } from '../../src/core/colliderFixture.js';
import { MeshGeometry, resetMeshGeometryWarns } from '../../src/core/meshGeometry.js';
import { NavGrid } from '../../src/core/navGrid.js';
import { SharedResource } from '../../src/core/sharedResource.js';
import { Time } from '../../src/core/timeScale.js';
import { Tween, TWEEN_KIND_PAINT, TWEEN_KIND_ZOOM, tweenBufferBytes } from '../../src/core/tween.js';
import {
  SAVE_FORMAT_VERSION,
  componentSchemaFingerprint,
  encodeSaveUncompressed,
  decodeSaveUncompressed,
} from '../../src/core/save/entitySaveSnapshot.js';
import {
  packSharedResources,
  applySharedResources,
  packChains,
  applyChains,
  packFixtures,
  applyFixtures,
  packMeshes,
  applyMeshes,
  packNav,
  applyNav,
  packTime,
  applyTime,
  packTweens,
  applyTweens,
  remapEntityIdFields,
  remapCameraFollow,
} from '../../src/core/save/worldBufferSave.js';
import { entityIdNone } from '../../src/util/entityIdWidth.js';
import { resetFreeList } from '../../src/util/atomicFreeList.js';

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

function silenceWarn(fn) {
  const warns = [];
  const orig = console.warn;
  console.warn = (msg) => warns.push(String(msg));
  try {
    fn();
  } finally {
    console.warn = orig;
  }
  return warns;
}

test('world-buffer sections round-trip and old saves leave them empty', () => {
  const payload = {
    sharedResources: [{ name: 'Grid', bytes: Uint8Array.from([1, 2, 3, 4]) }],
    chains: [{
      entityIndex: 2,
      loop: 1,
      count: 3,
      xy: Float32Array.from([0, 0, 10, 0, 5, 8]),
    }],
    fixtures: [{
      entityIndex: 2,
      counts: Uint8Array.from([3]),
      xy: Float32Array.from([0, 0, 10, 0, 0, 10]),
    }],
    meshes: [{
      entityIndex: 2,
      xy: Float32Array.from([0, 0, 10, 0, 0, 10]),
      uv: Float32Array.from([0, 0, 1, 0, 0, 1]),
      indices: Uint16Array.from([0, 1, 2]),
    }],
    nav: {
      gridWidth: 2,
      gridHeight: 2,
      cellSize: 16,
      walkability: Uint8Array.from([1, 0, 2, 1]),
    },
    timeScale: 0,
    tweens: [{
      kind: 0,
      ease: 1,
      mask: 1,
      entity: 3,
      duration: 100,
      elapsed: 40,
      from0: 0.25,
      to0: 1,
      from1: 0,
      to1: 0,
      from2: 0,
      to2: 0,
      from3: 0,
      to3: 0,
      tintFrom: 1,
      tintTo: 2,
    }],
  };
  const decoded = roundtrip(payload);
  assert.equal(decoded.formatVersion, 5);
  assert.equal(SAVE_FORMAT_VERSION, 5);
  assert.equal(decoded.sharedResources[0].name, 'Grid');
  assert.deepEqual([...decoded.sharedResources[0].bytes], [1, 2, 3, 4]);
  assert.equal(decoded.chains[0].entityIndex, 2);
  assert.equal(decoded.chains[0].loop, 1);
  assert.equal(decoded.chains[0].count, 3);
  assert.deepEqual([...decoded.chains[0].xy], [0, 0, 10, 0, 5, 8]);
  assert.deepEqual([...decoded.fixtures[0].counts], [3]);
  assert.deepEqual([...decoded.fixtures[0].xy], [0, 0, 10, 0, 0, 10]);
  assert.deepEqual([...decoded.meshes[0].uv], [0, 0, 1, 0, 0, 1]);
  assert.deepEqual([...decoded.meshes[0].indices], [0, 1, 2]);
  assert.equal(decoded.nav.gridWidth, 2);
  assert.equal(decoded.nav.cellSize, 16);
  assert.deepEqual([...decoded.nav.walkability], [1, 0, 2, 1]);
  assert.equal(decoded.timeScale, 0);
  assert.equal(decoded.tweens[0].entity, 3);
  assert.equal(decoded.tweens[0].elapsed, 40);
  assert.equal(decoded.tweens[0].from0, 0.25);

  const old = roundtrip({});
  assert.equal(old.formatVersion, 5);
  assert.equal(old.sharedResources, null);
  assert.equal(old.chains, null);
  assert.equal(old.fixtures, null);
  assert.equal(old.meshes, null);
  assert.equal(old.nav, null);
  assert.equal(old.timeScale, null);
  assert.equal(old.tweens, null);
});

describe('world buffer apply', { concurrency: false }, () => {
  test('shared resource bytes restore, and a longer buffer is skipped', () => {
    class ProbeRes extends SharedResource {}
    SharedResource.resetAll();
    const schema = {
      hp: Float32Array,
      score: { type: Int32Array, length: 2, atomic: true },
    };
    const size = SharedResource.getBufferSize(schema);
    ProbeRes.initialize(new SharedArrayBuffer(size), schema);
    ProbeRes.hp[0] = 1.25;
    ProbeRes.score.store(7, 0);
    ProbeRes.score.store(9, 1);

    const decoded = roundtrip({ sharedResources: packSharedResources() });
    ProbeRes.hp[0] = 0;
    ProbeRes.score.store(0, 0);
    ProbeRes.score.store(0, 1);
    applySharedResources(decoded.sharedResources);
    assert.equal(ProbeRes.hp[0], 1.25);
    assert.equal(ProbeRes.score.load(0), 7);
    assert.equal(ProbeRes.score.load(1), 9);

    const warns = silenceWarn(() => {
      applySharedResources([{ name: 'ProbeRes', bytes: new Uint8Array(size + 4) }]);
    });
    assert.equal(ProbeRes.hp[0], 1.25);
    assert.ok(warns.some((w) => w.includes('ProbeRes')));
    SharedResource.resetAll();
  });

  test('chain moves onto the new index and a saved entity with no chain is cleared', () => {
    const n = 4;
    Collider.initializeArrays(new SharedArrayBuffer(Collider.getBufferSize(n)), n);
    RigidBody.initializeArrays(new SharedArrayBuffer(RigidBody.getBufferSize(n)), n);
    for (let i = 0; i < n; i++) {
      Collider.active[i] = 1;
      RigidBody.active[i] = 1;
      RigidBody.static[i] = 1;
    }
    ChainPoints.initializeArrays(new SharedArrayBuffer(ChainPoints.getBufferSize(32, n)), 32, n);
    const xy = new Float32Array([0, 0, 30, 0, 30, 20, 0, 20]);
    assert.equal(ChainPoints.setForEntity(1, xy, 4, false), true);
    assert.equal(ChainPoints.setForEntity(2, xy, 4, false), true);

    const decoded = roundtrip({ chains: packChains([1, 0]) });
    applyChains(decoded.chains, [{ old: 1, neu: 3 }, { old: 0, neu: 2 }]);

    assert.equal(ChainPoints.count[3], 4);
    assert.equal(ChainPoints.loop[3], 0);
    const begin = ChainPoints.begin[3];
    const got = [];
    for (let k = 0; k < 8; k++) got.push(ChainPoints.xy[begin * 2 + k]);
    assert.deepEqual(got, [...xy]);
    assert.equal(ChainPoints.count[2], 0);
    assert.equal(ChainPoints.begin[2], -1);
  });

  test('fixtures move onto the new index and a saved entity with none is cleared', () => {
    const entityCount = 4;
    const maxFixtures = 32;
    Collider.initializeArrays(new SharedArrayBuffer(Collider.getBufferSize(entityCount)), entityCount);
    RigidBody.initializeArrays(new SharedArrayBuffer(RigidBody.getBufferSize(entityCount)), entityCount);
    for (let i = 0; i < entityCount; i++) {
      Collider.active[i] = 1;
      RigidBody.active[i] = 1;
      RigidBody.static[i] = 1;
    }
    const fSize = ColliderFixture.getBufferSize(maxFixtures, entityCount);
    ColliderFixture.initializeArrays(new SharedArrayBuffer(fSize), maxFixtures, entityCount);
    const freeList = new Uint16Array(new SharedArrayBuffer(maxFixtures * 2));
    const freeListTop = new Int32Array(new SharedArrayBuffer(8));
    resetFreeList(freeListTop, freeList, maxFixtures, 1);
    ColliderFixture.initialize(maxFixtures);
    ColliderFixture.initializeFreeList(freeList.buffer, freeListTop.buffer);

    const counts = Uint8Array.from([3]);
    const xy = Float32Array.from([0, 0, 10, 0, 0, 10]);
    assert.equal(Collider.replacePolygonsFlat(1, xy, counts, 1), true);
    assert.equal(Collider.replacePolygonsFlat(2, xy, counts, 1), true);

    const decoded = roundtrip({ fixtures: packFixtures([1, 0]) });
    applyFixtures(decoded.fixtures, [{ old: 1, neu: 3 }, { old: 0, neu: 2 }]);

    assert.equal(Collider.fixtureCount[3], 1);
    const head = ColliderFixture.headOf(3);
    const base = ColliderFixture.vertBase(head);
    assert.equal(ColliderFixture.vertexX[base], 0);
    assert.equal(ColliderFixture.vertexY[base + 1], 0);
    assert.equal(ColliderFixture.vertexX[base + 2], 0);
    assert.equal(Collider.fixtureCount[2], 0);
    assert.equal(ColliderFixture.headOf(2), ColliderFixture.INVALID_INDEX);
  });

  test('custom mesh moves onto the new index and a saved entity with none is cleared', () => {
    MeshGeometry.reset();
    resetMeshGeometryWarns();
    const bytes = MeshGeometry.getBufferSize(32, 16, 4);
    MeshGeometry.initializeArrays(new SharedArrayBuffer(bytes), 32, 16, 4);
    const xy = new Float32Array([0, 0, 10, 0, 0, 10]);
    const uv = new Float32Array([0, 0, 1, 0, 0, 1]);
    const indices = new Uint16Array([0, 1, 2]);
    assert.equal(MeshGeometry.replace(1, xy, indices, uv), true);
    assert.equal(MeshGeometry.replace(2, xy, indices, uv), true);

    const decoded = roundtrip({ meshes: packMeshes([1, 0]) });
    applyMeshes(decoded.meshes, [{ old: 1, neu: 3 }, { old: 0, neu: 2 }]);

    assert.equal(MeshGeometry.vertCount[3], 3);
    assert.equal(MeshGeometry.hasUv[3], 1);
    const off = MeshGeometry.vertOffset[3];
    assert.equal(MeshGeometry.vertexX[off], 0);
    assert.equal(MeshGeometry.vertexY[off + 1], 0);
    assert.equal(MeshGeometry.uvU[off + 1], 1);
    assert.equal(MeshGeometry.indexCount[3], 3);
    assert.equal(MeshGeometry.indices[MeshGeometry.indexOffset[3] + 2], 2);
    assert.equal(MeshGeometry.vertCount[2], 0);
    assert.equal(MeshGeometry.vertOffset[2], -1);
  });

  test('nav walkability restores when the grid matches and stays put when it does not', () => {
    const config = { cellSize: 16, maxFlowfields: 1, maxPaths: 1, maxPathLength: 4 };
    const size = NavGrid.calculateSABSize(config, 2, 2);
    const sab = new SharedArrayBuffer(size);
    NavGrid.writeHeader(sab, config, 2, 2);
    NavGrid.initialize(sab, { worldWidth: 32, worldHeight: 32 });
    const walk = NavGrid.getWalkabilityArray();
    walk[0] = 1;
    walk[1] = 0;
    walk[2] = 2;
    walk[3] = 1;

    const decoded = roundtrip({ nav: packNav() });
    walk.fill(9);
    applyNav(decoded.nav);
    assert.deepEqual([...NavGrid.getWalkabilityArray()], [1, 0, 2, 1]);

    NavGrid.getWalkabilityArray().fill(7);
    const warns = silenceWarn(() => {
      applyNav({
        gridWidth: 3,
        gridHeight: 2,
        cellSize: 16,
        walkability: Uint8Array.from([0, 0, 0, 0]),
      });
    });
    assert.deepEqual([...NavGrid.getWalkabilityArray()], [7, 7, 7, 7]);
    assert.ok(warns.some((w) => w.includes('dimension mismatch')));
  });

  test('time scale 0 and 2 survive the setter', () => {
    const sab = new SharedArrayBuffer(4);
    new Float32Array(sab)[0] = 1;
    Time.bind(sab);
    applyTime(0);
    assert.equal(Time.scale, 0);
    applyTime(2);
    assert.equal(Time.scale, 2);
    const decoded = roundtrip({ timeScale: packTime() });
    applyTime(0);
    applyTime(decoded.timeScale);
    assert.equal(Time.scale, 2);
    Time.unbind();
  });

  test('tweens remap paint entities, keep zoom entities, and drop a missing target', () => {
    const n = 4;
    Tween.bind(new SharedArrayBuffer(tweenBufferBytes(n)), n);
    Atomics.store(Tween.active, 0, 1);
    Tween.kind[0] = TWEEN_KIND_PAINT;
    Tween.entity[0] = 3;
    Tween.ease[0] = 1;
    Tween.mask[0] = 1;
    Tween.duration[0] = 100;
    Tween.elapsed[0] = 40;
    Tween.from0[0] = 0.25;
    Tween.to0[0] = 1;
    Atomics.store(Tween.active, 1, 1);
    Tween.kind[1] = TWEEN_KIND_ZOOM;
    Tween.entity[1] = 7;
    Tween.duration[1] = 50;
    Tween.elapsed[1] = 10;
    Atomics.store(Tween.active, 2, 1);
    Tween.kind[2] = TWEEN_KIND_PAINT;
    Tween.entity[2] = 9;
    Tween.duration[2] = 80;

    const decoded = roundtrip({ tweens: packTweens() });
    applyTweens(decoded.tweens, (id) => (id === 3 ? 8 : null));

    assert.equal(Atomics.load(Tween.active, 0), 1);
    assert.equal(Tween.kind[0], TWEEN_KIND_PAINT);
    assert.equal(Tween.entity[0], 8);
    assert.equal(Tween.elapsed[0], 40);
    assert.equal(Tween.from0[0], 0.25);
    assert.equal(Atomics.load(Tween.active, 1), 1);
    assert.equal(Tween.kind[1], TWEEN_KIND_ZOOM);
    assert.equal(Tween.entity[1], 7);
    assert.equal(Atomics.load(Tween.active, 2), 0);
    Tween.unbind();
  });

  test('entityId fields and camera follow remap through the restore map', () => {
    const Marked = class TargetComp extends Component {
      static ARRAY_SCHEMA = {
        target: { type: Uint16Array, entityId: true },
        targets: { type: Uint16Array, length: 2, entityId: true },
        note: Uint16Array,
      };
    };
    const Plain = class TargetComp extends Component {
      static ARRAY_SCHEMA = {
        target: Uint16Array,
        targets: { type: Uint16Array, length: 2 },
        note: Uint16Array,
      };
    };
    assert.equal(Marked.name, Plain.name);
    assert.notEqual(componentSchemaFingerprint(Marked), componentSchemaFingerprint(Plain));

    const Host = { _componentClassMap: { Marked } };
    Marked.initializeArrays(new SharedArrayBuffer(Marked.getBufferSize(4)), 4);
    Marked.note[1] = 5;
    const mapGet = (id) => {
      if (id === 5) return 2;
      if (id === 0) return 4;
      return null;
    };
    remapEntityIdFields(Host, 1, {
      Marked: { fields: { target: 5, targets: [0, entityIdNone], note: 5 } },
    }, mapGet);
    remapEntityIdFields(Host, 2, {
      Marked: { fields: { target: 9 } },
    }, mapGet);

    assert.equal(Marked.target[1], 2);
    assert.equal(Marked.targets[2], 4);
    assert.equal(Marked.targets[3], entityIdNone);
    assert.equal(Marked.note[1], 5);
    assert.equal(Marked.target[2], entityIdNone);

    const cam = new Array(16).fill(0);
    cam[Camera.IDX_FOLLOW_ENTITY] = 6;
    remapCameraFollow(cam, (id) => (id === 5 ? 2 : null));
    assert.equal(cam[Camera.IDX_FOLLOW_ENTITY], 3);

    cam[Camera.IDX_FOLLOW_ENTITY] = 0;
    remapCameraFollow(cam, () => 2);
    assert.equal(cam[Camera.IDX_FOLLOW_ENTITY], 0);

    cam[Camera.IDX_FOLLOW_ENTITY] = 4;
    remapCameraFollow(cam, () => null);
    assert.equal(cam[Camera.IDX_FOLLOW_ENTITY], 0);
  });
});
