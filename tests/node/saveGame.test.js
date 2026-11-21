import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SAVE_MAGIC,
  SAVE_FORMAT_VERSION,
  isEntityClassSerializable,
  shouldSaveEntity,
  encodeSaveUncompressed,
  decodeSaveUncompressed,
  encodeSave,
  decodeSave,
  applyEntitySaveRestore,
  componentSchemaFingerprint,
} from '../../src/core/save/entitySaveSnapshot.js';
import { Component } from '../../src/core/component.js';
import { entityTable, tableField } from '../helpers/saveTable.mjs';

class FakeSerializable extends Component {
  static ARRAY_SCHEMA = {
    active: Uint8Array,
    hp: Float32Array,
  };
}

class FakeStatic extends Component {
  static ARRAY_SCHEMA = {
    active: Uint8Array,
  };
}

class FakeEntity {
  static serializable = true;
  static name = 'FakeEntity';
  static _componentClassMap = {
    FakeSerializable,
  };
}

class OtherEntity {
  static name = 'OtherEntity';
  static _componentClassMap = {
    FakeStatic,
  };
}

function samplePayload(overrides = {}) {
  return {
    sceneName: 'TestScene',
    engineVersion: '0.0.0-test',
    layout: { types: [{ name: 'FakeEntity', poolSize: 10 }], totalEntityCount: 10 },
    camera: [1, 2, 3, 4, 5, 6],
    sun: null,
    entities: [
      entityTable('FakeEntity', [7], {
        FakeSerializable: { fingerprint: 1, fields: { active: Uint8Array.of(1), hp: Float32Array.of(42.5) } },
      }),
    ],
    joints: [],
    liquidFun: null,
    decals: null,
    ...overrides,
  };
}

test('isEntityClassSerializable respects static flag', () => {
  assert.equal(isEntityClassSerializable(FakeEntity), true);
  assert.equal(isEntityClassSerializable(OtherEntity), false);
});

test('shouldSaveEntity requires serializable + active', () => {
  const active = new Uint8Array([0, 1, 1]);
  assert.equal(shouldSaveEntity(FakeEntity, 0, { active }), false);
  assert.equal(shouldSaveEntity(FakeEntity, 1, { active }), true);
  assert.equal(shouldSaveEntity(OtherEntity, 1, { active }), false);
});

test('a serializable class can leave some of its entities out of a save (N-5)', () => {
  class Chunk {
    static serializable = true;
    static shouldSaveEntity(i) {
      return i !== 1;
    }
  }
  const active = new Uint8Array([1, 1, 1]);
  assert.equal(shouldSaveEntity(Chunk, 0, { active }), true);
  assert.equal(shouldSaveEntity(Chunk, 1, { active }), false);
  assert.equal(shouldSaveEntity(Chunk, 2, { active }), true);
});

test('SAVE_FORMAT_VERSION is 7 (N-314: decal tiles deflated; E-539: entities by columns)', () => {
  assert.equal(SAVE_FORMAT_VERSION, 7);
});

test('binary uncompressed roundtrip', () => {
  const payload = samplePayload();
  const bytes = encodeSaveUncompressed(payload);
  const decoded = decodeSaveUncompressed(bytes);
  assert.equal(decoded.magic, SAVE_MAGIC);
  assert.equal(decoded.formatVersion, 7);
  assert.equal(decoded.sceneName, 'TestScene');
  assert.equal(decoded.entities.length, 1);
  assert.deepEqual([...decoded.entities[0].indices], [7]);
  const hp = tableField(decoded.entities[0], 'FakeSerializable', 'hp');
  assert.ok(hp instanceof Float32Array, 'a column comes back as its own kind');
  assert.equal(hp[0], 42.5);
  assert.equal(decoded.entities[0].components[0].fingerprint, 1);
  assert.deepEqual(decoded.camera, [1, 2, 3, 4, 5, 6]);
});

test('binary deflate roundtrip', async () => {
  const payload = samplePayload({
    entities: [entityTable('A', [0])],
    camera: null,
    layout: { types: [], totalEntityCount: 0 },
  });
  const compressed = await encodeSave(payload);
  assert.ok(compressed.byteLength > 0);
  const decoded = await decodeSave(compressed);
  assert.equal(decoded.entities[0].typeName, 'A');
  assert.equal(decoded.formatVersion, 7);
});

test('applyEntitySaveRestore writes a row of SoA fields', () => {
  const sab = new SharedArrayBuffer(FakeSerializable.getBufferSize(4));
  FakeSerializable.initializeArrays(sab, 4);
  FakeSerializable.active[2] = 0;
  FakeSerializable.hp[2] = 0;

  const table = entityTable('FakeEntity', [5, 6], {
    FakeSerializable: {
      fingerprint: componentSchemaFingerprint(FakeSerializable),
      fields: { active: Uint8Array.of(0, 1), hp: Float32Array.of(7, 99) },
    },
  });
  applyEntitySaveRestore(2, FakeEntity, { table, row: 1 });

  assert.equal(FakeSerializable.active[2], 1);
  assert.equal(FakeSerializable.hp[2], 99);
});

