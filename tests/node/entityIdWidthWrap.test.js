import test from 'node:test';
import assert from 'node:assert/strict';

import { collisionPairKey, collisionPairUnpack } from '../../src/util/utils.js';
import {
  bindEntityIdWidth,
  collisionPairKeyWide,
  collisionPairUnpackWide,
  entityIdNone,
  maxEntitiesForWidth,
  MAX_ENTITIES_U16,
  MAX_ENTITIES_U32,
} from '../../src/util/entityIdWidth.js';
import { Joint } from '../../src/core/joint.js';
import { ColliderFixture } from '../../src/core/colliderFixture.js';
import { DecorationComponent } from '../../src/components/decorationComponent.js';
import { decorationNoParent } from '../../src/core/decorationPool.js';
import { popFreeIndex, pushFreeIndex, resetFreeList } from '../../src/util/atomicFreeList.js';
import { validateSceneSharedBufferConfig } from '../../src/util/sceneSharedBuffers.js';
import { Grid } from '../../src/core/grid.js';
import { decodeBinarySaveBody, encodeBinarySaveBody } from '../../src/core/save/binarySaveCodec.js';
import {
  IDS,
  pair0,
  pair1,
  pair3Cantor,
  unpackPair0,
  unpackPair1,
  unpackPair3Cantor,
  resetFl0,
  popFl0,
  pushFl0,
  resetFl1,
  popFl1,
  pushFl1,
  resetFl2,
  popFl2,
  pushFl2,
  resetFl4,
  popFl4,
  pushFl4,
  writeNeighbor,
  readNeighbor,
  setNeighborCount,
  gridCellByteSize,
  gridGetBase,
} from '../bench/entityIdEncodings.mjs';

function makeValidationScene(totalEntityCount, entityIdWidth, extra = {}) {
  const count = totalEntityCount;
  return {
    totalEntityCount: count,
    nextComponentId: 3,
    registeredClasses: [{ class: class WrapEntity {}, startIndex: 0, count }],
    config: {
      entityIdWidth,
      worldWidth: extra.worldWidth ?? 1024,
      worldHeight: extra.worldHeight ?? 1024,
      canvasWidth: 800,
      canvasHeight: 600,
      particle: { maxParticles: 0 },
      decoration: { maxDecorations: 0 },
      bullet: { maxBullets: 0 },
      physics: { maxJoints: 0, enabled: false },
      spatial: {
        cellSize: extra.cellSize ?? 1024,
        maxNeighbors: 0,
        maxEntitiesPerCell: 8,
        rowsPerBlock: 1,
        numberOfSpatialWorkers: 0,
      },
      lighting: { enabled: false, maxLights: 0, shadowsEnabled: false },
      logic: { staggeredUpdates: false },
      debug: { maxDebugDrawEntries: 1 },
      navigation: { enabled: false },
      renderer: { maxVisibleRenderables: 8 },
      layers: {},
    },
    buffers: { componentData: {} },
    views: {},
    camera: { zoom: 1, x: 0, y: 0 },
    inputBufferSize: 1,
    keyMap: {},
    updateKeyboardBuffer() {},
  };
}

test('PAIR0 wraps 65536 onto 0; PAIR1/3 roundtrip campaign ids', () => {
  const scratch = { a: 0, b: 0 };
  assert.equal(pair0(65536, 65537), pair0(0, 1));
  assert.equal(collisionPairKey(65536, 65537), collisionPairKey(0, 1));
  collisionPairUnpack(collisionPairKey(65536, 65537), scratch);
  assert.equal(scratch.a, 0);
  assert.equal(scratch.b, 1);

  const seen1 = new Set();
  const seen3 = new Set();
  for (let i = 0; i < IDS.length; i++) {
    for (let j = 0; j < IDS.length; j++) {
      if (IDS[i] >= IDS[j]) continue;
      const minE = Math.min(IDS[i], IDS[j]);
      const maxE = Math.max(IDS[i], IDS[j]);
      const k1 = pair1(minE, maxE);
      unpackPair1(k1, scratch);
      assert.equal(scratch.a, minE);
      assert.equal(scratch.b, maxE);
      assert.equal(seen1.has(k1), false);
      seen1.add(k1);
      const k3 = pair3Cantor(minE, maxE);
      unpackPair3Cantor(k3, scratch);
      assert.equal(scratch.a, minE);
      assert.equal(scratch.b, maxE);
      assert.equal(seen3.has(k3), false);
      seen3.add(k3);
    }
  }
});

