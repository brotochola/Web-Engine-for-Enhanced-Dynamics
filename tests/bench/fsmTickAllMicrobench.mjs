/**
 * E-526 kernel: a type's FSMs run by its own tick() against the same type with no tick(), whose FSMs the engine runs
 * through FSM.tickAll, through the shipped update() of a real logic worker (workerHarness) whose types the shipped
 * createGameObjectInstances classified.
 *
 *   node tests/bench/fsmTickAllMicrobench.mjs [--case tick,tickAll] [--entities 30000] [--frames 100] [--rounds 7]
 *     [--hooks none|predator|all] [--check] [--output path]
 *
 * The workload is fsmTickMicrobench's Predator shape: three FSM classes with Predator's state counts (3, 9 and 5: 17
 * state classes), two owner types (civilians, two thirds of the entities, and soldiers), each with an animation FSM and
 * a behaviour FSM in its components. Each state's onUpdate adds to its owner's sum (a module Int32Array at
 * owner.index, so the owner is read) and leaves for another state after a time of its own (200 to 1100 ms), so an FSM
 * changes state every few of its owner's ticks; --hooks says which states define onEnter / onExit (fsmTickMicrobench's
 * meaning; predator by default).
 *
 * Cases, each in a process of its own (FSM classes, states and owners made in one process share their call sites'
 * feedback, as a scene with one such path would not):
 *   tick:            interval 1; each type's tick() calls its two FSMs' tick(dt, this), as games write it.
 *   tickAll:         interval 1; no tick(): the engine runs the two FSMs through FSM.tickAll (E-526).
 *   tick-stagger:    Predator's tickIntervals (civilians 4, soldiers 6) with logic.staggeredUpdates: tick()'s buckets.
 *   tickAll-stagger: the same intervals through FSM.tickAll in E-527's bucketed tickAll.
 * A frame is one update() call. The checksum (the owners' sums, every FSM's states and times, and the onUpdate calls)
 * after one round from the same start is the same for a tick case and its tickAll case: the same calls, with the same
 * arguments, in the same order. Before E-526 a type with FSMs and no tick() is not ticked: the tickAll cases stop there.
 * Warm-up: 3000 frames on 64 entities of each type (short calls: normal TurboFan compiles, not OSR), then 50 frames on
 * the full lists (the instances are made on their first tick), then rounds, each from the same FSM states and frame
 * numbers. --check prints the checksums only.
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
import { FSM } from '../../src/core/fsm.js';
import { FSMState } from '../../src/core/fsmState.js';
import { EntityIdArray } from '../../src/util/entityIdWidth.js';

export const CASES = {
  tick: { path: 'tick', intervals: [1, 1] },
  tickAll: { path: 'tickAll', intervals: [1, 1] },
  'tick-stagger': { path: 'tick', intervals: [4, 6] },
  'tickAll-stagger': { path: 'tickAll', intervals: [4, 6] },
};

const RESULT_PREFIX = '@@fsmTickAll ';
const WARM_ENTITIES = 64;

// Each owner's sum, by entity index, and the onUpdate calls.
let sums = new Int32Array(0);
let updates = 0;

/** The state number in a state's name ('S3' → 3), or 7 for none (an FSM's first state has no previous one). */
function stateNumber(name) {
  return name === null ? 7 : name.charCodeAt(1) - 48;
}

