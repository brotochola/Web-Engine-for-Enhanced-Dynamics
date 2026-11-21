import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSaveWorld, savedColumnsChecksum, savedColumnsOf, liveIndicesOf } from '../helpers/saveWorld.mjs';
import { Component } from '../../src/core/component.js';
import { GameObject } from '../../src/core/gameObject.js';
import { Transform } from '../../src/components/transform.js';
import { RigidBody } from '../../src/components/rigidBody.js';
import { Collider } from '../../src/components/collider.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { ShadowCaster } from '../../src/components/shadowCaster.js';
import { LightEmitter } from '../../src/components/lightEmitter.js';
import { DirectionalSprite } from '../../src/components/directionalSprite.js';
import { Joint } from '../../src/core/joint.js';
import { Decal } from '../../src/core/decal.js';
import { captureSavePayload, applySavePayloadToScene, encodeSave, decodeSave, savedEntityCount } from '../../src/core/save/saveGame.js';
import { encodeBinarySaveBody, decodeBinarySaveBody } from '../../src/core/save/binarySaveCodec.js';
import { componentSchemaFingerprint } from '../../src/core/save/entitySaveSnapshot.js';
import { entityIdNone } from '../../src/util/entityIdWidth.js';

// E-539: a save holds its entities by columns, one table per type, and a load writes every saved column back bit for
// bit: each of a column's elements as the same bits (a NaN's payload, -0, a signalling NaN), in every kind a schema
// can declare, on the GPU loss's path (the payload as built), a stored save's (through the codec) and a player's (new
// indices, entity ids remapped). The world is the save kernel's (tests/helpers/saveWorld.mjs): the scene's buffers,
// a real logic worker as logic0, and every message cloned as postMessage clones it.

class Gauge extends Component {
  static ARRAY_SCHEMA = {
    tiny: Int8Array,
    small: Int16Array,
    word: Uint32Array,
    signed: Int32Array,
    wide: Float64Array,
    clamp: Uint8ClampedArray,
    triple: { type: Float32Array, length: 3 },
  };
}

class Link extends Component {
  static ARRAY_SCHEMA = {
    target: { type: Uint16Array, entityId: true },
    pair: { type: Uint16Array, length: 2, entityId: true },
    note: Uint16Array,
  };
}

class Crate extends GameObject {
  static serializable = true;
  static components = [RigidBody, Collider, SpriteRenderer, Gauge];
}

class Walker extends GameObject {
  static serializable = true;
  static components = [RigidBody, Collider, DirectionalSprite, ShadowCaster, Link];
  mood = 'calm';
}

class Lamp extends GameObject {
  static components = [SpriteRenderer, LightEmitter];
}

/** Set up by logic1 when the scene has two logic workers (a player's load hands its spawns there). */
class Pinned extends GameObject {
  static serializable = true;
  static forceProcessOnLogicWorker = 1;
  static components = [SpriteRenderer, Gauge];
}

const ENTRIES = [
  { class: Crate, pool: 40, live: 30 },
  { class: Walker, pool: 40, live: 25 },
  { class: Lamp, pool: 10, live: 6 },
  { class: Pinned, pool: 10, live: 4 },
];

const world = await buildSaveWorld(ENTRIES, {
  seed: 0xc01d,
  config: {
    physics: { maxJoints: 8 },
    particle: { maxParticles: 0, decals: true, decalsTileSize: 256, decalsTilePixelSize: 4, swayFrequencyBuckets: 0 },
  },
});
const { scene, logic } = world;

/** Write raw bits into a float column at entity i. */
function bits32(arr, i, word) {
  new Uint32Array(arr.buffer, arr.byteOffset, arr.length)[i] = word;
}

