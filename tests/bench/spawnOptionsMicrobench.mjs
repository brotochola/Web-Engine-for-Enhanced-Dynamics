#!/usr/bin/env node
/**
 * E-286: engine entries called with an options literal, the way the stress drivers (and games) call them.
 *
 *   node tests/bench/spawnOptionsMicrobench.mjs --case bullet|decal|decalBlit [--per-tick N] [--check] [--output path]
 *   node tests/bench/heapSampleNode.mjs -- tests/bench/spawnOptionsMicrobench.mjs --case bullet --check --ticks 20000
 *
 * bullet:    BulletStressDriver's tick: `BulletPool.spawn({ x, y, vx, vy, damage, ownerId, shooterEntityType })` 280
 *            times from 256 cycling origins and directions (one op = one tick, then the tick's bullets despawned).
 * decal:     DecalStampDriver's tick: `Decal.stamp({ texture, x, y, scaleX, scaleY, tint, alpha, blendMode })` 768
 *            times from a seeded rng, into the stamp ring logic workers write (reset after each op by the kernel).
 * decalBlit: DecalBlitDriver's tick: `Decal.stamp({ texture, x, y, scaleX, scaleY, alpha })` 256 times over a tile
 *            walk (the camera calls left out).
 * The literal is built in the driver's tick and passed to the shipped entry (src/); when the entry is not inlined the
 * object, and a heap number for each of its double fields, is allocated on every call (the heap pass: 1.9 MB/s per
 * logic worker in bulletStress, 4.7 in decalStamp). Reports ops/s, the bytes allocated per call over `--ticks` ticks
 * (V8's heap counters with GC observed off; Node, so the structure, not Chrome's numbers) and a checksum (every column
 * a tick's bullets wrote, or the ring's records). Warm-up runs the same tick at 8 calls first (a normal compile).
 * --check: one tick's checksum and the bytes per call, no timing.
 */
import v8 from 'node:v8';
import { PerformanceObserver } from 'node:perf_hooks';

import { BulletComponent } from '../../src/components/bulletComponent.js';
import { BulletPool } from '../../src/core/bulletPool.js';
import { Decal } from '../../src/core/decal.js';
import { Layer } from '../../src/core/layer.js';
import { SpriteSheetRegistry } from '../../src/core/spriteSheetRegistry.js';
import { resetFreeList } from '../../src/util/atomicFreeList.js';
import { isCli, parseArgs, timeIt, warmNormalCompile, writeReport } from './microbenchHelpers.mjs';

const POSITION_SLOTS = 256;
const SPEED = 1500;
const WORLD_W = 4000;
const WORLD_H = 3000;
const MARGIN = 200;

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** BulletStressDriver's tick (tests/bench/stressScenes/bullets/bulletStressDriver.js), its loop as written. */
class BulletDriver {
  constructor(seed, spawnPerTick) {
    this.index = 7;
    this._spawnPerTick = spawnPerTick | 0;
    this._cursor = 0;
    this._sink = 0;
    this._positions = new Float32Array(POSITION_SLOTS * 2);
    this._dirs = new Float32Array(POSITION_SLOTS * 2);
    this._spawned = new Int32Array(Math.max(1, spawnPerTick));
    this._count = 0;
    const rng = mulberry32(seed);
    for (let i = 0; i < POSITION_SLOTS; i++) {
      this._positions[i * 2] = MARGIN + rng() * (WORLD_W - 2 * MARGIN);
      this._positions[i * 2 + 1] = MARGIN + rng() * (WORLD_H - 2 * MARGIN);
      const ang = rng() * Math.PI * 2;
      this._dirs[i * 2] = Math.cos(ang);
      this._dirs[i * 2 + 1] = Math.sin(ang);
    }
  }

  tick() {
    const positions = this._positions;
    const dirs = this._dirs;
    const ownerId = this.index;
    const spawnedOut = this._spawned;
    let cursor = this._cursor;
    let spawned = 0;
    for (let n = 0; n < this._spawnPerTick; n++) {
      const slot = cursor % POSITION_SLOTS;
      const i = BulletPool.spawn({
        x: positions[slot * 2],
        y: positions[slot * 2 + 1],
        vx: dirs[slot * 2] * SPEED,
        vy: dirs[slot * 2 + 1] * SPEED,
        damage: 1,
        ownerId,
        shooterEntityType: 0,
      });
      if (i < 0) break;
      spawnedOut[spawned] = i;
      spawned++;
      cursor++;
    }
    this._cursor = cursor;
    this._sink += spawned;
    this._count = spawned;
  }

