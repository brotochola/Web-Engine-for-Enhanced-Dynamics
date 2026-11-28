import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { bindEntityIdWidth } from '../../src/util/entityIdWidth.js';
import { createSpatialPublishMemory, spatialPublishMemoryBytes } from '../../src/util/spatialPublishMemory.js';
import { resolveNeighborAggregates, writeNeighborAggregateTable } from '../../src/util/neighborAggregatesSpec.js';
import { NeighborAggregates } from '../../src/core/neighborAggregates.js';
import { publishAggregatesJs } from '../reference/neighborAggregates.mjs';

// E-199: publish_batch_agg (wasm/spatialPublish.c) publishes the rows publish_batch publishes and, for the entities of
// the types that ask, the neighbour aggregates tests/reference/neighborAggregates.mjs computes: equal to the bit, every
// mix of aggregates, both id widths, rows cut at maxNeighbors, with and without the velocity columns.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SHIPPED = path.join(root, 'src/wasm/engine.wasm');

function instantiate(memory) {
  const mod = new WebAssembly.Module(fs.readFileSync(SHIPPED));
  return new WebAssembly.Instance(mod, { env: { memory } }).exports;
}

function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Stand-in classes registered over consecutive slots, as a scene lays its pools out; the rest of the slots have none. */
function registry(defs, plainSlots) {
  const classes = {};
  for (const d of defs) classes[d.name] = { [d.name]: class {} }[d.name];
  const regs = [];
  let start = 0;
  for (const d of defs) {
    const cfg = d.aggregates ? d.aggregates(classes) : undefined;
    if (cfg) classes[d.name].neighborAggregates = cfg;
    regs.push({ class: classes[d.name], startIndex: start, count: d.count });
    start += d.count;
  }
  regs.push({ class: { Plain: class {} }.Plain, startIndex: start, count: plainSlots });
  return { regs, total: start + plainSlots };
}

const TYPES = [
  { name: 'Boid', count: 300, aggregates: () => ({ separation: { radius: 30, falloff: 'linear' }, cohesion: { minDistance: 30, velocity: true } }) },
  { name: 'Civilian', count: 300, aggregates: (c) => ({ separation: { ofType: c.Soldier, floor: 12 }, nearest: { ofType: c.Soldier, count: 4 } }) },
  { name: 'Soldier', count: 200, aggregates: (c) => ({ nearest: { ofType: c.Civilian, count: 8 } }) },
  { name: 'Herder', count: 100, aggregates: (c) => ({ cohesion: { ofType: c.Boid }, nearest: { count: 1 } }) },
  { name: 'All', count: 100, aggregates: (c) => ({ separation: { radius: 50, floor: 5 }, cohesion: { minDistance: 10, velocity: true, ofType: c.Civilian }, nearest: { ofType: c.All, count: 3 } }) },
  { name: 'Sep', count: 80, aggregates: () => ({ separation: {} }) },
  { name: 'Coh', count: 80, aggregates: () => ({ cohesion: {} }) },
  { name: 'SepNear', count: 80, aggregates: () => ({ separation: { radius: 40 }, nearest: { count: 2 } }) },
  { name: 'CohNear', count: 80, aggregates: () => ({ cohesion: { velocity: true }, nearest: { count: 16 } }) },
];

/** Fills one frame (clustered poses, ranges, velocities, a batch of every kind, candidate rows); returns its size. */
function fillFrame(v, count, maxN, seed) {
  const rnd = lcg(seed);
  const clusters = 12;
  const cx = [];
  const cy = [];
  for (let c = 0; c < clusters; c++) {
    cx.push(100 + rnd() * 800);
    cy.push(100 + rnd() * 800);
  }
  for (let e = 0; e < count; e++) {
    const c = (rnd() * clusters) | 0;
    // A few on top of each other (d² ≤ 1) and on a shared spot (ties in the nearest slots).
    const r = rnd();
    v.pos[e * 4] = r < 0.03 ? cx[c] : cx[c] + (rnd() - 0.5) * 160;
    v.pos[e * 4 + 1] = r < 0.03 ? cy[c] + 0.5 : cy[c] + (rnd() - 0.5) * 160;
    v.pos[e * 4 + 2] = rnd() * 6;
    v.range[e] = 20 + rnd() * 90;
    v.vx[e] = (rnd() - 0.5) * 300;
    v.vy[e] = (rnd() - 0.5) * 300;
  }
  const stride = 1 + maxN;
  let n = 0;
  for (let a = 0; a < count; a++) {
    if (rnd() < 0.25) continue;
    v.list[n++] = a;
    const base = a * stride;
    const candCount = Math.min(maxN, (rnd() * (maxN + 1)) | 0);
    v.cand[base] = candCount;
    for (let i = 0; i < candCount; i++) {
      let b = (rnd() * count) | 0;
      if (b === a) b = (b + 1) % count;
      v.cand[base + 1 + i] = b;
    }
  }
  return n;
}

