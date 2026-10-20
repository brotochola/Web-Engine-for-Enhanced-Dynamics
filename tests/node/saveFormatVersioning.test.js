import test from 'node:test';
import assert from 'node:assert/strict';

import { encodeBinarySaveBody, decodeBinarySaveBody, SECTION } from '../../src/core/save/binarySaveCodec.js';
import { SharedResource } from '../../src/core/sharedResource.js';
import { Transform } from '../../src/components/transform.js';
import {
  packSharedResources,
  applySharedResources,
  sharedResourceFingerprint,
} from '../../src/core/save/worldBufferSave.js';
import { componentSchemaFingerprint } from '../../src/core/save/entitySaveSnapshot.js';
import { fnv1a32 } from '../../src/core/save/schemaHash.js';

// B23 (part). CHAINS, FIXTURES and MESHES had no layout byte, so their records
// could never change without misreading older saves; they are now CHAINS2 /
// FIXTURES2 / MESHES2 with one (the old tags still load). Shared resources
// matched on name and byte size only, so a same-size schema change restored
// bytes into the wrong fields; SHARED_RESOURCES2 carries a schema fingerprint.

const base = () => ({
  sceneName: 'T',
  engineVersion: '0',
  layout: { types: [], totalEntityCount: 0 },
  camera: null,
  sun: null,
  entities: [],
  joints: [],
});

/** Body framing: u16 section count, then u16 tag, u32 length, bytes (LE). */
function sections(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = v.getUint16(0, true);
  const out = [];
  let o = 2;
  for (let i = 0; i < n; i++) {
    const tag = v.getUint16(o, true);
    const len = v.getUint32(o + 2, true);
    out.push({ tag, body: bytes.slice(o + 6, o + 6 + len) });
    o += 6 + len;
  }
  return out;
}

function assemble(list) {
  let size = 2;
  for (const s of list) size += 6 + s.body.byteLength;
  const out = new Uint8Array(size);
  const v = new DataView(out.buffer);
  v.setUint16(0, list.length, true);
  let o = 2;
  for (const s of list) {
    v.setUint16(o, s.tag, true);
    v.setUint32(o + 2, s.body.byteLength, true);
    out.set(s.body, o + 6);
    o += 6 + s.body.byteLength;
  }
  return out;
}

const chain = { entityIndex: 3, loop: 1, count: 4, xy: new Float32Array([0, 0, 10, 0, 10, 10, 0, 10]) };

test('chains, fixtures and meshes are written with a layout byte and read back', () => {
  const bytes = new Uint8Array(encodeBinarySaveBody({
    ...base(),
    chains: [chain],
    fixtures: [{ entityIndex: 1, counts: new Uint8Array([3]), xy: new Float32Array([0, 0, 1, 0, 0, 1]) }],
    meshes: [],
  }));
  const tags = sections(bytes).map((s) => s.tag);
  assert.ok(tags.includes(SECTION.CHAINS2) && !tags.includes(SECTION.CHAINS));
  assert.ok(tags.includes(SECTION.FIXTURES2) && tags.includes(SECTION.MESHES2));
  for (const s of sections(bytes)) {
    if ([SECTION.CHAINS2, SECTION.FIXTURES2, SECTION.MESHES2].includes(s.tag)) assert.equal(s.body[0], 1, 'layout 1');
  }
  const back = decodeBinarySaveBody(bytes);
  assert.equal(back.chains[0].entityIndex, 3);
  assert.deepEqual(Array.from(back.chains[0].xy), Array.from(chain.xy));
  assert.equal(back.fixtures.length, 1);
  assert.deepEqual(back.meshes, []);
});

test('a save with the old CHAINS tag (no layout byte) still loads', () => {
  const list = sections(new Uint8Array(encodeBinarySaveBody({ ...base(), chains: [chain] })));
  const legacy = list.map((s) => (s.tag === SECTION.CHAINS2 ? { tag: SECTION.CHAINS, body: s.body.slice(1) } : s));
  const back = decodeBinarySaveBody(assemble(legacy));
  assert.equal(back.chains.length, 1);
  assert.equal(back.chains[0].count, 4);
});

