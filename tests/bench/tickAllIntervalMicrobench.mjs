/**
 * E-527 kernel: the logic worker's tickAll phase for one type, through the shipped update() of a real logic worker
 * (workerHarness) whose types the shipped createGameObjectInstances classified, with logic.staggeredUpdates on.
 * Cases: tickInterval 1 without a body (E-218: tickAll reads a view of the active list), 1 with a RigidBody (the
 * scratch and the acceleration resets), 4 the same two ways, and 1 and 4 on the second of two logic workers (its half
 * of the list, a view from a row other than the first). Each case runs in a process of its own, so tickAll's call site
 * sees one target, as in a scene with one such type. A frame is one update() call; the type's tickAll adds up the ids
 * it got (the checksum) and steps a float column for each, a cheap SoA step of BunnyMark's kind so the phase's own
 * cost shows. Up to E-527 an interval-4 type gets every entity every frame; with it, the frame's bucket, a quarter of them.
 * Warm-up: 3000 frames on 64 entities (short calls: normal TurboFan compiles, not OSR), then frames on the full list.
 *   node tests/bench/tickAllIntervalMicrobench.mjs [--entities 200000] [--frames 200] [--rounds 7] [--case i1] [--output path]
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { isCli, parseArgs, warmNormalCompile, writeReport } from './microbenchHelpers.mjs';
import { loadWorker, quietly } from './workerHarness.mjs';
import { buildPoolScene } from '../helpers/poolScene.mjs';
import { Transform } from '../../src/components/transform.js';
import { RigidBody } from '../../src/components/rigidBody.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { GameObject } from '../../src/core/gameObject.js';
import { EntityIdArray } from '../../src/util/entityIdWidth.js';

export const CASES = {
  i1: { interval: 1, body: false, workers: 1, worker: 0 },
  'i1-body': { interval: 1, body: true, workers: 1, worker: 0 },
  'i1-w2': { interval: 1, body: false, workers: 2, worker: 1 },
  i4: { interval: 4, body: false, workers: 1, worker: 0 },
  'i4-body': { interval: 4, body: true, workers: 1, worker: 0 },
  'i4-w2': { interval: 4, body: false, workers: 2, worker: 1 },
};

const RESULT_PREFIX = '@@tickAllInterval ';
const WARM_ENTITIES = 64;

let idSum = 0;
let visits = 0;
// The float column tickAll steps, one slot per entity.
let column = new Float32Array(0);

function moverClass(interval, body) {
  class Mover extends GameObject {
    static components = body ? [SpriteRenderer, RigidBody] : [SpriteRenderer];
    static tickInterval = interval;
    static tickAll(list, count, dtRatio) {
      const xs = column;
      let s = idSum;
      for (let k = 0; k < count; k++) {
        const i = list[k];
        xs[i] += dtRatio;
        s = (s + i) | 0;
      }
      idSum = s;
      visits += count;
    }
  }
  return Mover;
}

/** One case in this process: the median frame over `rounds` runs of `frames` frames, and the ids tickAll got. */
export async function runCase(name, { entities = 200000, frames = 200, rounds = 7 } = {}) {
  const c = CASES[name];
  if (!c) throw new Error(`unknown case ${name}; cases: ${Object.keys(CASES).join(', ')}`);
  const scene = buildPoolScene({ entities });
  column = new Float32Array(entities);
  RigidBody.initializeArrays(new SharedArrayBuffer(RigidBody.getBufferSize(entities)), entities);
  scene.config.logic = { staggeredUpdates: true };
  // What logic.staggeredUpdates binds (the countdown buffer): the logic worker decimates a type only with it.
  GameObject.nextTick = new Uint8Array(entities);
  const lw = await loadWorker('logicWorker.js', 'logicWorker');
  lw.config = scene.config;
  lw.globalEntityCount = entities;
  lw.gameObjects = new Array(entities).fill(null);
  lw.totalLogicWorkers = c.workers;
  lw.workerIndex = c.worker;
  const Mover = moverClass(c.interval, c.body);
  globalThis.self.Mover = Mover;
  const list = new (EntityIdArray())(1 + entities);
  Mover._activeList = list; // the active lists' buffer is bound elsewhere in a scene
  lw.registeredClasses = [{ name: 'Mover', poolSize: entities, startIndex: 0, endIndex: entities - 1, entityType: 0 }];
  await quietly(() => lw.createGameObjectInstances());
  for (let i = 0; i < entities; i++) {
    list[1 + i] = i;
    Transform.active[i] = 1;
  }

  let frameNumber = 0;
  const frame = () => {
    lw.frameNumber = ++frameNumber;
    lw.update(16.67, 1, false);
  };
  list[0] = WARM_ENTITIES;
  await quietly(() => warmNormalCompile(frame, 3000));
  list[0] = entities;
  for (let f = 0; f < 50; f++) frame();

  // Each round runs the same frame numbers, so the same buckets: the same ids every round.
  const runRound = () => {
    idSum = 0;
    visits = 0;
    frameNumber = 1000;
    const t0 = performance.now();
    for (let f = 0; f < frames; f++) frame();
    return performance.now() - t0;
  };
  runRound();
  const checksum = idSum >>> 0;
  const visitCount = visits;
  const runs = [];
  for (let r = 0; r < rounds; r++) {
    runs.push(runRound());
    if ((idSum >>> 0) !== checksum || visits !== visitCount) throw new Error(`${name}: the checksum moved in round ${r}`);
  }
  const ms = [...runs].sort((p, q) => p - q)[runs.length >> 1];
  return {
    case: name,
    ...c,
    entities,
    frames,
    rounds,
    msPerFrame: ms / frames,
    framesPerSec: (frames * 1000) / ms,
    visitsPerFrame: visitCount / frames,
    nsPerVisit: (ms * 1e6) / visitCount,
    checksum,
    visits: visitCount,
    runs,
  };
}

/** Every case (or the listed ones), each in a child process; the child's other output passes through. */
export function runAll({ entities = 200000, frames = 200, rounds = 7, cases = Object.keys(CASES) } = {}) {
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
  return { kernel: 'tickAllInterval', entities, frames, rounds, rows };
}

if (isCli(import.meta.url)) {
  const args = parseArgs();
  const opts = { entities: args.entities ?? 200000, frames: args.frames ?? 200, rounds: args.rounds ?? 7 };
  if (args.child) {
    const row = await runCase(String(args.case), opts);
    console.log(RESULT_PREFIX + JSON.stringify(row));
  } else {
    const cases = args.case ? String(args.case).split(',') : undefined;
    const res = runAll({ ...opts, cases });
    console.log(`${res.entities} entities, ${res.frames} frames a round, median of ${res.rounds} rounds`);
    for (const r of res.rows) {
      console.log(
        `  ${r.case.padEnd(8)} ${r.msPerFrame.toFixed(4)} ms a frame  ${r.framesPerSec.toFixed(0).padStart(6)} frames/s  ` +
          `${r.nsPerVisit.toFixed(2)} ns a visit  ${r.visitsPerFrame} visits a frame  checksum ${r.checksum}/${r.visits}`,
      );
    }
    if (args.output) writeReport(args.output, res);
  }
}