/** The columns as NeighborAggregates binds them (the public views), kept after it is reset. */
function outputsOf(layout, buffer) {
  NeighborAggregates._bind(buffer, layout);
  const views = {};
  for (const k of ['separationX', 'separationY', 'separationCount', 'centroidX', 'centroidY', 'cohesionCount', 'averageVelocityX', 'averageVelocityY', 'nearestIndex', 'nearestDistanceSq', 'nearestCount', 'nearestSlots']) {
    views[k] = NeighborAggregates[k];
  }
  NeighborAggregates._reset();
  return views;
}

/** The same outputs in arrays of their own, for the reference. */
function ownOutputs(views) {
  const out = {};
  for (const [k, v] of Object.entries(views)) out[k] = typeof v === 'number' ? v : new v.constructor(v.length);
  return out;
}

function runCase({ idWidth, maxN, seed, velocity }) {
  bindEntityIdWidth(idWidth);
  const Ids = idWidth === 32 ? Uint32Array : Uint16Array;
  const { regs, total: count } = registry(TYPES, 400);
  const spec = resolveNeighborAggregates(regs);
  assert.ok(spec, 'some type asks for aggregates');
  // The memory with room after the regions for the velocity columns, which the kernel reads in place.
  const bytes = spatialPublishMemoryBytes(count, maxN, 1, null, spec);
  const velByte = Math.ceil(bytes / 64) * 64 + 64;
  const memory = new WebAssembly.Memory({ initial: Math.ceil((velByte + count * 8) / 65536) + 1, maximum: 32768, shared: true });
  const mem = createSpatialPublishMemory(count, maxN, 1, null, { memory, baseByte: 0 }, spec);
  assert.ok(mem && mem.aggregates, 'the memory has the aggregates regions');
  const { buffer } = mem;
  writeNeighborAggregateTable(buffer, mem.aggregates);
  const stride = 1 + maxN;
  const v = {
    pos: new Float32Array(buffer, mem.posByte, count * 4),
    range: new Float32Array(buffer, mem.rangeByte, count),
    cand: new Ids(buffer, mem.candByte, count * stride),
    list: new Ids(buffer, mem.listByte, count),
    vx: new Float32Array(buffer, velByte, count),
    vy: new Float32Array(buffer, velByte + count * 4, count),
  };
  const rows = new Ids(buffer, mem.neighborByte, count * stride);
  const n = fillFrame(v, count, maxN, seed);
  const views = outputsOf(mem.aggregates, buffer);
  // Untouched outputs hold a mark the reference holds too, so a write where none belongs shows.
  for (const [k, a] of Object.entries(views)) if (typeof a !== 'number') a.fill(k.endsWith('Count') ? 7 : k === 'nearestIndex' ? -5 : 0.25);
  rows.fill(0xbeef);

  const k = instantiate(memory);
  const fn = idWidth === 32 ? k.publish_batch_agg_u32 : k.publish_batch_agg;
  fn(n, maxN, mem.posByte, mem.rangeByte, mem.candByte, mem.neighborByte, mem.listByte, mem.aggregates.tableByte,
    velocity ? v.vx.byteOffset : 0, velocity ? v.vy.byteOffset : 0);

  // The reference, on copies.
  const ref = ownOutputs(views);
  for (const [key, a] of Object.entries(ref)) if (typeof a !== 'number') a.set(views[key].map(() => (key.endsWith('Count') ? 7 : key === 'nearestIndex' ? -5 : 0.25)));
  const refRows = new Ids(count * stride).fill(0xbeef);
  const io = { pos: Float32Array.from(v.pos), range: Float32Array.from(v.range), cand: Ids.from(v.cand), rows: refRows };
  const classOf = new Uint8Array(count);
  spec.classes.forEach((t, c) => classOf.fill(c + 1, t.startIndex, t.endIndex));
  const plainCtx = { stride, maxN };
  const refVx = velocity ? Float32Array.from(v.vx) : null;
  const refVy = velocity ? Float32Array.from(v.vy) : null;
  let withAgg = 0;
  for (let q = 0; q < n; q++) {
    const a = v.list[q];
    const c = classOf[a];
    if (c === 0) {
      plainRow(a, io, plainCtx);
      continue;
    }
    withAgg++;
    publishAggregatesJs(a, io, maxN, spec.classes[c - 1], ref, refVx, refVy);
  }
  assert.ok(withAgg > 500 && withAgg < n, `both kinds of rows in the batch (${withAgg} of ${n})`);

  const label = JSON.stringify({ idWidth, maxN, seed, velocity });
  assert.deepEqual(Array.from(rows), Array.from(refRows), `${label}: rows`);
  for (const [key, a] of Object.entries(views)) {
    if (typeof a === 'number') continue;
    const b = ref[key];
    for (let i = 0; i < a.length; i++) {
      if (!Object.is(a[i], b[i])) assert.fail(`${label}: ${key}[${i}] kernel ${a[i]} reference ${b[i]}`);
    }
  }

  // The plain publish_batch publishes the same rows.
  rows.fill(0xbeef);
  (idWidth === 32 ? k.publish_batch_u32 : k.publish_batch)(n, maxN, mem.posByte, mem.rangeByte, mem.candByte, mem.neighborByte, mem.listByte);
  assert.deepEqual(Array.from(rows), Array.from(refRows), `${label}: publish_batch's rows`);
  bindEntityIdWidth(16);
  return { views, ref, spec, count, n };
}