test('a layout newer than this build reads as an absent section', () => {
  const list = sections(new Uint8Array(encodeBinarySaveBody({ ...base(), chains: [chain] })));
  const future = list.map((s) => {
    if (s.tag !== SECTION.CHAINS2) return s;
    const body = s.body.slice();
    body[0] = 2;
    return { tag: s.tag, body };
  });
  const warn = console.warn;
  const warns = [];
  console.warn = (m) => warns.push(String(m));
  try {
    assert.equal(decodeBinarySaveBody(assemble(future)).chains, null);
  } finally {
    console.warn = warn;
  }
  assert.ok(warns.some((w) => /chain section layout 2/.test(w)));
});

test('a same-size shared resource schema change is skipped, not restored into the wrong fields', () => {
  SharedResource.resetAll();
  class Stats extends SharedResource {}
  const schemaV1 = { hp: Float32Array, gold: Int32Array };
  Stats.initialize(new SharedArrayBuffer(SharedResource.getBufferSize(schemaV1)), schemaV1);
  Stats.hp[0] = 2.5;
  Stats.gold[0] = 40;
  const saved = decodeBinarySaveBody(new Uint8Array(encodeBinarySaveBody({
    ...base(),
    sharedResources: packSharedResources(),
  }))).sharedResources;
  assert.ok(saved[0].fingerprint, 'fingerprint stored');

  // The game swapped two fields; same 8 bytes.
  SharedResource.resetAll();
  const schemaV2 = { gold: Int32Array, hp: Float32Array };
  Stats.initialize(new SharedArrayBuffer(SharedResource.getBufferSize(schemaV2)), schemaV2);
  Stats.gold[0] = 7;
  const warn = console.warn;
  const warns = [];
  console.warn = (m) => warns.push(String(m));
  try {
    applySharedResources(saved);
  } finally {
    console.warn = warn;
  }
  assert.equal(Stats.gold[0], 7, 'untouched');
  assert.ok(warns.some((w) => /Stats schema changed/.test(w)));

  // Same schema: restored.
  SharedResource.resetAll();
  Stats.initialize(new SharedArrayBuffer(SharedResource.getBufferSize(schemaV1)), schemaV1);
  applySharedResources(saved);
  assert.equal(Stats.hp[0], 2.5);
  assert.equal(Stats.gold[0], 40);
  SharedResource.resetAll();
});

test('a save from before the fingerprint (tag 8) still restores on size alone', () => {
  SharedResource.resetAll();
  class Old extends SharedResource {}
  const schema = { v: Int32Array };
  Old.initialize(new SharedArrayBuffer(SharedResource.getBufferSize(schema)), schema);
  // Tag 8 body: u32 count, then u32-length name, u32-length bytes.
  const name = new TextEncoder().encode('Old');
  const body = new Uint8Array(4 + 4 + name.length + 4 + 4);
  const v = new DataView(body.buffer);
  v.setUint32(0, 1, true);
  v.setUint32(4, name.length, true);
  body.set(name, 8);
  v.setUint32(8 + name.length, 4, true);
  v.setInt32(12 + name.length, 99, true);
  const list = sections(new Uint8Array(encodeBinarySaveBody(base())));
  list.push({ tag: SECTION.SHARED_RESOURCES, body });
  const back = decodeBinarySaveBody(assemble(list));
  assert.equal(back.sharedResources[0].fingerprint, null);
  applySharedResources(back.sharedResources);
  assert.equal(Old.v[0], 99);
  SharedResource.resetAll();
});

test('fingerprints are stable', () => {
  class Probe extends SharedResource {}
  Probe._schema = { a: Float32Array, b: { type: 'Int32Array', length: 2, atomic: true } };
  assert.equal(sharedResourceFingerprint(Probe), fnv1a32('Probe|a:Float32Array:1|b:Int32Array:2:atomic'));
  // The component fingerprint moved onto fnv1a32 without changing its value.
  const parts = ['Transform'];
  for (const [n, t] of Object.entries(Transform.ARRAY_SCHEMA)) parts.push(`${n}:${t.name}:1`);
  parts.push('pose:x,y,rotC,rotS');
  let h = 2166136261;
  const s = parts.join('|');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  assert.equal(componentSchemaFingerprint(Transform), h >>> 0);
});
