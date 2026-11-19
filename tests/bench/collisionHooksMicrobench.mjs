/**
 * E-528 kernel: collision callbacks through the shipped contact flow of a real logic worker (workerHarness), whose
 * one entity type the shipped createGameObjectInstances registered (its listener flags and hook resolution). A frame
 * publishes `churn` contact ends and `churn` begins into the Box2D contact ring, then runs processCollisionCallbacks:
 * the drain, Enter on both sides of each new pair, Exit on both sides of each ended one, and with a stay hook the walk
 * that calls Stay on both sides of every pair that holds. One logic worker, so it runs both sides of every pair.
 * Cases (each in a process of its own, so the hook call sites see one class, as in a scene with one listening type):
 *   instance          instance methods onCollisionEnter / Stay / Exit (the path every scene took before E-528)
 *   instance-events   the same without onCollisionStay (E-302's lazy pairs: no walk, the frame is the events)
 *   static            static onCollisionEnter(i, other) / Stay / Exit (E-528; the code before it never calls them)
 *   static-events     the same without a stay hook
 * The hooks add (3 * i + other) into a sum per hook (the checksum) and count their calls. Warm-up: 3000 frames on 64
 * pairs (short calls: normal TurboFan compiles, not OSR), then every pair begins and frames run on the full set.
 *   node tests/bench/collisionHooksMicrobench.mjs [--entities 40000] [--frames 200] [--rounds 7] [--case instance] [--output path]
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { isCli, parseArgs, warmNormalCompile, writeReport } from './microbenchHelpers.mjs';
import { loadWorker, quietly } from './workerHarness.mjs';
import { buildPoolScene } from '../helpers/poolScene.mjs';
import { Transform } from '../../src/components/transform.js';
import { CollisionListener } from '../../src/components/collisionListener.js';
import { GameObject } from '../../src/core/gameObject.js';
import { EntityIdArray } from '../../src/util/entityIdWidth.js';
import {
  BOX2D_CONTACT_KIND,
  bindContactRing,
  createContactRingSab,
  publishContactEvent,
} from '../../src/box2d/box2dContactRing.js';

export const CASES = {
  instance: { form: 'instance', stay: true, churn: 0.02 },
  'instance-events': { form: 'instance', stay: false, churn: 0.2 },
  static: { form: 'static', stay: true, churn: 0.02 },
  'static-events': { form: 'static', stay: false, churn: 0.2 },
};

const RESULT_PREFIX = '@@collisionHooks ';
const WARM_PAIRS = 64;
const SEED = 0x5eed0528;

let enterSum = 0;
let staySum = 0;
let exitSum = 0;
let calls = 0;

function crowdClass(form, stay) {
  if (form === 'instance') {
    if (stay) {
      return class Crowd extends GameObject {
        static components = [CollisionListener];
        onCollisionEnter(other) {
          enterSum = (enterSum + 3 * this.index + other) | 0;
          calls++;
        }
        onCollisionStay(other) {
          staySum = (staySum + 3 * this.index + other) | 0;
          calls++;
        }
        onCollisionExit(other) {
          exitSum = (exitSum + 3 * this.index + other) | 0;
          calls++;
        }
      };
    }
    return class Crowd extends GameObject {
      static components = [CollisionListener];
      onCollisionEnter(other) {
        enterSum = (enterSum + 3 * this.index + other) | 0;
        calls++;
      }
      onCollisionExit(other) {
        exitSum = (exitSum + 3 * this.index + other) | 0;
        calls++;
      }
    };
  }
  if (stay) {
    return class Crowd extends GameObject {
      static components = [CollisionListener];
      static onCollisionEnter(i, other) {
        enterSum = (enterSum + 3 * i + other) | 0;
        calls++;
      }
      static onCollisionStay(i, other) {
        staySum = (staySum + 3 * i + other) | 0;
        calls++;
      }
      static onCollisionExit(i, other) {
        exitSum = (exitSum + 3 * i + other) | 0;
        calls++;
      }
    };
  }
  return class Crowd extends GameObject {
    static components = [CollisionListener];
    static onCollisionEnter(i, other) {
      enterSum = (enterSum + 3 * i + other) | 0;
      calls++;
    }
    static onCollisionExit(i, other) {
      exitSum = (exitSum + 3 * i + other) | 0;
      calls++;
    }
  };
}

/** One case in this process: the median frame over `rounds` runs of `frames` frames, and what the hooks summed. */
export async function runCase(name, { entities = 40000, frames = 200, rounds = 7 } = {}) {
  const c = CASES[name];
  if (!c) throw new Error(`unknown case ${name}; cases: ${Object.keys(CASES).join(', ')}`);
  const n = entities & ~1;
  const scene = buildPoolScene({ entities: n });
  const lw = await loadWorker('logicWorker.js', 'logicWorker');
  lw.config = scene.config;
  lw.globalEntityCount = n;
  lw.gameObjects = new Array(n).fill(null);
  lw.totalLogicWorkers = 1;
  lw.workerIndex = 0;
  const Crowd = crowdClass(c.form, c.stay);
  globalThis.self.Crowd = Crowd;
  Crowd._activeList = new (EntityIdArray())(1 + n); // the active lists' buffer is bound elsewhere in a scene
  lw.registeredClasses = [{ name: 'Crowd', poolSize: n, startIndex: 0, endIndex: n - 1, entityType: 0 }];
  await quietly(() => lw.createGameObjectInstances());
  for (let i = 0; i < n; i++) Transform.active[i] = 1;

  // The Box2D contact ring as box2dReady binds it; every body's generation 0.
  const ring = createContactRingSab(65536);
  bindContactRing(ring);
  lw.box2dContactRingI32 = new Int32Array(ring);
  lw.box2dContactCursor = 0;
  lw.useBox2dContacts = true;
  lw.bodyGeneration = new Int32Array(new SharedArrayBuffer(n * 4));

  // Pairs (2k, 2k + 1); about half the events arrive in Box2D's order (larger id, smaller id).
  const pairs = n >> 1;
  const swap = new Uint8Array(pairs);
  let s = SEED;
  for (let p = 0; p < pairs; p++) {
    s = (Math.imul(s, 1664525) + 1013904223) | 0;
    swap[p] = s & 1;
  }
  const publish = (kind, p) => {
    const a = 2 * p;
    if (swap[p]) publishContactEvent(kind, a + 1, a, 0, 0);
    else publishContactEvent(kind, a, a + 1, 0, 0);
  };
  const BEGIN = BOX2D_CONTACT_KIND.CONTACT_BEGIN;
  const END = BOX2D_CONTACT_KIND.CONTACT_END;

  // A frame: the `churn` pairs from `cursor` end, the ones that ended last frame begin again.
  let live = WARM_PAIRS;
  let churn = Math.max(1, Math.round(live * c.churn));
  let cursor = 0;
  let prev = -1;
  const frame = () => {
    if (prev >= 0) for (let k = 0; k < churn; k++) publish(BEGIN, (prev + k) % live);
    for (let k = 0; k < churn; k++) publish(END, (cursor + k) % live);
    prev = cursor;
    cursor = (cursor + churn) % live;
    lw.processCollisionCallbacks();
  };

  for (let p = 0; p < live; p++) publish(BEGIN, p);
  lw.processCollisionCallbacks();
  await quietly(() => warmNormalCompile(frame, 3000));

  // The full set: the warm pairs settle (the last frame's ends begin again), then every other pair begins, in batches
  // the ring holds.
  for (let k = 0; k < churn; k++) publish(BEGIN, (prev + k) % live);
  lw.processCollisionCallbacks();
  for (let p0 = live; p0 < pairs; p0 += 30000) {
    for (let p = p0; p < Math.min(pairs, p0 + 30000); p++) publish(BEGIN, p);
    lw.processCollisionCallbacks();
  }
  live = pairs;
  churn = Math.max(1, Math.round(live * c.churn));
  cursor = 0;
  prev = -1;
  for (let f = 0; f < 50; f++) frame();

  // Each round starts from the same pair state (the last round's ends begin again first), so it makes the same calls.
  const runRound = () => {
    if (prev >= 0) {
      for (let k = 0; k < churn; k++) publish(BEGIN, (prev + k) % live);
      lw.processCollisionCallbacks();
    }
    cursor = 0;
    prev = -1;
    enterSum = 0;
    staySum = 0;
    exitSum = 0;
    calls = 0;
    const t0 = performance.now();
    for (let f = 0; f < frames; f++) frame();
    return performance.now() - t0;
  };
  runRound();
  const checksum = (Math.imul(enterSum, 31) + Math.imul(staySum, 17) + exitSum) >>> 0;
  const callCount = calls;
  const runs = [];
  for (let r = 0; r < rounds; r++) {
    runs.push(runRound());
    const again = (Math.imul(enterSum, 31) + Math.imul(staySum, 17) + exitSum) >>> 0;
    if (again !== checksum || calls !== callCount) throw new Error(`${name}: the checksum moved in round ${r}`);
  }
  const ms = [...runs].sort((p, q) => p - q)[runs.length >> 1];
  return {
    case: name,
    ...c,
    entities: n,
    pairs,
    churnPerFrame: churn,
    frames,
    rounds,
    seed: SEED,
    // false: no hook ran (static hooks on code before E-528, which never calls them).
    dispatched: callCount > 0,
    msPerFrame: ms / frames,
    framesPerSec: (frames * 1000) / ms,
    callsPerFrame: callCount / frames,
    nsPerCall: callCount > 0 ? (ms * 1e6) / callCount : null,
    instancesMade: lw.gameObjects.reduce((k, o) => (o !== null && o !== undefined ? k + 1 : k), 0),
    checksum,
    calls: callCount,
    runs,
  };
}