const crates = liveIndicesOf(Crate);
const walkers = liveIndicesOf(Walker);
// Bits a value-by-value copy would lose: a quiet NaN with a payload, a signalling NaN, -0, an f64 NaN's payload.
bits32(Gauge.triple, crates[0] * 3 + 1, 0x7fc00abc);
bits32(SpriteRenderer.alpha, crates[1], 0x7fa00001);
SpriteRenderer.scaleX[crates[2]] = -0;
new Uint32Array(Gauge.wide.buffer, Gauge.wide.byteOffset, Gauge.wide.length * 2).set([0x00000123, 0x7ff80000], crates[3] * 2);
bits32(Transform.x, crates[4], 0xffc00007);
// Ids: Walker 0 aims at Walker 1 and pairs with a Crate and none; Walker 1 aims at a Lamp, which a player's save leaves.
Link.target[walkers[0]] = walkers[1];
Link.pair[walkers[0] * 2] = crates[5];
Link.pair[walkers[0] * 2 + 1] = entityIdNone;
Link.target[walkers[1]] = liveIndicesOf(Lamp)[0];

/** Every saved column's bits of entity i of C, by column, as hex words. */
function rowBits(C, i) {
  const out = {};
  for (const col of savedColumnsOf(C)) {
    const bytes = new Uint8Array(col.arr.buffer, col.arr.byteOffset, col.arr.byteLength);
    const stride = col.arr.BYTES_PER_ELEMENT * col.length;
    out[`${col.K.name}.${col.field}`] = Array.from(bytes.subarray(i * stride, (i + 1) * stride), (b) => b.toString(16)).join(' ');
  }
  return out;
}

const CAPTURE = { allEntities: true, instanceFields: true, staysPaused: true, decalsCompressed: false };

test('a save holds one table per type: indices and a column per field, in the live kinds, with fingerprints', async () => {
  const payload = await captureSavePayload(scene, CAPTURE);
  assert.deepEqual(payload.entities.map((t) => t.typeName), ['Crate', 'Walker', 'Lamp', 'Pinned']);
  assert.equal(savedEntityCount(payload), 65);
  const crate = payload.entities[0];
  assert.ok(crate.indices instanceof Uint32Array);
  assert.deepEqual([...crate.indices].sort((a, b) => a - b), crates);
  const gauge = crate.components.find((c) => c.name === 'Gauge');
  assert.equal(gauge.fingerprint, componentSchemaFingerprint(Gauge));
  const kinds = Object.fromEntries(gauge.fields.map((f) => [f.name, [f.values.constructor.name, f.length]]));
  assert.deepEqual(kinds, {
    tiny: ['Int8Array', 1],
    small: ['Int16Array', 1],
    word: ['Uint32Array', 1],
    signed: ['Int32Array', 1],
    wide: ['Float64Array', 1],
    clamp: ['Uint8ClampedArray', 1],
    triple: ['Float32Array', 3],
  });
  // Transform's pose and RigidBody's velocities are fields like the others.
  const fieldsOf = (name) => crate.components.find((c) => c.name === name).fields.map((f) => f.name);
  for (const f of ['x', 'y', 'rotC', 'rotS', 'parent', 'localX']) assert.ok(fieldsOf('Transform').includes(f), f);
  for (const f of ['vx', 'vy', 'angularVelocity', 'sleeping']) assert.ok(fieldsOf('RigidBody').includes(f), f);
  // One buffer per table: it crosses postMessage as one transferable.
  const buffers = new Set(crate.components.flatMap((c) => c.fields.map((f) => f.values.buffer)));
  assert.deepEqual([...buffers], [crate.indices.buffer]);
});

test('the decoded columns are views of the section, aligned for their kind (no copy per column)', async () => {
  const payload = await captureSavePayload(scene, CAPTURE);
  const back = decodeBinarySaveBody(encodeBinarySaveBody(payload));
  const views = back.entities.flatMap((t) => t.components.flatMap((c) => c.fields.map((f) => f.values)));
  assert.ok(views.length > 100);
  assert.equal(new Set(views.map((v) => v.buffer)).size, 1, 'every column shares the section\'s bytes');
  for (const v of views) assert.equal(v.byteOffset % v.BYTES_PER_ELEMENT, 0);
});