test('PAIR uniqueness: 50k pairs in the 300k range', () => {
  const seen = new Set();
  let n = 0;
  for (let a = 200000; n < 50000; a++) {
    const b = a + 17;
    if (b > 299999) break;
    const key = pair1(a, b);
    assert.equal(seen.has(key), false);
    seen.add(key);
    n++;
  }
  assert.equal(n, 50000);
  assert.equal(pair0(200000, 200017), pair0(200000 & 0xffff, 200017 & 0xffff));
});

test('FL0 local+1 wraps at pool 70000; FL1 and FL2 do not', () => {
  const n = 70000;
  const top0 = new Int32Array(new SharedArrayBuffer(8));
  const links0 = new Uint16Array(new SharedArrayBuffer(n * 2));
  resetFl0(top0, links0, n, 1);
  const first0 = popFl0(top0, links0);
  assert.notEqual(first0, n - 1, 'FL0 must not pop 69999 from a u16 link/head');

  const top1 = new Int32Array(new SharedArrayBuffer(16));
  const links1 = new Uint32Array(new SharedArrayBuffer(n * 4));
  resetFl1(top1, links1, n, 1);
  const first1 = popFl1(top1, links1);
  assert.equal(first1, n - 1);
  pushFl1(top1, links1, first1);
  assert.equal(popFl1(top1, links1), n - 1);

  const idx2 = new Int32Array(new SharedArrayBuffer(8));
  const tag2 = new Int32Array(new SharedArrayBuffer(4));
  const links2 = new Uint32Array(new SharedArrayBuffer(n * 4));
  resetFl2(idx2, tag2, links2, n, 1);
  const first2 = popFl2(idx2, tag2, links2);
  assert.equal(first2, n - 1);
  pushFl2(idx2, tag2, links2, first2);
  assert.equal(popFl2(idx2, tag2, links2), n - 1);
});

test('FL1 pop/push/batch-equivalent at 300000', () => {
  const n = 300000;
  const top = new Int32Array(new SharedArrayBuffer(16));
  const links = new Uint32Array(new SharedArrayBuffer(n * 4));
  resetFl1(top, links, n, 1);
  const got = [];
  for (let i = 0; i < 5; i++) got.push(popFl1(top, links));
  assert.deepEqual(got, [299999, 299998, 299997, 299996, 299995]);
  for (let i = got.length - 1; i >= 0; i--) pushFl1(top, links, got[i]);
  assert.equal(popFl1(top, links), got[0]);
});

test('production u32 free list (FL4) pops 299999', () => {
  const n = 300000;
  const top = new Int32Array(new SharedArrayBuffer(16));
  const links = new Uint32Array(new SharedArrayBuffer(n * 4));
  resetFreeList(top, links, n, 1);
  const first = popFreeIndex(top, links);
  assert.equal(first, 299999);
  pushFreeIndex(top, links, first);
  assert.equal(popFreeIndex(top, links), 299999);
});

test('FL4 19+13 pops 299999 and does not alias', () => {
  const n = 300000;
  const top = new Int32Array(new SharedArrayBuffer(8));
  const links = new Uint32Array(new SharedArrayBuffer(n * 4));
  resetFl4(top, links, n, 1);
  const first = popFl4(top, links);
  assert.equal(first, 299999);
  pushFl4(top, links, first);
  assert.equal(popFl4(top, links), 299999);
});

