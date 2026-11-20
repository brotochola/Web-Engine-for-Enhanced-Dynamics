import test from 'node:test';
import assert from 'node:assert/strict';

import { loadWorker, postedMessages, quietly } from '../bench/workerHarness.mjs';
import { buildPoolScene } from '../helpers/poolScene.mjs';
import { GameObject } from '../../src/core/gameObject.js';
import { FSM } from '../../src/core/fsm.js';
import { FSMState } from '../../src/core/fsmState.js';
import { Transform } from '../../src/components/transform.js';
import { RigidBody } from '../../src/components/rigidBody.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { EntityIdArray } from '../../src/util/entityIdWidth.js';

// E-526: a type with FSM components and neither a tick() nor a static tickAll had FSMs that never ran (the logic
// workers skip a type without tick()). Its FSMs now run through FSM.tickAll, as a tickAll type: each state's
// onUpdate(i, dt, timeInState), each pending transition's onExit and onEnter, entity by entity in the active list's order and, on one entity, its FSMs in its components order. Those are
// the calls a tick() that runs its FSMs makes (this.walkFSM.tick(dt, this); this.lookFSM.tick(dt, this)), so the tests
// run a type with such a tick() beside one with none and compare what their states saw. Through the real logic worker:
// createGameObjectInstances classifies the types, update() runs the frames.

const PER_TYPE = 12; // a multiple of 4: the pools' ids have the same tick phases, shifted by PER_TYPE
const MAX_TYPES = 4;
const N = MAX_TYPES * PER_TYPE;

let log = [];
let boomSlot = -1; // the pool slot whose WALK onUpdate throws (in each pool), -1 for none
let slotClass = []; // each entity index's class, from setup: a state gets the index only (E-532)

/** What a hook saw, its entity given as its slot in its pool. */
function note(kind, fsm, state, i, extra) {
  const C = slotClass[i];
  log.push({ who: C.name, entry: [kind, fsm, state, i - C.startIndex, ...extra] });
}

class IdleState extends FSMState {
  static onEnter(i, fromState) {
    note('enter', 'walk', 'IDLE', i, [fromState, this === IdleState]);
  }
  static onExit(i, toState) {
    note('exit', 'walk', 'IDLE', i, [toState, this === IdleState]);
  }
  static onUpdate(i, dt, timeInState) {
    note('update', 'walk', 'IDLE', i, [dt, timeInState, this === IdleState]);
    if (timeInState > 40 + (i % 3) * 17) this.fsm.changeState(i, this.fsm.states.WALK);
  }
}

class WalkState extends FSMState {
  static onEnter(i, fromState) {
    note('enter', 'walk', 'WALK', i, [fromState, this === WalkState]);
  }
  static onExit(i, toState) {
    note('exit', 'walk', 'WALK', i, [toState, this === WalkState]);
  }
  static onUpdate(i, dt, timeInState) {
    if (i - slotClass[i].startIndex === boomSlot) throw new Error('walk boom');
    note('update', 'walk', 'WALK', i, [dt, timeInState, this === WalkState]);
    if (timeInState > 60) this.fsm.changeState(i, this.fsm.states.IDLE);
  }
}

class WalkFSM extends FSM {
  static states = { IDLE: IdleState, WALK: WalkState };
  static initial = this.states.IDLE;
}

class LeftState extends FSMState {
  static onUpdate(i, dt, timeInState) {
    note('update', 'look', 'LEFT', i, [dt, timeInState, this === LeftState]);
    if (timeInState > 30) this.fsm.changeState(i, this.fsm.states.RIGHT);
  }
}

class RightState extends FSMState {
  static onEnter(i, fromState) {
    note('enter', 'look', 'RIGHT', i, [fromState, this === RightState]);
  }
  static onUpdate(i, dt, timeInState) {
    note('update', 'look', 'RIGHT', i, [dt, timeInState, this === RightState]);
    if (timeInState > 30 + (i % 2) * 20) this.fsm.changeState(i, this.fsm.states.LEFT);
  }
}

class LookFSM extends FSM {
  static states = { LEFT: LeftState, RIGHT: RightState };
  static initial = this.states.LEFT;
}

/** The reference: a tick() that runs its FSMs, as games write it. */
class Ticker extends GameObject {
  static components = [SpriteRenderer, WalkFSM, LookFSM];
  tick(dtRatio) {
    this.walkFSM.tick(dtRatio);
    this.lookFSM.tick(dtRatio);
  }
}