test('decode rejects bad magic', () => {
  assert.throws(() => decodeSaveUncompressed(new Uint8Array([1, 2, 3, 4])), /magic/);
});

test('decode rejects wrong format version', () => {
  const good = encodeSaveUncompressed(samplePayload());
  // Flip version u32 after magic
  const bad = good.slice();
  const magicLen = new TextEncoder().encode(SAVE_MAGIC).length;
  new DataView(bad.buffer, bad.byteOffset, bad.byteLength).setUint32(magicLen, 2, true);
  assert.throws(() => decodeSaveUncompressed(bad), /formatVersion/);
});

test('isEntityClassSerializable own false wins over ancestor true', () => {
  class Parent {
    static serializable = true;
  }
  class GhostChild extends Parent {
    static serializable = false;
  }
  assert.equal(isEntityClassSerializable(Parent), true);
  assert.equal(isEntityClassSerializable(GhostChild), false);
});

test('joints + entityIndex binary roundtrip', () => {
  const payload = samplePayload({
    layout: { types: [], totalEntityCount: 0 },
    camera: null,
    entities: [entityTable('MachineBox', [7]), entityTable('MachineWheel', [9])],
    joints: [
      {
        type: 4,
        entityA: 7,
        entityB: 9,
        localAnchorAX: 0,
        localAnchorAY: 0,
        localAnchorBX: 0,
        localAnchorBY: 0,
        forceThreshold: Infinity,
        torqueThreshold: Infinity,
        enableMotor: 1,
        motorSpeed: 10,
        maxMotorTorque: 100,
      },
    ],
  });
  const bytes = encodeSaveUncompressed(payload);
  const decoded = decodeSaveUncompressed(bytes);
  assert.equal(decoded.formatVersion, 7);
  assert.deepEqual([...decoded.entities[0].indices], [7]);
  assert.equal(decoded.joints.length, 1);
  assert.equal(decoded.joints[0].entityA, 7);
  assert.equal(decoded.joints[0].type, 4);
  assert.equal(decoded.joints[0].motorSpeed, 10);
});

test('liquidFun typed-array pack + binary roundtrip', async () => {
  const { packLiquidFunSnapshot, unpackLiquidFunSnapshot } = await import(
    '../../src/core/save/liquidFunSave.js'
  );
  const snap = {
    count: 2,
    radius: 8,
    maxCount: 100,
    x: new Float32Array([1, 3]),
    y: new Float32Array([2, 4]),
    vx: new Float32Array([0.1, 0.3]),
    vy: new Float32Array([0.2, 0.4]),
    flags: new Uint32Array([1, 2]),
    userData: new Uint32Array([0x80000001, 42]),
    color: new Uint32Array([0xff112233, 0xff445566]),
    groupIndex: new Int32Array([0, 0]),
    restOffset: new Float32Array([0.5, -0.5, -0.5, 0.5]),
    groups: {
      slotCount: 1,
      alive: new Uint8Array([1]),
      flags: new Uint32Array([16]),
      groupFlags: new Uint32Array([0]),
      strength: new Float32Array([0.55]),
      viscousScale: new Float32Array([1]),
      firstIndex: new Int32Array([0]),
      lastIndex: new Int32Array([2]),
    },
    pairs: {
      count: 1,
      a: new Uint16Array([0]),
      b: new Uint16Array([1]),
      flags: new Uint32Array([64]),
      distance: new Float32Array([12]),
      strength: new Float32Array([0.25]),
    },
    render: {
      tint: new Uint32Array([0xff0000, 0x00ff00]),
      textureId: new Uint16Array([1, 2]),
      scaleX: new Float32Array([1, 1]),
      scaleY: new Float32Array([1, 1]),
      alpha: new Float32Array([1, 0.5]),
      layerMask: new Uint16Array([1 << 3, 0]),
    },
    groupsLightIntensity: new Float32Array(256),
  };
  snap.groupsLightIntensity[7] = 5000;
  const packed = packLiquidFunSnapshot(snap);
  assert.ok(packed.x instanceof Float32Array);
  const unpacked = unpackLiquidFunSnapshot(packed);
  assert.equal(unpacked.count, 2);
  assert.deepEqual([...unpacked.x], [1, 3]);
  assert.deepEqual([...unpacked.y], [2, 4]);
  assert.deepEqual([...unpacked.vx], [...new Float32Array([0.1, 0.3])]);
  assert.deepEqual([...unpacked.vy], [...new Float32Array([0.2, 0.4])]);

  const payload = samplePayload({
    entities: [],
    camera: null,
    liquidFun: packed,
  });
  const decoded = decodeSaveUncompressed(encodeSaveUncompressed(payload));
  assert.equal(decoded.liquidFun.count, 2);
  assert.ok(decoded.liquidFun.x instanceof Float32Array);
  assert.deepEqual([...decoded.liquidFun.x], [1, 3]);
  assert.deepEqual([...decoded.liquidFun.y], [2, 4]);
  assert.deepEqual([...decoded.liquidFun.vx], [...new Float32Array([0.1, 0.3])]);
  assert.deepEqual([...decoded.liquidFun.vy], [...new Float32Array([0.2, 0.4])]);
  assert.deepEqual([...decoded.liquidFun.groupIndex], [0, 0]);
  assert.deepEqual([...decoded.liquidFun.userData], [0x80000001, 42]);
  assert.deepEqual([...decoded.liquidFun.color], [0xff112233, 0xff445566]);
  assert.equal(decoded.liquidFun.groups.slotCount, 1);
  assert.ok(Math.abs(decoded.liquidFun.groups.strength[0] - 0.55) < 1e-6);
  assert.equal(decoded.liquidFun.pairs.count, 1);
  assert.deepEqual([...decoded.liquidFun.render.tint], [0xff0000, 0x00ff00]);
  assert.deepEqual([...decoded.liquidFun.render.layerMask], [1 << 3, 0]);
  assert.equal(decoded.liquidFun.groupsLightIntensity[7], 5000);
});