  /** The kernel's own reset: the tick's bullets back to the pool. */
  despawnAll() {
    const out = this._spawned;
    for (let k = 0; k < this._count; k++) BulletPool.despawn(out[k]);
    this._count = 0;
  }

  checksum() {
    const bc = BulletComponent;
    const cols = [bc.x, bc.y, bc.startX, bc.startY, bc.prevX, bc.prevY, bc.vx, bc.vy, bc.speed, bc.bulletRotC,
      bc.bulletRotS, bc.spriteRotC, bc.spriteRotS, bc.damage, bc.ownerId, bc.shooterEntityType, bc.textureId, bc.scale,
      bc.alpha, bc.tint, bc.anchorX, bc.anchorY, bc.offsetY, bc.trailWidth, bc.layerMask, bc.active];
    let h = 0;
    for (let k = 0; k < this._count; k++) {
      const i = this._spawned[k];
      h = (h * 31 + i) >>> 0;
      for (const col of cols) h = (h * 31 + Math.round(col[i] * 1000)) >>> 0;
    }
    return h;
  }
}

/** DecalStampDriver's tick (tests/bench/stressScenes/decals/decalStampDriver.js); the count is a field here. */
class DecalStampDriver {
  constructor(seed, stampsPerTick) {
    this._a = seed >>> 0;
    this._sink = 0;
    this._stamps = stampsPerTick | 0;
  }

  _rng() {
    let a = this._a;
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    this._a = a;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  tick() {
    let sink = this._sink;
    for (let i = 0; i < this._stamps; i++) {
      const x = this._rng() * 1920;
      const y = this._rng() * 1080;
      const scale = 0.4 + this._rng() * 1.6;
      const alpha = 0.4 + this._rng() * 0.6;
      const tint = ((this._rng() * 0xffffff) | 0) >>> 0;
      const blendMode = i % 3 === 0 ? 1 : 0; // DECAL_STAMPS_BLEND_MODE.multiply : .normal

      sink += Decal.stamp({
        texture: 'blood',
        x,
        y,
        scaleX: scale,
        scaleY: scale,
        tint,
        alpha,
        blendMode,
      });
    }
    this._sink = sink;
  }
}

/** DecalBlitDriver's stamp loop (tests/bench/stressScenes/decals/decalBlitDriver.js), the camera calls left out. */
class DecalBlitDriver {
  constructor(seed, stampsPerTick) {
    this._tilesX = 64;
    this._tilesY = 64;
    this._tileSize = 64;
    this._stamps = stampsPerTick | 0;
    this._cursor = seed >>> 0;
    this._sink = 0;
  }