/** Every case (or the listed ones), each in a child process; the child's other output passes through. */
export function runAll({ entities = 40000, frames = 200, rounds = 7, cases = Object.keys(CASES) } = {}) {
  const file = fileURLToPath(import.meta.url);
  const rows = [];
  for (const name of cases) {
    const child = spawnSync(
      process.execPath,
      [...process.execArgv, file, '--case', name, '--entities', String(entities), '--frames', String(frames), '--rounds', String(rounds), '--child'],
      { encoding: 'utf8', maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'inherit'] },
    );
    if (child.status !== 0) throw new Error(`case ${name} exited ${child.status}`);
    let row = null;
    for (const line of child.stdout.split('\n')) {
      if (line.startsWith(RESULT_PREFIX)) row = JSON.parse(line.slice(RESULT_PREFIX.length));
      else if (line.length > 0) console.log(line);
    }
    if (!row) throw new Error(`case ${name} printed no result`);
    rows.push(row);
  }
  const casesOut = {};
  for (const r of rows) casesOut[r.case] = { opsPerSec: r.framesPerSec, n: r.entities, seed: r.seed, checksum: r.checksum, ...r };
  return { kernel: 'collisionHooks', entities, frames, rounds, seed: SEED, rows, cases: casesOut };
}

if (isCli(import.meta.url)) {
  const args = parseArgs();
  const opts = { entities: args.entities ?? 40000, frames: args.frames ?? 200, rounds: args.rounds ?? 7 };
  if (args.child) {
    const row = await runCase(String(args.case), opts);
    console.log(RESULT_PREFIX + JSON.stringify(row));
  } else {
    const cases = args.case ? String(args.case).split(',') : undefined;
    const res = runAll({ ...opts, cases });
    console.log(`${res.entities} entities, ${res.frames} frames a round, median of ${res.rounds} rounds`);
    for (const r of res.rows) {
      if (!r.dispatched) {
        console.log(`  ${r.case.padEnd(16)} no hook ran (static hooks need E-528)`);
        continue;
      }
      console.log(
        `  ${r.case.padEnd(16)} ${r.msPerFrame.toFixed(4)} ms a frame  ${r.framesPerSec.toFixed(0).padStart(6)} frames/s  ` +
          `${r.nsPerCall.toFixed(2)} ns a call  ${r.callsPerFrame} calls a frame  ${r.instancesMade} instances  checksum ${r.checksum}/${r.calls}`,
      );
    }
    if (args.output) writeReport(args.output, res);
  }
}