test('decal pack/apply: deflated tiles (N-314) and raw ones, through the binary codec', async () => {
  const { Decal } = await import('../../src/core/decal.js');

  const emptyScene = { config: { particle: { decals: false } }, buffers: {} };
  assert.equal(await Decal.packSnapshot(emptyScene), null);

  const tilesX = 2;
  const tilesY = 2;
  const tilePixelSize = 4;
  const bytesPerTile = tilePixelSize * tilePixelSize * 4;
  const totalTiles = tilesX * tilesY;
  const rgbaSab = new SharedArrayBuffer(totalTiles * bytesPerTile);
  const dirtySab = new SharedArrayBuffer(totalTiles);
  const rgba = new Uint8ClampedArray(rgbaSab);
  const tile1 = 1 * bytesPerTile;
  rgba[tile1] = 200;
  rgba[tile1 + 1] = 10;
  rgba[tile1 + 2] = 10;
  rgba[tile1 + 3] = 255;

  const scene = {
    config: {
      particle: {
        decals: true,
        decalsTileSize: 256,
        decalsTilePixelSize: tilePixelSize,
      },
    },
    buffers: { decalsTilesRGBA: rgbaSab, decalsTilesDirty: dirtySab },
    decalsTilesX: tilesX,
    decalsTilesY: tilesY,
    decalsTotalTiles: totalTiles,
  };

  const packed = await Decal.packSnapshot(scene);
  assert.ok(packed);
  assert.equal(packed.tiles.length, 1);
  assert.equal(packed.tiles[0].i, 1);
  assert.equal(packed.tiles[0].fmt, 'deflate');
  assert.ok(packed.tiles[0].bytes instanceof Uint8Array);

  const rgbaSab2 = new SharedArrayBuffer(totalTiles * bytesPerTile);
  const dirtySab2 = new SharedArrayBuffer(totalTiles);
  const scene2 = {
    config: {
      particle: {
        decals: true,
        decalsTileSize: 256,
        decalsTilePixelSize: tilePixelSize,
      },
    },
    buffers: { decalsTilesRGBA: rgbaSab2, decalsTilesDirty: dirtySab2 },
    decalsTilesX: tilesX,
    decalsTilesY: tilesY,
    decalsTotalTiles: totalTiles,
  };

  const result = await Decal.applySnapshot(scene2, packed);
  assert.equal(result.ok, true);
  assert.equal(result.restored, 1);
  const out = new Uint8ClampedArray(rgbaSab2);
  assert.equal(out[tile1], 200);
  assert.equal(out[tile1 + 3], 255);
  assert.equal(new Uint8Array(dirtySab2)[1], 1);

  const decoded = decodeSaveUncompressed(
    encodeSaveUncompressed(samplePayload({ entities: [], camera: null, decals: packed }))
  );
  assert.equal(decoded.decals.tiles[0].i, 1);
  assert.equal(decoded.decals.tiles[0].fmt, 'deflate');
  assert.deepEqual([...decoded.decals.tiles[0].bytes], [...packed.tiles[0].bytes]);

  // A save kept in memory: the tile's RGBA bytes as they are.
  const raw = await Decal.packSnapshot(scene, { compress: false });
  assert.equal(raw.tiles[0].fmt, 'raw');
  const rawDecoded = decodeSaveUncompressed(
    encodeSaveUncompressed(samplePayload({ entities: [], camera: null, decals: raw }))
  );
  assert.equal(rawDecoded.decals.tiles[0].fmt, 'raw');
  assert.ok(rawDecoded.decals.tiles[0].bytes instanceof Uint8Array);
  assert.equal(rawDecoded.decals.tiles[0].bytes[0], 200);
  assert.equal(rawDecoded.decals.tiles[0].bytes.byteLength, bytesPerTile);
});