  tick() {
    const tiles = this._tilesX * this._tilesY;
    const n = this._stamps;
    const ts = this._tileSize;
    let cur = this._cursor;
    let sink = this._sink;
    for (let i = 0; i < n; i++) {
      const idx = cur % tiles;
      const tx = idx % this._tilesX;
      const ty = (idx / this._tilesX) | 0;
      sink += Decal.stamp({
        texture: 'blood',
        x: (tx + 0.5) * ts,
        y: (ty + 0.5) * ts,
        scaleX: 1.15,
        scaleY: 1.15,
        alpha: 1,
      });
      cur++;
    }
    this._cursor = cur;
    this._sink = sink;
  }
}

const BULLET_POOL = 512;
const RING_CAP = 1024;
const RING_HEADER_I32 = 4;
const RING_STRIDE_I32 = 9;

function setupBullets() {
  Layer.reset();
  Layer.initializeFromConfig({}, { decals: {}, castedShadows: {}, entities: {}, lighting: {} });
  const buffer = new SharedArrayBuffer(BulletComponent.getBufferSize(BULLET_POOL));
  BulletComponent.initializeArrays(buffer, BULLET_POOL);
  BulletComponent.bulletCount = BULLET_POOL;
  const freeList = new Uint16Array(new SharedArrayBuffer(BULLET_POOL * 2));
  const top = new Int32Array(new SharedArrayBuffer(8));
  resetFreeList(top, freeList, BULLET_POOL, 1);
  BulletPool.reset();
  BulletPool.initialize(BULLET_POOL);
  BulletPool.initializeFreeList(freeList.buffer, top.buffer);
}

/** A ring the logic side writes; the kernel empties it after each op (no drain: the particle worker's side). */
function setupDecals() {
  SpriteSheetRegistry.spritesheets.set('bigAtlas', { animations: { blood: { index: 3 } } });
  Decal.bindStampApply(null);
  const sab = Decal.createStampRingSab(RING_CAP);
  Decal.bindStampRing(sab);
  const ring = new Int32Array(sab);
  return {
    ring,
    reset() {
      ring[0] = 0;
      ring[1] = 0;
      for (let k = 0; k < RING_CAP; k++) ring[RING_HEADER_I32 + k * RING_STRIDE_I32] = k;
    },
    checksum(records) {
      let h = 0;
      for (let k = 0; k < records * RING_STRIDE_I32; k++) h = (h * 31 + ring[RING_HEADER_I32 + k]) >>> 0;
      return h;
    },
  };
}

function build(name, perTick) {
  if (name === 'bullet') {
    setupBullets();
    const per = perTick ?? 280;
    const make = (n) => new BulletDriver(0x5eed, n);
    return {
      per,
      make,
      op: (d) => {
        d.tick();
        d.despawnAll();
      },
      checksumOf: (d) => {
        d.tick();
        const h = d.checksum();
        d.despawnAll();
        return h;
      },
    };
  }
  if (name === 'decal' || name === 'decalBlit') {
    const ring = setupDecals();
    const per = perTick ?? (name === 'decal' ? 768 : 256);
    if (per > RING_CAP) throw new Error(`--per-tick ${per} > the ring's ${RING_CAP}`);
    const make = (n) => (name === 'decal' ? new DecalStampDriver(0xdec411, n) : new DecalBlitDriver(0xdecb11, n));
    return {
      per,
      make,
      op: (d) => {
        d.tick();
        ring.reset();
      },
      checksumOf: (d) => {
        ring.reset();
        d.tick();
        const h = (ring.checksum(per) * 31 + d._sink) >>> 0;
        ring.reset();
        return h;
      },
    };
  }
  throw new Error(`unknown --case ${name} (bullet, decal, decalBlit)`);
}

/** Bytes V8 allocated per entry call over `ticks` ops, from its heap counters; null when a GC ran in between. */
function bytesPerCall(op, driver, ticks, per) {
  let gcs = 0;
  const obs = new PerformanceObserver((list) => {
    gcs += list.getEntries().length;
  });
  obs.observe({ entryTypes: ['gc'] });
  const before = v8.getHeapStatistics().used_heap_size;
  for (let t = 0; t < ticks; t++) op(driver);
  const after = v8.getHeapStatistics().used_heap_size;
  obs.disconnect();
  if (gcs > 0 || after < before) return null;
  return (after - before) / (ticks * per);
}

export function runSpawnOptionsMicrobench({ caseName = 'bullet', perTick, ticks = 20, check = false } = {}) {
  const k = build(caseName, perTick);
  // Warm-up: the same tick at 8 calls, many times (a normal compile of the tick and the entry), then full ticks.
  const warm = k.make(8);
  warmNormalCompile(() => k.op(warm));
  const driver = k.make(k.per);
  for (let t = 0; t < 50; t++) k.op(driver);
  const checksum = k.checksumOf(k.make(k.per));
  const perCall = bytesPerCall(k.op, driver, ticks, k.per);
  const label = `${caseName} (${k.per} calls a tick)`;
  console.log(`${label}: checksum ${checksum}, ${perCall === null ? 'a GC ran: no count' : `${perCall.toFixed(1)} bytes allocated per call`}`);
  if (check) return { caseName, perTick: k.per, checksum, bytesPerCall: perCall, cases: {} };
  const cases = {
    tick: timeIt(`spawn options ${label}`, () => k.op(driver), { iterations: 200, warmup: 50 }),
  };
  return { caseName, perTick: k.per, checksum, bytesPerCall: perCall, cases };
}

if (isCli(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const result = runSpawnOptionsMicrobench({
    caseName: args.case || 'bullet',
    perTick: args['per-tick'] === undefined ? undefined : Number(args['per-tick']),
    ticks: args.ticks === undefined ? 20 : Number(args.ticks),
    check: Boolean(args.check),
  });
  if (args.output) writeReport(String(args.output), result);
}