/** The same FSMs and no tick(): the engine runs them. */
class Plain extends GameObject {
  static components = [SpriteRenderer, WalkFSM, LookFSM];
}

class Ticker4 extends Ticker {
  static tickInterval = 4;
}

class Plain4 extends GameObject {
  static components = [SpriteRenderer, WalkFSM, LookFSM];
  static tickInterval = 4;
}

/** FSMs and its own tickAll, which does not call FSM.tickAll: its states never run. */
class Herd extends GameObject {
  static components = [SpriteRenderer, WalkFSM];
  static tickAll(list, count) {
    log.push({ who: 'Herd', entry: ['tickAll', count] });
  }
}

/** Its own tickAll around FSM.tickAll: its FSMs run where it calls it. */
class Pack extends GameObject {
  static components = [SpriteRenderer, WalkFSM, LookFSM];
  static tickAll(list, count, dtRatio) {
    log.push({ who: 'Pack', entry: ['before', count] });
    FSM.tickAll(list, count, dtRatio, this);
    log.push({ who: 'Pack', entry: ['after', count] });
  }
}

/** Calls one FSM subclass's tickAll: that FSM alone runs. */
class Glancer extends GameObject {
  static components = [SpriteRenderer, WalkFSM, LookFSM];
  static tickAll(list, count, dtRatio) {
    LookFSM.tickAll(list, count, dtRatio, this);
  }
}

/** tickInterval 0: the logic workers never visit it, FSMs or not. */
class Statue extends GameObject {
  static components = [SpriteRenderer, WalkFSM];
  static tickInterval = 0;
}

/**
 * A logic worker with `classes` registered in PER_TYPE pools from index 0, every slot active and listed, the FSMs at
 * their initial states.
 */
async function setup(classes, { staggered = false } = {}) {
  const scene = buildPoolScene({ entities: N });
  RigidBody.initializeArrays(new SharedArrayBuffer(RigidBody.getBufferSize(N)), N);
  for (const F of [WalkFSM, LookFSM]) F.initializeArrays(new SharedArrayBuffer(F.getBufferSize(N)), N);
  GameObject.nextTick = staggered ? new Uint8Array(N) : null;
  GameObject.typeListVersions = null;
  const lw = await loadWorker('logicWorker.js', 'logicWorker');
  lw.config = { ...scene.config, logic: { staggeredUpdates: staggered } };
  lw.globalEntityCount = N;
  lw.gameObjects = new Array(N).fill(null);
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
  slotClass = new Array(N);
  lw.registeredClasses = classes.map((C, t) => {
    for (let k = 0; k < PER_TYPE; k++) slotClass[t * PER_TYPE + k] = C;
    globalThis.self[C.name] = C;
    C._activeList = new (EntityIdArray())(1 + PER_TYPE);
    return { name: C.name, poolSize: PER_TYPE, startIndex: t * PER_TYPE, endIndex: (t + 1) * PER_TYPE - 1, entityType: t };
  });
  await quietly(() => lw.createGameObjectInstances());
  for (let t = 0; t < classes.length; t++) {
    const list = classes[t]._activeList;
    list[0] = PER_TYPE;
    for (let k = 0; k < PER_TYPE; k++) {
      list[1 + k] = t * PER_TYPE + k;
      Transform.active[t * PER_TYPE + k] = 1;
    }
  }
  log = [];
  boomSlot = -1;
  return lw;
}

function frame(lw, f, dtRatio) {
  lw.frameNumber = f;
  lw.update(16.67 * dtRatio, dtRatio, false);
}

function entriesOf(who) {
  return log.filter((e) => e.who === who).map((e) => e.entry);
}

function restore() {
  GameObject.nextTick = null;
  Transform.active.fill(0);
  boomSlot = -1;
}

