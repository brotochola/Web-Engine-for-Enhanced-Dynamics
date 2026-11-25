#!/usr/bin/env node
/**
 * Kernel (E-534): a pool's spawns on a real logic worker, through the shipped GameObject spawn path (_spawnAt), the
 * object way against the ECS way. One op spawns 256 entities, each from a config literal built in the loop as a game
 * builds it ({ x, y }), and despawns them by index.
 *
 *   object  a class with an onSpawned method (its sprite's alpha through the facade), `Kind.spawn(config)`
 *   static  a class with a static onSpawned (the alpha column by index), `Kind.spawn(config)`: still the instance
 *   index   the same static class, `Kind.spawnIndex(config)`: no instance (trees without spawnIndex report n/a)
 *
 * --fresh: the instance tables are emptied before each op, so every spawn that makes an instance makes a new one
 * (a pool's first spawns, Predator's 40 000 at its start); without it the instances made in warm-up are reused (a
 * pool cycling). Reports ops/s and a checksum (the spawned entities' x and alpha columns). Warm-up runs ops of 8
 * spawns first (a normal compile).
 *
 *   node tests/bench/spawnPathMicrobench.mjs [--case object|static|index] [--fresh] [--profile-ms N] [--output path]
 * --profile-ms N: the op again for N ms after the timing (for node --cpu-prof).
 */
import { isCli, parseArgs, timeIt, warmNormalCompile, writeReport } from './microbenchHelpers.mjs';
import { loadWorker, quietly } from './workerHarness.mjs';
import { buildPoolScene } from '../helpers/poolScene.mjs';
import { GameObject } from '../../src/core/gameObject.js';
import { Transform } from '../../src/components/transform.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { EntityIdArray } from '../../src/util/entityIdWidth.js';
import { resetFreeList } from '../../src/util/atomicFreeList.js';

const BATCH = 256;
const ARGS = parseArgs();

/** The object way: the setup is a method, through the instance's facades. */
class ObjectKind extends GameObject {
  static components = [SpriteRenderer];
  onSpawned() {
    this.spriteRenderer.alpha = 0.5;
  }
}

/** The ECS way: the setup is a static by index, the columns written straight. */
class StaticKind extends GameObject {
  static components = [SpriteRenderer];
  static onSpawned(i) {
    SpriteRenderer.alpha[i] = 0.5;
  }
}

async function setup() {
  const classes = [ObjectKind, StaticKind];
  const n = classes.length * BATCH;
  const scene = buildPoolScene({ entities: n });
  Transform.x = new Float32Array(n);
  Transform.y = new Float32Array(n);
  Transform.rotation = new Float32Array(n);
  GameObject.forceProcessOnLogicWorker = null;
  GameObject.entityTypeHasForcedLogicWorker = null;
  const lw = await loadWorker('logicWorker.js', 'logicWorker');
  lw.config = scene.config;
  lw.globalEntityCount = n;
  lw.gameObjects = new Array(n).fill(null);
  lw.previousScreenVisibility = new Uint8Array(n);
  lw.totalLogicWorkers = 1;
  lw.workerIndex = 0;
  lw.nonDecimatedTypes = [];
  lw.decimatedTypes = [];
  lw.tickAllTypes = [];
  lw.tickAllBucketTypes = [];
  lw.directionalTypes = [];
  lw.screenTypes = [];
  lw._drainSpawnCommandRing = () => {};
  lw.processListUpdates = () => {};
  lw._latchDisplayPose = () => {};
  lw.sendListUpdatesToLogic0 = () => {};
  lw.registeredClasses = classes.map((C, t) => {
    globalThis.self[C.name] = C;
    C._activeList = new (EntityIdArray())(1 + BATCH);
    return { name: C.name, poolSize: BATCH, startIndex: t * BATCH, endIndex: (t + 1) * BATCH - 1, entityType: t };
  });
  await quietly(() => lw.createGameObjectInstances());
  for (const C of classes) {
    const top = new Int32Array(new SharedArrayBuffer(8));
    const links = new (EntityIdArray())(BATCH);
    resetFreeList(top, links, BATCH, 1);
    C.freeList = links;
    C.freeListTop = top;
  }
  return { lw, n };
}

const px = new Float64Array(BATCH);
const py = new Float64Array(BATCH);
for (let k = 0; k < BATCH; k++) {
  px[k] = 100 + ((k * 37) % 1900);
  py[k] = 100 + ((k * 53) % 1400);
}
const spawned = new Int32Array(BATCH);

function emptyInstances(lw, Kind) {
  lw.gameObjects.fill(null);
  GameObject.instances.fill(null);
  Kind.instances.fill(null);
}

/** One op of `count` spawns and their despawns; returns the op's checksum. */
function makeOp(caseName, lw, fresh) {
  const Kind = caseName === 'object' ? ObjectKind : StaticKind;
  const spawnOne =
    caseName === 'index'
      ? (k) => Kind.spawnIndex({ x: px[k], y: py[k] })
      : (k) => {
          const e = Kind.spawn({ x: px[k], y: py[k] });
          return e === null ? -1 : e.index;
        };
  return (count) => {
    if (fresh) emptyInstances(lw, Kind);
    let sum = 0;
    for (let k = 0; k < count; k++) spawned[k] = spawnOne(k);
    for (let k = 0; k < count; k++) {
      const i = spawned[k];
      if (i < 0) continue;
      sum += Transform.x[i] + SpriteRenderer.alpha[i];
      Kind.despawn(i);
    }
    // The frame's end, as logic0's drain leaves it: kept, the lists of the timing's tens of millions of spawns and
    // despawns grew to its end, and the copies of their growth were a sixth of the op (E-559).
    lw._spawnN = 0;
    lw._despawnN = 0;
    return sum;
  };
}

export async function runSpawnPath(caseName, fresh) {
  if (caseName === 'index' && typeof StaticKind.spawnIndex !== 'function') return { case: caseName, fresh, skipped: 'no spawnIndex in this tree' };
  const { lw } = await setup();
  const op = makeOp(caseName, lw, fresh);
  const checksum = op(BATCH);
  warmNormalCompile(() => op(8), 3000);
  const r = await quietly(() => timeIt(`spawnPath ${caseName}${fresh ? ' fresh' : ''}`, () => op(BATCH), { silent: true }));
  // --profile-ms: the op again for that long after the timing, so a CPU profile sees the spawn path, not the module load.
  const profileMs = Number(ARGS['profile-ms'] || 0);
  for (const end = performance.now() + profileMs; performance.now() < end; ) op(BATCH);
  return { case: caseName, fresh, opsPerSec: r.opsPerSec, spawnsPerSec: r.opsPerSec * BATCH, ms: r.ms, iterations: r.iterations, checksum };
}

if (isCli(import.meta.url)) {
  const cases = ARGS.case ? [String(ARGS.case)] : ['object', 'static', 'index'];
  const fresh = ARGS.fresh === true;
  const results = [];
  for (const c of cases) {
    const r = await runSpawnPath(c, fresh);
    results.push(r);
    if (r.skipped) console.log(`${c}${fresh ? ' fresh' : ''}: n/a (${r.skipped})`);
    else console.log(`${c}${fresh ? ' fresh' : ''}: ${Math.round(r.spawnsPerSec).toLocaleString()} spawns/s (checksum ${r.checksum.toFixed(1)})`);
  }
  if (ARGS.output) writeReport(String(ARGS.output), { kernel: 'spawnPath', batch: BATCH, results });
}