test('the GPU loss\'s restore (the payload as built, every entity at its own index) brings every column back bit for bit', async () => {
  const before = savedColumnsChecksum(scene);
  const rows = rowBits(Crate, crates[0]);
  const payload = await captureSavePayload(scene, CAPTURE);
  const result = await applySavePayloadToScene(scene, payload, { allTypes: true });
  assert.equal(result.restored, 65);
  assert.equal(result.failed, 0);
  assert.equal(savedColumnsChecksum(scene).checksum, before.checksum);
  assert.deepEqual(rowBits(Crate, crates[0]), rows);
  assert.equal(new Uint32Array(SpriteRenderer.alpha.buffer, SpriteRenderer.alpha.byteOffset)[crates[1]], 0x7fa00001);
  assert.ok(Object.is(SpriteRenderer.scaleX[crates[2]], -0));
});

test('a stored save (through the codec and deflate) brings every column back bit for bit, NaN payloads included', async () => {
  const before = savedColumnsChecksum(scene);
  const decoded = await decodeSave(await encodeSave(await captureSavePayload(scene, CAPTURE)));
  assert.equal(decoded.formatVersion, 7);
  await applySavePayloadToScene(scene, decoded, { allTypes: true });
  assert.equal(savedColumnsChecksum(scene).checksum, before.checksum);
  const words = new Uint32Array(Gauge.wide.buffer, Gauge.wide.byteOffset, Gauge.wide.length * 2);
  assert.deepEqual([words[crates[3] * 2], words[crates[3] * 2 + 1]], [0x00000123, 0x7ff80000]);
  assert.equal(new Uint32Array(Transform.x.buffer, Transform.x.byteOffset)[crates[4]], 0xffc00007);
});

test('a hot reload\'s restore brings the instances\' plain fields back on their entities', async () => {
  const w = walkers[2];
  const inst = GameObject.get(w);
  assert.ok(inst instanceof Walker);
  inst.mood = 'angry';
  const decoded = await decodeSave(await encodeSave(await captureSavePayload(scene, CAPTURE)));
  inst.mood = 'reset by the reload';
  await applySavePayloadToScene(scene, decoded, { allTypes: true });
  assert.equal(logic.gameObjects[w].mood, 'angry');
});

test('a player\'s save restores at new indices: every column at its entity\'s new index, entity ids remapped', async () => {
  const lamp = liveIndicesOf(Lamp)[0];
  const savedRows = new Map();
  for (const C of [Crate, Walker]) for (const i of liveIndicesOf(C)) savedRows.set(i, rowBits(C, i));
  const jointA = walkers[0];
  const jointB = walkers[3];
  Joint.addDistance({ entityA: jointA, entityB: jointB, length: 40 });
  // A player's save: the serializable types only, through the codec.
  const decoded = await decodeSave(await encodeSave(await captureSavePayload(scene, { staysPaused: true, decalsCompressed: false })));
  assert.deepEqual(decoded.entities.map((t) => t.typeName), ['Crate', 'Walker', 'Pinned']);
  // Something takes the slots the saved entities had: the load puts them elsewhere.
  for (let k = 0; k < 5; k++) GameObject._spawnAt(Crate, { x: 0, y: 0, _hotRestore: true }, -1, false);
  logic.processListUpdates();
  const result = await applySavePayloadToScene(scene, decoded);
  assert.equal(result.restored, 59);
  const moved = new Map();
  for (let k = 0; k < result.idPairs.length; k += 2) moved.set(result.idPairs[k], result.idPairs[k + 1]);
  assert.ok([...moved].some(([old, neu]) => old !== neu), 'some entities came back at other indices');
  const ids = new Set(['Link.target', 'Link.pair']);
  for (const [old, neu] of moved) {
    if (old >= Pinned.startIndex) continue;
    const C = old >= Walker.startIndex && old < Walker.endIndex ? Walker : Crate;
    const now = rowBits(C, neu);
    const was = savedRows.get(old);
    for (const key of Object.keys(was)) if (!ids.has(key)) assert.equal(now[key], was[key], `${C.name} ${old} -> ${neu}: ${key}`);
  }
  const w0 = moved.get(walkers[0]);
  assert.equal(Link.target[w0], moved.get(walkers[1]), 'an id of a restored entity follows it');
  assert.equal(Link.pair[w0 * 2], moved.get(crates[5]));
  assert.equal(Link.pair[w0 * 2 + 1], entityIdNone, 'none stays none');
  assert.equal(Link.target[moved.get(walkers[1])], entityIdNone, `a Lamp (${lamp}) is not in a player's save: its id is none`);
  const joints = Joint.serializeActive();
  assert.equal(joints.length, 1);
  assert.deepEqual([joints[0].entityA, joints[0].entityB], [moved.get(jointA), moved.get(jointB)]);
});