test('a type with FSMs and no tick(): its states get the calls a tick() that runs its FSMs makes, frame by frame', { concurrency: false }, async () => {
  try {
    const lw = await setup([Ticker, Plain]);
    assert.equal(lw.nonDecimatedTypes.length, 1, 'Ticker ticks entity by entity');
    assert.equal(lw.tickAllTypes.length, 1, 'Plain is a tickAll type');
    assert.equal(lw.tickAllTypes[0].EntityClass, Plain);
    assert.equal(lw.tickAllTypes[0].ticker, FSM, 'its tickAll is FSM.tickAll');
    let updates = 0;
    let transitions = 0;
    for (let f = 1; f <= 16; f++) {
      log = [];
      frame(lw, f, 0.75 + f / 16); // a different dtRatio each frame
      const ticked = entriesOf('Ticker');
      const batched = entriesOf('Plain');
      assert.deepEqual(batched, ticked, `frame ${f}: the same calls, arguments and order`);
      updates += batched.filter((e) => e[0] === 'update').length;
      transitions += batched.filter((e) => e[0] === 'enter').length;
      // Entity by entity, its walk FSM then its look FSM (components order).
      const updated = batched.filter((e) => e[0] === 'update').map((e) => `${e[3]}${e[1]}`);
      assert.deepEqual(updated.slice(0, 4), ['0walk', '0look', '1walk', '1look'], `frame ${f}: entity by entity`);
    }
    assert.equal(updates, 16 * PER_TYPE * 2, 'each FSM of each entity every frame');
    assert.ok(transitions > PER_TYPE, `transitions ran (${transitions})`);
    for (let k = 0; k < PER_TYPE; k++) {
      assert.equal(GameObject.instances[PER_TYPE + k] ?? null, null, 'E-532: its FSMs made no instance');
      assert.equal(WalkFSM.state[PER_TYPE + k], WalkFSM.state[k], `entity ${k}: the same walk state`);
      assert.equal(WalkFSM.time[PER_TYPE + k], WalkFSM.time[k], `entity ${k}: the same time in state`);
      assert.equal(LookFSM.state[PER_TYPE + k], LookFSM.state[k], `entity ${k}: the same look state`);
    }
  } finally {
    restore();
  }
});

test('tickInterval 4 with logic.staggeredUpdates: the FSMs tick on the buckets tick() ticks, a quarter a frame (E-527)', { concurrency: false }, async () => {
  try {
    const lw = await setup([Ticker4, Plain4], { staggered: true });
    assert.equal(lw.decimatedTypes.length, 1, 'Ticker4 ticks through the buckets');
    assert.equal(lw.tickAllBucketTypes.length, 1, 'Plain4 is a bucketed tickAll type');
    assert.equal(lw.tickAllBucketTypes[0].ticker, FSM);
    const seen = new Map();
    for (let f = 1; f <= 12; f++) {
      log = [];
      const dtRatio = 1 + (f % 3) / 4;
      frame(lw, f, dtRatio);
      const ticked = entriesOf('Ticker4');
      const batched = entriesOf('Plain4');
      assert.deepEqual(batched, ticked, `frame ${f}: the same calls, arguments and order`);
      if (f <= 4) {
        // Each entity's first tick: its time in state is one tick of 4 frames, 16.67 x 4 x dtRatio (FSM#tick's count).
        const firstTicks = batched.filter((e) => e[0] === 'update' && e[1] === 'walk');
        const ms = Math.fround(dtRatio * (16.67 * 4)) | 0;
        assert.ok(firstTicks.length > 0 && firstTicks.every((e) => e[4] === dtRatio && e[5] === ms), `frame ${f}: ${ms} ms`);
      }
      const ids = [...new Set(batched.filter((e) => e[0] === 'update').map((e) => e[3]))];
      assert.equal(ids.length, PER_TYPE / 4, `frame ${f}: a quarter of the entities`);
      for (const id of ids) {
        if (seen.has(id)) assert.equal(f - seen.get(id), 4, `entity ${id} again 4 frames later`);
        seen.set(id, f);
      }
    }
    assert.equal(seen.size, PER_TYPE);
  } finally {
    restore();
  }
});

test("transitions: onExit with the next state's name, then onEnter with the previous one, before the onUpdate", { concurrency: false }, async () => {
  try {
    const lw = await setup([Plain]);
    const walkOfSlot0 = [];
    for (let f = 1; f <= 4; f++) {
      log = [];
      frame(lw, f, 1);
      walkOfSlot0.push(entriesOf('Plain').filter((e) => e[3] === 0 && e[1] === 'walk'));
    }
    // Slot 0 asks for WALK when its time passes 40 ms (16, 33, 50: on its third tick), so its fourth starts with the
    // transition.
    assert.deepEqual(walkOfSlot0[2], [['update', 'walk', 'IDLE', 0, 1, 50, true]]);
    assert.deepEqual(walkOfSlot0[3], [
      ['exit', 'walk', 'IDLE', 0, 'WALK', true],
      ['enter', 'walk', 'WALK', 0, 'IDLE', true],
      ['update', 'walk', 'WALK', 0, 1, 16, true],
    ]);
    assert.equal(WalkFSM.getStateName(0), 'WALK');
  } finally {
    restore();
  }
});