/** One state class, by which hooks it defines, as games write them (statics in the literal). */
function makeState(s, stay, next, enter, exit) {
  if (enter && exit) {
    return class extends FSMState {
      static onEnter(owner, i, fromState) {
        sums[owner.index] += 3 + s * 11 + stateNumber(fromState);
      }
      static onExit(owner, i, toState) {
        sums[owner.index] += 5 + s * 13 + stateNumber(toState) * 17;
      }
      static onUpdate(owner, i, dt, timeInState) {
        sums[owner.index] += (timeInState & 7) + s;
        updates++;
        if (timeInState > stay) this.fsm.changeState(i, this.fsm._stateArray[next]);
      }
    };
  }
  if (enter) {
    return class extends FSMState {
      static onEnter(owner, i, fromState) {
        sums[owner.index] += 3 + s * 11 + stateNumber(fromState);
      }
      static onUpdate(owner, i, dt, timeInState) {
        sums[owner.index] += (timeInState & 7) + s;
        updates++;
        if (timeInState > stay) this.fsm.changeState(i, this.fsm._stateArray[next]);
      }
    };
  }
  if (exit) {
    return class extends FSMState {
      static onExit(owner, i, toState) {
        sums[owner.index] += 5 + s * 13 + stateNumber(toState) * 17;
      }
      static onUpdate(owner, i, dt, timeInState) {
        sums[owner.index] += (timeInState & 7) + s;
        updates++;
        if (timeInState > stay) this.fsm.changeState(i, this.fsm._stateArray[next]);
      }
    };
  }
  return class extends FSMState {
    static onUpdate(owner, i, dt, timeInState) {
      sums[owner.index] += (timeInState & 7) + s;
      updates++;
      if (timeInState > stay) this.fsm.changeState(i, this.fsm._stateArray[next]);
    }
  };
}

/** Which of an FSM's states define onEnter / onExit, per --hooks (salt: 1 civilian, 2 animation, 3 soldier). */
const HOOKS = {
  none: { enter: () => false, exit: () => false },
  predator: {
    enter: (salt, s) => (salt === 1 ? s === 0 : salt === 2 ? true : s < 4),
    exit: (salt, s) => salt === 1 && s > 0,
  },
  all: { enter: () => true, exit: () => true },
};

/** Per state: how long it stays (ms) and the state it goes to (index in its FSM). */
function makeStates(n, salt, hooks) {
  const states = {};
  for (let s = 0; s < n; s++) {
    const stay = 200 + ((s * 137 + salt * 59) % 900);
    const next = (s + 1 + (salt % 2)) % n;
    states[`S${s}`] = makeState(s, stay, next, hooks.enter(salt, s), hooks.exit(salt, s));
  }
  return states;
}

function makeFsms(hooks) {
  class CivilianBehaviorFSM extends FSM {
    static states = makeStates(3, 1, hooks);
    static initial = this.states.S0;
  }
  class PersonAnimationFSM extends FSM {
    static states = makeStates(9, 2, hooks);
    static initial = this.states.S0;
  }
  class SoldierBehaviorFSM extends FSM {
    static states = makeStates(5, 3, hooks);
    static initial = this.states.S0;
  }
  return { CivilianBehaviorFSM, PersonAnimationFSM, SoldierBehaviorFSM };
}

/** The owner types: with a tick() that runs their FSMs, or with none (the engine runs them). */
function makeOwners(fsms, path, intervals) {
  const { CivilianBehaviorFSM, PersonAnimationFSM, SoldierBehaviorFSM } = fsms;
  if (path === 'tick') {
    class Civilian extends GameObject {
      static components = [SpriteRenderer, PersonAnimationFSM, CivilianBehaviorFSM];
      static tickInterval = intervals[0];
      tick(dt) {
        this.personAnimationFSM.tick(dt, this);
        this.civilianBehaviorFSM.tick(dt, this);
      }
    }
    class Soldier extends GameObject {
      static components = [SpriteRenderer, PersonAnimationFSM, SoldierBehaviorFSM];
      static tickInterval = intervals[1];
      tick(dt) {
        this.personAnimationFSM.tick(dt, this);
        this.soldierBehaviorFSM.tick(dt, this);
      }
    }
    return [Civilian, Soldier];
  }
  class Civilian extends GameObject {
    static components = [SpriteRenderer, PersonAnimationFSM, CivilianBehaviorFSM];
    static tickInterval = intervals[0];
  }
  class Soldier extends GameObject {
    static components = [SpriteRenderer, PersonAnimationFSM, SoldierBehaviorFSM];
    static tickInterval = intervals[1];
  }
  return [Civilian, Soldier];
}