test('a column whose kind changed since the save is copied value by value, with one warning per type and component', async () => {
  const payload = await captureSavePayload(scene, CAPTURE);
  const crate = payload.entities.find((t) => t.typeName === 'Crate');
  const gauge = crate.components.find((c) => c.name === 'Gauge');
  const small = gauge.fields.find((f) => f.name === 'small');
  small.values = Float32Array.from(small.values, (v, k) => k + 0.75); // the save had floats here
  gauge.fingerprint = 1;
  const warnings = [];
  const warn = console.warn;
  console.warn = (...a) => warnings.push(a.join(' '));
  try {
    await applySavePayloadToScene(scene, payload, { allTypes: true });
  } finally {
    console.warn = warn;
  }
  assert.equal(warnings.filter((w) => /schema drift for Gauge on Crate/.test(w)).length, 1);
  for (let r = 0; r < crate.indices.length; r++) assert.equal(Gauge.small[crate.indices[r]], r, 'converted as Int16Array stores it');
});

test('the decal tiles come back with the entities', async () => {
  const rgba = new Uint8Array(scene.buffers.decalsTilesRGBA);
  rgba.fill(0);
  rgba.set([200, 10, 20, 255], 16 * 4 * 3);
  const decoded = await decodeSave(await encodeSave(await captureSavePayload(scene, CAPTURE)));
  assert.equal(decoded.decals.tiles.length, 1);
  rgba.fill(0);
  await applySavePayloadToScene(scene, decoded, { allTypes: true });
  assert.deepEqual([...rgba.subarray(16 * 4 * 3, 16 * 4 * 3 + 4)], [200, 10, 20, 255]);
  assert.ok(Decal);
});

test('a player\'s load hands a pinned class\'s spawns to its worker with a row of its own, which that worker writes', async () => {
  const saved = new Map(liveIndicesOf(Pinned).map((i) => [i, rowBits(Pinned, i)]));
  const decoded = await decodeSave(await encodeSave(await captureSavePayload(scene, { staysPaused: true, decalsCompressed: false })));
  const sent = [];
  const prev = { total: logic.totalLogicWorkers, send: logic.sendDataToWorker };
  logic.totalLogicWorkers = 2;
  // N-327: the load waits on a barrier to logic1, after the spawns, before its remaps; this test answers it.
  logic.sendDataToWorker = (to, msg) => {
    const m = structuredClone(msg);
    if (m.msg === 'restoreBarrier') {
      assert.equal(to, 'logic1');
      setImmediate(() => logic.handleCustomMessage({ msg: 'restoreBarrierAck', id: m.id, _fromWorker: to }));
    } else sent.push({ to, msg: m });
    return true;
  };
  let result;
  try {
    result = await applySavePayloadToScene(scene, decoded);
  } finally {
    logic.totalLogicWorkers = prev.total;
    logic.sendDataToWorker = prev.send;
  }
  assert.equal(sent.length, 4, 'every Pinned spawn went to logic1');
  for (const { to, msg } of sent) {
    assert.equal(to, 'logic1');
    const restore = msg.spawnConfig._saveRestore;
    assert.equal(restore.row, 0);
    assert.equal(restore.table.indices.length, 1, 'one row, not the whole table');
  }
  // logic1 sets them up, from its message (the same realm here: logic0 plays logic1).
  logic.workerIndex = 1;
  try {
    for (const { msg } of sent) logic._mainThreadSpawn(msg);
  } finally {
    logic.workerIndex = 0;
  }
  const moved = new Map();
  for (let k = 0; k < result.idPairs.length; k += 2) moved.set(result.idPairs[k], result.idPairs[k + 1]);
  for (const [old, was] of saved) assert.deepEqual(rowBits(Pinned, moved.get(old)), was, `Pinned ${old} -> ${moved.get(old)}`);
});