test('GRID0 truncates id 70000; GRID1 stores it', () => {
  const mec = 4;
  const cell0 = new ArrayBuffer(gridCellByteSize(mec, 2));
  const counts0 = new Uint8Array(cell0);
  const ents0 = new Uint16Array(cell0);
  counts0[0] = 1;
  ents0[gridGetBase(0, gridCellByteSize(mec, 2), 2)] = 70000;
  assert.equal(ents0[gridGetBase(0, gridCellByteSize(mec, 2), 2)], 4464);

  const cell1 = new ArrayBuffer(gridCellByteSize(mec, 4));
  const counts1 = new Uint8Array(cell1);
  const ents1 = new Uint32Array(cell1);
  counts1[0] = 1;
  ents1[gridGetBase(0, gridCellByteSize(mec, 4), 4)] = 70000;
  assert.equal(ents1[gridGetBase(0, gridCellByteSize(mec, 4), 4)], 70000);
});

test('NBR0 truncates neighbor 70000; NBR1 keeps it', () => {
  const stride = 4;
  const u16 = new Uint16Array(stride);
  setNeighborCount(u16, stride, 0, 1);
  writeNeighbor(u16, stride, 0, 0, 70000);
  assert.equal(readNeighbor(u16, stride, 0, 0), 4464);

  const u32 = new Uint32Array(stride);
  setNeighborCount(u32, stride, 0, 1);
  writeNeighbor(u32, stride, 0, 0, 70000);
  assert.equal(readNeighbor(u32, stride, 0, 0), 70000);
});

test('query snapshot Uint16 wraps 70000; Uint32 does not', () => {
  const snap16 = new Uint16Array(4);
  snap16[0] = 1;
  snap16[1] = 70000;
  assert.equal(snap16[1], 4464);
  const snap32 = new Uint32Array(4);
  snap32[0] = 1;
  snap32[1] = 70000;
  assert.equal(snap32[1], 70000);
});

test('production Grid u16 truncates addEntityToCell(70000)', () => {
  Grid.reset();
  Grid.initialize(
    {
      gridBuffer: new SharedArrayBuffer(4 + 8 * 2),
      neighborBuffer: new SharedArrayBuffer((1 + 4) * 2),
    },
    { cellSize: 64, gridWidth: 1, gridHeight: 1, maxEntitiesPerCell: 8, maxNeighbors: 4 },
  );
  assert.equal(Grid.addEntityToCell(0, 70000), true);
  assert.equal(Grid.getCellEntity(0, 0), 4464);
  Grid.setNeighbor(0, 0, 70000);
  assert.equal(Grid.getNeighbor(0, 0), 4464);
  Grid.reset();
});

test('joint-style u16 pack aliases entityB 65536 to 0', () => {
  const entityA = 10;
  const entityB = 65536;
  const packed = (entityA << 16) | (entityB & 0xffff);
  assert.equal(packed >>> 16, 10);
  assert.equal(packed & 0xffff, 0);
  const wide = pair1(entityA, entityB);
  const out = { a: 0, b: 0 };
  unpackPair1(wide, out);
  assert.equal(out.a, 10);
  assert.equal(out.b, 65536);
});

test('validateSceneSharedBufferConfig: 300k only with entityIdWidth 32', () => {
  assert.throws(
    () => validateSceneSharedBufferConfig(makeValidationScene(65536, 16)),
    /totalEntityCount must be an integer in \[0, 65535\]/,
  );
  assert.throws(
    () => validateSceneSharedBufferConfig(makeValidationScene(300000, 16)),
    /totalEntityCount must be an integer in \[0, 65535\]/,
  );
  assert.doesNotThrow(() => validateSceneSharedBufferConfig(makeValidationScene(300000, 32)));
  assert.throws(
    () => validateSceneSharedBufferConfig(makeValidationScene(300001, 32)),
    /totalEntityCount must be an integer in \[0, 300000\]/,
  );
  assert.equal(maxEntitiesForWidth(16), MAX_ENTITIES_U16);
  assert.equal(maxEntitiesForWidth(32), MAX_ENTITIES_U32);
});