test("a type with its own tickAll is left alone; it can call FSM.tickAll, or one FSM's; tickInterval 0 is not visited", { concurrency: false }, async () => {
  try {
    const lw = await setup([Herd, Pack, Glancer, Statue]);
    const tickers = new Map(lw.tickAllTypes.map((t) => [t.EntityClass, t.ticker]));
    assert.equal(tickers.get(Herd), Herd, "Herd's own tickAll runs");
    assert.equal(tickers.get(Pack), Pack);
    assert.equal(tickers.get(Glancer), Glancer);
    assert.ok(!tickers.has(Statue), 'tickInterval 0: no visit');
    assert.equal(lw.nonDecimatedTypes.length + lw.decimatedTypes.length + lw.tickAllBucketTypes.length, 0);
    for (let f = 1; f <= 6; f++) {
      log = [];
      frame(lw, f, 1);
      assert.deepEqual(entriesOf('Herd'), [['tickAll', PER_TYPE]], `frame ${f}: Herd's tickAll, none of its states`);
      const pack = entriesOf('Pack');
      assert.deepEqual(pack[0], ['before', PER_TYPE]);
      assert.deepEqual(pack[pack.length - 1], ['after', PER_TYPE]);
      assert.equal(pack.filter((e) => e[0] === 'update').length, 2 * PER_TYPE, "both FSMs, inside Pack's tickAll");
      const glancer = entriesOf('Glancer');
      assert.ok(glancer.length >= PER_TYPE && glancer.every((e) => e[1] === 'look'), 'LookFSM.tickAll: the look FSM only');
      assert.equal(entriesOf('Statue').length, 0);
    }
  } finally {
    restore();
  }
});

test('E-532: a type whose tickAll calls FSM.tickAll makes no instance for its FSMs either', { concurrency: false }, async () => {
  try {
    const lw = await setup([Pack]);
    for (let f = 1; f <= 8; f++) frame(lw, f, 1);
    assert.ok(entriesOf('Pack').filter((e) => e[0] === 'update').length >= 2 * PER_TYPE, "Pack's states ran");
    for (let k = 0; k < PER_TYPE; k++) assert.equal(GameObject.instances[k] ?? null, null, `no instance at slot ${k}`);
  } finally {
    restore();
  }
});

test('a state that throws: reported with its entity, the tick goes on at the next entity, as the tick() loop does', { concurrency: false }, async () => {
  const savedError = console.error;
  console.error = () => {};
  try {
    const lw = await setup([Ticker, Plain]);
    // Slot 3 leaves IDLE on its fourth tick (its time passes 40 ms on the third); from then its WALK onUpdate throws,
    // in each pool.
    boomSlot = 3;
    let threw = 0;
    for (let f = 1; f <= 6; f++) {
      log = [];
      frame(lw, f, 1);
      const ticked = entriesOf('Ticker');
      assert.deepEqual(entriesOf('Plain'), ticked, `frame ${f}: the same calls around the throw`);
      if (f >= 4) {
        threw++;
        const slot3 = ticked.filter((e) => e[3] === 3 && e[0] === 'update');
        assert.equal(slot3.length, 0, `frame ${f}: slot 3's look FSM skipped after its walk FSM threw`);
        const slot4 = ticked.filter((e) => e[3] === 4 && e[0] === 'update');
        assert.equal(slot4.length, 2, `frame ${f}: slot 4's FSMs ran`);
      }
    }
    assert.equal(threw, 3);
    const errors = postedMessages().filter((m) => m.msg === 'entityError' && m.message === 'walk boom');
    const plain = errors.find((m) => m.className === 'Plain');
    assert.ok(plain, "Plain's throw was reported");
    assert.equal(plain.phase, 'FSM.tickAll');
    assert.equal(plain.entityIndex, PER_TYPE + 3);
    assert.ok(errors.find((m) => m.className === 'Ticker' && m.phase === 'tick'), "as Ticker's tick() throw is");
  } finally {
    console.error = savedError;
    restore();
  }
});

test('FSM.tickAll without the entity class says what to pass', () => {
  assert.throws(() => FSM.tickAll([0], 1, 1), /pass the entities' class/);
});