function checksum(fsmList, n) {
  let h = updates >>> 0;
  for (let i = 0; i < n; i++) h = (Math.imul(h, 31) + sums[i]) >>> 0;
  for (const F of fsmList) {
    for (let i = 0; i < n; i++) h = (Math.imul(h, 31) + F.state[i] * 1000 + (F.time[i] | 0)) >>> 0;
  }
  return h;
}

/** One case in this process: the median frame over `rounds` runs of `frames` frames, and the checksum of a round. */
export async function runCase(name, { entities = 30000, frames = 100, rounds = 7, hooks = 'predator', check = false } = {}) {
  const c = CASES[name];
  if (!c) throw new Error(`unknown case ${name}; cases: ${Object.keys(CASES).join(', ')}`);
  const hookSpec = HOOKS[hooks];
  if (!hookSpec) throw new Error(`unknown --hooks ${hooks} (${Object.keys(HOOKS).join(', ')})`);
  const staggered = c.intervals[0] > 1 || c.intervals[1] > 1;
  const civilians = Math.round((entities * 2) / 3);
  const soldiers = entities - civilians;
  const scene = buildPoolScene({ entities });
  RigidBody.initializeArrays(new SharedArrayBuffer(RigidBody.getBufferSize(entities)), entities);
  sums = new Int32Array(entities);
  const fsms = makeFsms(hookSpec);
  const fsmList = [fsms.CivilianBehaviorFSM, fsms.PersonAnimationFSM, fsms.SoldierBehaviorFSM];
  for (const F of fsmList) F.initializeArrays(new SharedArrayBuffer(F.getBufferSize(entities)), entities);
  scene.config.logic = { staggeredUpdates: staggered };
  // What logic.staggeredUpdates binds (the countdown buffer): the logic worker decimates a type only with it.
  GameObject.nextTick = staggered ? new Uint8Array(entities) : null;
  const lw = await loadWorker('logicWorker.js', 'logicWorker');
  lw.config = scene.config;
  lw.globalEntityCount = entities;
  lw.gameObjects = new Array(entities).fill(null);
  lw.totalLogicWorkers = 1;
  lw.workerIndex = 0;
  const types = makeOwners(fsms, c.path, c.intervals);
  const pools = [
    { C: types[0], start: 0, size: civilians },
    { C: types[1], start: civilians, size: soldiers },
  ];
  lw.registeredClasses = pools.map((p, t) => {
    globalThis.self[p.C.name] = p.C;
    p.C._activeList = new (EntityIdArray())(1 + p.size); // the active lists' buffer is bound elsewhere in a scene
    return { name: p.C.name, poolSize: p.size, startIndex: p.start, endIndex: p.start + p.size - 1, entityType: t };
  });
  await quietly(() => lw.createGameObjectInstances());
  for (const p of pools) {
    for (let k = 0; k < p.size; k++) {
      p.C._activeList[1 + k] = p.start + k;
      Transform.active[p.start + k] = 1;
    }
  }
  const ticked = lw.nonDecimatedTypes.length + lw.decimatedTypes.length;
  const batched = lw.tickAllTypes.length + lw.tickAllBucketTypes.length;
  const classified = c.path === 'tick' ? ticked === 2 && batched === 0 : batched === 2 && ticked === 0;
  if (!classified) {
    throw new Error(
      `${name}: the logic worker ticks ${ticked} types and batches ${batched}` +
        (c.path === 'tickAll' ? ' (before E-526 a type with FSMs and no tick() is not ticked)' : ''),
    );
  }

  let frameNumber = 0;
  const frame = () => {
    lw.frameNumber = ++frameNumber;
    lw.update(16.67, 1, false);
  };
  const setListed = (n) => {
    for (const p of pools) p.C._activeList[0] = Math.min(n, p.size);
  };
  // Each round starts from the FSMs' initial states, time 0, nothing pending, and the same frame numbers.
  const reset = () => {
    for (const F of fsmList) {
      F.state.fill(F.initial.stateIndex);
      F.time.fill(0);
      F.nextState.fill(-1);
    }
    sums.fill(0);
    updates = 0;
    frameNumber = 1000;
  };
  if (!check) {
    setListed(WARM_ENTITIES);
    await quietly(() => warmNormalCompile(frame, 3000));
  }
  setListed(entities);
  for (let f = 0; f < 50; f++) frame();

  const runRound = () => {
    reset();
    const t0 = performance.now();
    for (let f = 0; f < frames; f++) frame();
    return performance.now() - t0;
  };
  runRound();
  const sum = checksum(fsmList, entities);
  const updateCount = updates;
  if (updateCount === 0) throw new Error(`${name}: no onUpdate ran`);
  const row = { case: name, ...c, entities, frames, rounds, hooks, checksum: sum, updates: updateCount };
  if (check) return row;
  const runs = [];
  for (let r = 0; r < rounds; r++) {
    runs.push(runRound());
    if (checksum(fsmList, entities) !== sum) throw new Error(`${name}: the checksum moved in round ${r}`);
  }
  const ms = [...runs].sort((p, q) => p - q)[runs.length >> 1];
  return {
    ...row,
    msPerFrame: ms / frames,
    framesPerSec: (frames * 1000) / ms,
    updatesPerFrame: updateCount / frames,
    nsPerUpdate: (ms * 1e6) / updateCount,
    runs,
  };
}

