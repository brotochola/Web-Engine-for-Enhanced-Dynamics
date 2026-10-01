#!/usr/bin/env node
/**
 * Kernel: GameObject component getters (`this.transform`, `this.rigidBody`, …)
 * and neighbor access (`neighborCount`, `getNeighbor`) on real GameObject
 * subclasses, the way demo ticks use them. Three entity classes touch their
 * components in different orders (their `_componentCache` objects get
 * different shapes, and one getter body serves every class and component).
 *
 *   node tests/bench/gameObjectAccessMicrobench.mjs
 *   node tests/bench/gameObjectAccessMicrobench.mjs --output out.json
 *
 * Cases: `tick` (components + short neighbor lists) and `neighbors` (Predator
 * neighbor layout: maxNeighbors 1024, lists up to 120, type test per neighbor).
 */
import { Transform } from '../../src/components/transform.js';
import { RigidBody } from '../../src/components/rigidBody.js';
import { Collider } from '../../src/components/collider.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { GameObject } from '../../src/core/gameObject.js';
import { Grid } from '../../src/core/grid.js';
import { isCli, mulberry32, parseArgs, timeIt, writeReport } from './microbenchHelpers.mjs';
import { spatialBuffers } from './workerHarness.mjs';

const VARIANTS = { base: (B) => B };

export function setupAccess(variant, n, seed, opts = {}) {
  for (const C of [Transform, RigidBody, Collider, SpriteRenderer]) C.initializeArrays(new SharedArrayBuffer(C.getBufferSize(n)), n);
  const maxNeighbors = opts.maxNeighbors ?? 64;
  const maxCount = opts.maxCount ?? 30;
  const cfg = { worldWidth: 10000, worldHeight: 5000, cellSize: 128, maxEntitiesPerCell: 128, maxNeighbors };
  const { buffers, gridMetadata } = spatialBuffers(cfg, n);
  Grid.reset();
  Grid.initialize(
    { gridBuffer: buffers.gridBuffer, neighborBuffer: buffers.neighborData, cellSleepingBuffer: buffers.cellSleepingBuffer, cellVersionBuffer: buffers.cellVersionBuffer },
    { ...gridMetadata, gridWidth: gridMetadata.gridCols, gridHeight: gridMetadata.gridRows }
  );
  const Base = VARIANTS[variant](GameObject);
  class Civilian extends Base {
    static components = [RigidBody, Collider, SpriteRenderer];
    static entityType = 1;
    static instances = [];
    tick() {
      return this.rigidBody.vx + this.transform.x + this.collider.radius;
    }
  }
  class Soldier extends Base {
    static components = [RigidBody, Collider, SpriteRenderer];
    static entityType = 2;
    static instances = [];
    tick() {
      return this.transform.x + this.collider.radius + this.spriteRenderer.alpha + this.rigidBody.vx;
    }
  }
  class Prop extends Base {
    static components = [Collider, SpriteRenderer];
    static entityType = 3;
    static instances = [];
    tick() {
      return this.spriteRenderer.alpha + this.transform.x + this.collider.radius;
    }
  }
  const classes = [Civilian, Soldier, Prop];
  for (const C of classes) GameObject._assignComponentClassMap(C);
  GameObject.instances = [];
  const rng = mulberry32(seed);
  const objects = [];
  for (let i = 0; i < n; i++) {
    const C = classes[i % 10 < 6 ? 0 : i % 10 < 8 ? 1 : 2];
    objects.push(new C(i));
  }
  Transform.x = new Float32Array(n);
  RigidBody.vx = new Float32Array(n);
  const nd = Grid._neighborData;
  const stride = Grid._stride;
  for (let i = 0; i < n; i++) {
    Transform.x[i] = rng() * 1000;
    RigidBody.vx[i] = rng();
    Collider.radius[i] = 8;
    SpriteRenderer.alpha[i] = 1;
    Transform.entityType[i] = 1 + (i % 3);
    const count = (rng() * maxCount) | 0;
    nd[i * stride] = count;
    for (let k = 0; k < count; k++) nd[i * stride + 1 + k] = (rng() * n) | 0;
  }
  // Predator's soldier scan (findACivilianToShoot): walk every neighbor, test its type.
  function scan() {
    const type = Transform.entityType;
    let found = 0;
    for (let i = 0; i < n; i++) {
      const o = objects[i];
      const c = o.neighborCount;
      for (let k = 0; k < c; k++) if (type[o.getNeighbor(k)] === 1) found++;
    }
    return found;
  }
  // Demo tick shape: own components, then walk neighbors and read theirs.
  function frame() {
    let acc = 0;
    for (let i = 0; i < n; i++) {
      const o = objects[i];
      acc += o.tick();
      const c = o.neighborCount;
      for (let k = 0; k < c; k++) acc += Transform.x[o.getNeighbor(k)];
    }
    return acc;
  }
  return { frame, scan, objects, n };
}

async function main() {
  const args = parseArgs();
  const variant = String(args.variant || 'base');
  if (!VARIANTS[variant]) throw new Error(`unknown variant ${variant}`);
  const n = Number(args.n ?? 16384);
  const seed = 0x60ac;
  const k = setupAccess(variant, n, seed);
  let checksum = Math.round(k.frame() * 1000) >>> 0;
  const cases = {
    tick: timeIt(`GameObject access ${variant} (${n} entities)`, () => k.frame(), { iterations: 20, warmup: 20 }),
  };
  // Predator layout: maxNeighbors 1024 (rows of 1025 ids), lists up to 120.
  const p = setupAccess(variant, n, seed, { maxNeighbors: 1024, maxCount: 120 });
  checksum = (Math.imul(checksum, 31) + p.scan()) >>> 0;
  cases.neighbors = timeIt(`neighbor scan ${variant} (${n} entities, maxNeighbors 1024)`, () => p.scan(), {
    iterations: 20,
    warmup: 20,
  });
  const report = {
    feature: 'gameobject-access',
    functions: ['GameObject component getters', 'GameObject.neighborCount', 'GameObject.getNeighbor'],
    variant,
    n,
    seed,
    checksum,
    cases,
  };
  if (args.output) writeReport(String(args.output), report);
  else console.log(checksum);
}

if (isCli(import.meta.url)) await main();
