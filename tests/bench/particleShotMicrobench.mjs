#!/usr/bin/env node
/**
 * E-538: the particle emits of Predator's firefight, the way its game objects call them, through the shipped
 * ParticleEmitter (src/). Node, no browser: the structure of the cost and of the garbage, not Chrome's numbers.
 *
 *   node tests/bench/particleShotMicrobench.mjs [--case shot|chips|blood|all] [--ops N] [--check] [--output path]
 *   node tests/bench/heapSampleNode.mjs -- tests/bench/particleShotMicrobench.mjs --case shot --check
 *
 * shot:  Person.shoot's emits: two muzzle sprites (a random texture of three, random scale and alpha, facing the shot)
 *        and Person.shootingSparks (10 to 19 sparks along the shot).
 * chips: House.onGotShot's chips (3 to 10 squares off a wall).
 * blood: Person.recieveDamage's blood (4 to 13 drops that stay on the floor).
 * One op is one call of the game's code (the shot's three emits, or one emit). Each config is the literal the game
 * builds, with the game's own random draws (the muzzle's texture, scale and alpha, the sparks' count).
 *
 * Reports ops/s, the bytes V8 allocated per op over --ops ops (its heap counters with GC observed: no count when a GC
 * ran in between) and a checksum of the particle columns after 64 ops from the seed. The pool is recycled whenever it
 * runs low, outside the timed calls' own work. Warm-up: the same op many times (a normal compile, not OSR).
 * --check: the checksum and the bytes per op, no timing.
 */
import v8 from 'node:v8';
import { PerformanceObserver } from 'node:perf_hooks';

import { ParticleComponent } from '../../src/components/particleComponent.js';
import { ParticleEmitter } from '../../src/core/particleEmitter.js';
import { Layer } from '../../src/core/layer.js';
import { SpriteSheetRegistry } from '../../src/core/spriteSheetRegistry.js';
import { seededRandom, rng } from '../../src/util/utils.js';
import { checksumFloats, checksumInts, isCli, parseArgs, timeIt, warmNormalCompile, writeReport } from './microbenchHelpers.mjs';

const POOL = 4096;
/** Recycle the whole pool when fewer slots than this are free (a shot takes at most 21). */
const LOW_WATER = 256;
const SEED = 0x5eed538;

function setup() {
  Layer.reset();
  Layer.initializeFromConfig({}, { decals: {}, castedShadows: {}, entities: {}, lighting: {} }, true);
  ParticleComponent.initializeArrays(new SharedArrayBuffer(ParticleComponent.getBufferSize(POOL)), POOL);
  ParticleComponent.particleCount = POOL;
  ParticleEmitter.reset();
  ParticleEmitter.initialize(POOL);
  ParticleEmitter.initializeFreeList(new SharedArrayBuffer(POOL * 2), new SharedArrayBuffer(8));
  ParticleEmitter.resetFreeListInterleaved(1);
  globalThis.rng = seededRandom(SEED, 'particleShot');
  // Predator's particle textures, at the indices a bigAtlas gives them (getTextureId's lookups as in the game).
  SpriteSheetRegistry.register('bigAtlas', {
    animations: { _whiteCircle: ['_whiteCircle'], blood: ['blood'], muzzle1: ['muzzle1'], muzzle2: ['muzzle2'], muzzle3: ['muzzle3'], square: ['square'] },
  });
}