/** Every case (or the listed ones), each in a child process; the child's other output passes through. */
export function runAll({ entities = 30000, frames = 100, rounds = 7, hooks = 'predator', check = false, cases = Object.keys(CASES) } = {}) {
  const file = fileURLToPath(import.meta.url);
  const rows = [];
  for (const name of cases) {
    const args = [
      ...process.execArgv, file, '--case', name, '--entities', String(entities), '--frames', String(frames),
      '--rounds', String(rounds), '--hooks', hooks, '--child',
    ];
    if (check) args.push('--check');
    const child = spawnSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'inherit'] });
    if (child.status !== 0) throw new Error(`case ${name} exited ${child.status}`);
    let row = null;
    for (const line of child.stdout.split('\n')) {
      if (line.startsWith(RESULT_PREFIX)) row = JSON.parse(line.slice(RESULT_PREFIX.length));
      else if (line.length > 0) console.log(line);
    }
    if (!row) throw new Error(`case ${name} printed no result`);
    rows.push(row);
  }
  return { kernel: 'fsmTickAll', entities, frames, rounds, hooks, rows };
}

if (isCli(import.meta.url)) {
  const args = parseArgs();
  const opts = {
    entities: args.entities ?? 30000,
    frames: args.frames ?? 100,
    rounds: args.rounds ?? 7,
    hooks: args.hooks ? String(args.hooks) : 'predator',
    check: Boolean(args.check),
  };
  if (args.child) {
    const row = await runCase(String(args.case), opts);
    console.log(RESULT_PREFIX + JSON.stringify(row));
  } else {
    const cases = args.case ? String(args.case).split(',') : undefined;
    const res = runAll({ ...opts, cases });
    console.log(`${res.entities} entities, hooks ${res.hooks}, ${res.frames} frames a round, median of ${res.rounds} rounds`);
    for (const r of res.rows) {
      const timing = opts.check
        ? ''
        : `${r.msPerFrame.toFixed(4)} ms a frame  ${r.framesPerSec.toFixed(0).padStart(6)} frames/s  ` +
          `${r.nsPerUpdate.toFixed(2)} ns an onUpdate  `;
      console.log(`  ${r.case.padEnd(16)} ${timing}${r.updates} onUpdates  checksum ${r.checksum}`);
    }
    if (args.output) writeReport(args.output, res);
  }
}