test('save codec already stores entityIndex as u32 (70000 survives)', () => {
  const body = encodeBinarySaveBody({
    sceneName: 'Wrap',
    engineVersion: '0.0.0-test',
    layout: { types: [{ name: 'WrapEntity', poolSize: 80000 }], totalEntityCount: 80000 },
    camera: null,
    sun: null,
    entities: [{ typeName: 'WrapEntity', entityIndex: 70000, components: {} }],
    joints: [],
  });
  const decoded = decodeBinarySaveBody(body);
  assert.equal(decoded.entities[0].entityIndex, 70000);
});

test('packed joint leftover aliases; width 32 two-column stores 65536', () => {
  const packed = (10 << 16) | (65536 & 0xffff);
  assert.equal(packed & 0xffff, 0);

  bindEntityIdWidth(32);
  try {
    Joint.reset();
    const maxJoints = 4;
    const entityCount = 70000;
    const sab = new SharedArrayBuffer(Joint.getBufferSize(maxJoints, entityCount));
    Joint.initializeArrays(sab, maxJoints, entityCount);
    const freeListSab = new SharedArrayBuffer(maxJoints * 2);
    const freeListTopSab = new SharedArrayBuffer(8);
    resetFreeList(new Int32Array(freeListTopSab), new Uint16Array(freeListSab), maxJoints, 1);
    Joint.initialize(maxJoints);
    Joint.initializeFreeList(freeListSab, freeListTopSab);
    const idx = Joint.addDistance({ entityA: 10, entityB: 65536, length: 8 });
    assert.ok(idx >= 0);
    assert.equal(Joint.getEntityA(idx), 10);
    assert.equal(Joint.getEntityB(idx), 65536);
    assert.equal(Joint.hasBetween(10, 65536), true);
  } finally {
    Joint.reset();
    bindEntityIdWidth(16);
  }
});

test('decoration parent leftover: width 32 keeps parent 70000', () => {
  bindEntityIdWidth(32);
  try {
    const sab = new SharedArrayBuffer(DecorationComponent.getBufferSize(4));
    DecorationComponent.initializeArrays(sab, 4);
    DecorationComponent.parentEntityIndex[0] = 70000;
    assert.equal(DecorationComponent.parentEntityIndex[0], 70000);
    assert.equal(entityIdNone(), 0xffffffff);
    assert.notEqual(decorationNoParent(), 0xffff);
  } finally {
    bindEntityIdWidth(16);
  }
});

test('fixture entity leftover: width 32 keeps entity 70000', () => {
  bindEntityIdWidth(32);
  try {
    ColliderFixture.reset();
    const n = 4;
    const entities = 70001;
    const sab = new SharedArrayBuffer(ColliderFixture.getBufferSize(n, entities));
    ColliderFixture.initializeArrays(sab, n, entities);
    ColliderFixture.entity[0] = 70000;
    assert.equal(ColliderFixture.entity[0], 70000);
  } finally {
    ColliderFixture.reset();
    bindEntityIdWidth(16);
  }
});

test('wide pair helper follows bound width', () => {
  bindEntityIdWidth(16);
  assert.equal(collisionPairKeyWide(1, 2), pair0(1, 2));
  bindEntityIdWidth(32);
  try {
    const key = collisionPairKeyWide(65536, 65537);
    const out = { a: 0, b: 0 };
    collisionPairUnpackWide(key, out);
    assert.equal(out.a, 65536);
    assert.equal(out.b, 65537);
    assert.notEqual(key, pair0(0, 1));
    assert.equal(key, pair3Cantor(65536, 65537));
  } finally {
    bindEntityIdWidth(16);
  }
});