/** Every live particle back to the pool, as the particle worker returns them when they die. */
function recycle() {
  const active = ParticleComponent.active;
  for (let i = 0; i < POOL; i++) {
    if (active[i]) {
      active[i] = 0;
      ParticleEmitter.returnToPool(i);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The game's calls, literal form (demos/predatorScene/gameObjects/person.js and house.js before E-538).
// ---------------------------------------------------------------------------------------------------------------------

function literalShot(muzzleX, muzzleY, shotDirX, shotDirY, muzzleHeightPx) {
  let n = ParticleEmitter.emit({
    count: 1,
    x: muzzleX,
    y: muzzleY + 1,
    texture: 'muzzle' + Math.floor(rng() * 3 + 1),
    scaleX: rng() * 0.5 + 0.5,
    scaleY: rng() * 0.5 + 0.5,
    rotC: shotDirX,
    rotS: shotDirY,
    alpha: rng() * 0.5 + 0.5,
    anchorX: 0,
    anchorY: 0.5,
    z: muzzleHeightPx,
    gravity: 0,
    lifespan: 50,
    speed: 0,
  });
  n += ParticleEmitter.emit({
    count: 1,
    x: muzzleX,
    y: muzzleY + 1,
    texture: 'muzzle' + Math.floor(rng() * 3 + 1),
    scaleX: rng() * 0.5 + 0.5,
    scaleY: rng() * 0.5 + 0.5,
    rotC: shotDirX,
    rotS: shotDirY,
    alpha: rng() * 0.5 + 0.5,
    anchorX: 0,
    anchorY: 0.5,
    z: muzzleHeightPx,
    gravity: 0,
    lifespan: 50,
    speed: 0,
  });
  n += ParticleEmitter.emit({
    count: Math.floor(rng() * 10) + 10,
    x: muzzleX,
    y: muzzleY + 1,
    z: muzzleHeightPx,
    dirX: shotDirX,
    dirY: shotDirY,
    spread: (10 * Math.PI) / 180,
    speed: { min: 0.1, max: 10 },
    rotation: { min: 0, max: 360 },
    vz: { min: -1, max: 5 },
    gravity: 0.4,
    lifespan: { min: 33, max: 100 },
    scale: { min: 0.15, max: 0.5 },
    texture: '_whiteCircle',
    tint: { min: 0xffff00, max: 0xffffff },
    alpha: { min: 0.5, max: 0.8 },
    despawnOnGroundContact: true,
  });
  return n;
}

function literalChips(hitX, hitY, damage) {
  const count = Math.floor(damage * 8) + 3;
  return ParticleEmitter.emit({
    count,
    texture: 'square',
    x: hitX,
    y: hitY,
    z: -20,
    angleXY: { min: 0, max: 360 },
    speed: { min: 1.5, max: 4 },
    vz: { min: 2, max: 6 },
    lifespan: { min: 400, max: 800 },
    gravity: 0.35,
    scale: { min: 0.15, max: 0.4 },
    alpha: { min: 0.7, max: 1 },
    tint: { min: 0xffff00, max: 0xffffff },
    rotation: { min: 0, max: 360 },
    stayOnTheFloor: false,
    despawnOnGroundContact: true,
  });
}

function literalBlood(x, y, damage) {
  return ParticleEmitter.emit({
    count: Math.floor(damage * (rng() * 10 + 4)),
    texture: 'blood',
    x,
    y,
    z: -30,
    angleXY: { min: 0, max: 360 },
    speed: { min: 0.7, max: 1.66 },
    vz: { min: -4, max: 0 },
    lifespan: 2000,
    gravity: 0.22,
    scale: { min: 0.12, max: 0.3 },
    alpha: { min: 0.66, max: 0.95 },
    tint: { min: 0xaaaaaa, max: 0xffffff },
    stayOnTheFloor: true,
  });
}

/** The forms each case can run: literal (the game's code before E-538). */
export const FORMS = {
  literal: { shot: literalShot, chips: literalChips, blood: literalBlood },
};

// ---------------------------------------------------------------------------------------------------------------------
// The driver: 256 cycling positions and shot directions, one op per call.
// ---------------------------------------------------------------------------------------------------------------------

const SLOTS = 256;
const PX = new Float64Array(SLOTS);
const PY = new Float64Array(SLOTS);
const DX = new Float64Array(SLOTS);
const DY = new Float64Array(SLOTS);
{
  const r = seededRandom(91, 'shotSlots');
  for (let s = 0; s < SLOTS; s++) {
    PX[s] = 100 + r() * 3000;
    PY[s] = 100 + r() * 2000;
    const a = r() * Math.PI * 2;
    DX[s] = Math.cos(a);
    DY[s] = Math.sin(a);
  }
}

function makeOp(caseName, form) {
  const calls = FORMS[form];
  if (!calls) throw new Error(`unknown form ${form} (${Object.keys(FORMS).join(', ')})`);
  let slot = 0;
  let sink = 0;
  const op =
    caseName === 'shot'
      ? () => {
          const s = slot++ & (SLOTS - 1);
          sink += calls.shot(PX[s], PY[s], DX[s], DY[s], -34);
          if (ParticleEmitter.getFreeCount() < LOW_WATER) recycle();
        }
      : caseName === 'chips'
        ? () => {
            const s = slot++ & (SLOTS - 1);
            sink += calls.chips(PX[s], PY[s], 0.15 + (s & 7) * 0.1);
            if (ParticleEmitter.getFreeCount() < LOW_WATER) recycle();
          }
        : caseName === 'blood'
          ? () => {
              const s = slot++ & (SLOTS - 1);
              sink += calls.blood(PX[s], PY[s], 0.4 + (s & 3) * 0.2);
              if (ParticleEmitter.getFreeCount() < LOW_WATER) recycle();
            }
          : null;
  if (!op) throw new Error(`unknown --case ${caseName} (shot, chips, blood)`);
  return { op, sink: () => sink };
}

/** A checksum of what 64 ops from the seed wrote: the columns a spawn writes, over the whole pool. */
function checksumOf(caseName, form) {
  setup();
  const { op } = makeOp(caseName, form);
  for (let k = 0; k < 64; k++) op();
  const c = ParticleComponent;
  let h = 0;
  for (const name of ['x', 'y', 'z', 'vx', 'vy', 'vz', 'gravity', 'scaleX', 'scaleY', 'alpha', 'rotC', 'rotS', 'rotFrom', 'rotTo']) {
    h = (Math.imul(h, 31) + checksumFloats(c[name])) >>> 0;
  }
  for (const name of ['active', 'lifespan', 'tint', 'tintFrom', 'textureId', 'tweenMask', 'stayOnTheFloor', 'despawnOnGroundContact', 'layerMask']) {
    h = (Math.imul(h, 31) + checksumInts(c[name])) >>> 0;
  }
  return h >>> 0;
}

/** Bytes V8 allocated per op over `ops` ops, from its heap counters; null when a GC ran in between. */
function bytesPerOp(op, ops) {
  let gcs = 0;
  const obs = new PerformanceObserver((list) => {
    gcs += list.getEntries().length;
  });
  obs.observe({ entryTypes: ['gc'] });
  const before = v8.getHeapStatistics().used_heap_size;
  for (let k = 0; k < ops; k++) op();
  const after = v8.getHeapStatistics().used_heap_size;
  obs.disconnect();
  if (gcs > 0 || after < before) return null;
  return (after - before) / ops;
}

export function runParticleShotMicrobench({ caseName = 'shot', form = 'literal', ops = 500, check = false } = {}) {
  const checksum = checksumOf(caseName, form);
  setup();
  const { op, sink } = makeOp(caseName, form);
  warmNormalCompile(op, 5000);
  const perOp = bytesPerOp(op, ops);
  const label = `${caseName} (${form})`;
  console.log(`${label}: checksum ${checksum}, ${perOp === null ? 'a GC ran: no count' : `${perOp.toFixed(1)} bytes allocated per op`}`);
  if (check) return { caseName, form, checksum, bytesPerOp: perOp, cases: {} };
  const cases = { op: timeIt(`particle ${label}`, op, { iterations: 2000, warmup: 500 }) };
  if (sink() === -1) console.log('');
  return { caseName, form, checksum, bytesPerOp: perOp, cases };
}

if (isCli(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const names = !args.case || args.case === 'all' ? ['shot', 'chips', 'blood'] : [String(args.case)];
  const forms = args.form ? [String(args.form)] : Object.keys(FORMS);
  const results = [];
  for (const caseName of names) {
    for (const form of forms) {
      results.push(runParticleShotMicrobench({
        caseName,
        form,
        ops: args.ops === undefined ? 500 : Number(args.ops),
        check: Boolean(args.check),
      }));
    }
  }
  if (args.output) writeReport(String(args.output), { results });
}