/** publish_batch's row in JS (publishFilteredNeighborsJs' predicate). */
function plainRow(a, io, { stride, maxN }) {
  const { pos, range, cand, rows } = io;
  const base = a * stride;
  const myX = pos[a * 4];
  const myY = pos[a * 4 + 1];
  let published = 0;
  for (let i = 0; i < cand[base] && published < maxN; i++) {
    const b = cand[base + 1 + i];
    const dx = pos[b * 4] - myX;
    const dy = pos[b * 4 + 1] - myY;
    const er = range[a] + pos[b * 4 + 2];
    if (dx * dx + dy * dy < er * er) rows[base + 1 + published++] = b;
  }
  rows[base] = published;
}

test('publish_batch_agg writes the rows and the aggregates the JS reference computes, to the bit', () => {
  for (const cfg of [
    { idWidth: 16, maxN: 128, seed: 1, velocity: true },
    { idWidth: 16, maxN: 128, seed: 2, velocity: false },
    { idWidth: 16, maxN: 9, seed: 3, velocity: true }, // rows cut at maxNeighbors
    { idWidth: 32, maxN: 64, seed: 4, velocity: true },
    { idWidth: 32, maxN: 5, seed: 5, velocity: false },
  ]) {
    const { views, spec } = runCase(cfg);
    const label = JSON.stringify(cfg);
    // The cases are not empty: each output was written with something in it.
    const sum = (a) => a.reduce((s, x) => s + x, 0);
    assert.ok(sum(views.separationCount) > 0 && sum(views.cohesionCount) > 0 && sum(views.nearestCount) > 0, `${label}: counts`);
    assert.equal(views.nearestSlots, 16, 'the widest nearest.count sets the slots');
    assert.equal(spec.classes.length, TYPES.length);
  }
});

test('the nearest slots hold the K nearest of the type, ascending; separation and cohesion match their definitions', () => {
  const { views, spec, count } = runCase({ idWidth: 16, maxN: 128, seed: 11, velocity: true });
  const soldier = spec.classes.find((t) => t.name === 'Soldier');
  const K = views.nearestSlots;
  let checked = 0;
  for (let i = soldier.startIndex; i < soldier.endIndex; i++) {
    const c = views.nearestCount[i];
    if (c === 7) continue; // not in the batch
    assert.ok(c <= soldier.nearK);
    for (let s = 0; s < c; s++) {
      const j = views.nearestIndex[i * K + s];
      assert.ok(j >= soldier.nearLo && j < soldier.nearLo + soldier.nearSpan, 'a civilian');
      if (s > 0) assert.ok(views.nearestDistanceSq[i * K + s] >= views.nearestDistanceSq[i * K + s - 1], 'ascending');
      checked++;
    }
  }
  assert.ok(checked > 50, `nearest slots checked (${checked})`);
  void count;
});

test('resolveNeighborAggregates: defaults, slot ranges, inheritance, and a clear error for each mistake', () => {
  class Shark {}
  class Fish {
    static neighborAggregates = { separation: { radius: 10 }, nearest: { ofType: Shark, count: 2 } };
  }
  class Minnow extends Fish {}
  class Parent {}
  const regs = [
    { class: Shark, startIndex: 0, count: 5 },
    { class: Fish, startIndex: 5, count: 10 },
    { class: Minnow, startIndex: 15, count: 3 },
    { class: Parent, startIndex: 18, count: 0 },
  ];
  const spec = resolveNeighborAggregates(regs);
  assert.equal(spec.classes.length, 2, 'Fish and Minnow (inherited)');
  const fish = spec.classes[0];
  assert.deepEqual([fish.startIndex, fish.endIndex, fish.nearLo, fish.nearSpan, fish.nearK], [5, 15, 0, 5, 2]);
  assert.equal(fish.sepR2, 100);
  assert.equal(fish.sepFalloff, 0);
  assert.equal(fish.sepSpan, 0xffffffff, 'any type');
  assert.equal(spec.separation, true);
  assert.equal(spec.cohesion, false);
  assert.equal(spec.nearestSlots, 2);
  assert.equal(resolveNeighborAggregates([{ class: Shark, startIndex: 0, count: 5 }]), null, 'no type asks');

  const bad = (cfg, re, opts) => {
    const C = { Bad: class {} }.Bad;
    C.neighborAggregates = cfg;
    assert.throws(() => resolveNeighborAggregates([...regs, { class: C, startIndex: 18, count: 2 }], opts), re);
  };
  bad({ seperation: {} }, /Bad\.neighborAggregates: neighborAggregates\.seperation is not an option/);
  bad({ separation: { radius: -1 } }, /separation\.radius must be a distance/);
  bad({ separation: { falloff: 'linear' } }, /'linear' needs a separation\.radius/);
  bad({ nearest: { count: 17 } }, /nearest\.count must be a whole number from 1 to 16/);
  bad({ nearest: { ofType: class Stranger {} } }, /ofType Stranger is not an entity type of this scene/);
  bad({ nearest: { ofType: Parent } }, /has no slots of its own/);
  bad({ cohesion: { velocity: true } }, /it needs physics/, { physics: false });
});

test('the memory lays out only the outputs some type asks for', () => {
  class A {
    static neighborAggregates = { nearest: { count: 3 } };
  }
  const spec = resolveNeighborAggregates([{ class: A, startIndex: 0, count: 100 }]);
  const mem = createSpatialPublishMemory(100, 8, 1, null, null, spec);
  const r = mem.regions;
  assert.ok(r.aggTable && r.aggClass && r.aggNearestIndex && r.aggNearestDistanceSq && r.aggNearestCount);
  assert.equal(r.aggSeparationX, undefined);
  assert.equal(r.aggCentroidX, undefined);
  assert.equal(r.aggAverageVelocityX, undefined);
  assert.equal(r.aggNearestIndex.bytes, 100 * 3 * 4);
  NeighborAggregates._bind(mem.buffer, mem.aggregates);
  try {
    assert.equal(NeighborAggregates.nearestSlots, 3);
    assert.equal(NeighborAggregates.nearestIndex.length, 300);
    assert.equal(NeighborAggregates.separationX.length, 0, 'an output no type asks for is an empty array');
    assert.equal(NeighborAggregates.nearestOffset(7), 21);
  } finally {
    NeighborAggregates._reset();
  }
  assert.equal(createSpatialPublishMemory(100, 8, 1).aggregates, null, 'no aggregates without a spec');
});
