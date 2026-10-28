#!/usr/bin/env node
/**
 * E-146 (the FSM half): `FSM.tick` over Predator's shape of state machines, called from the entities' own ticks the
 * way games call it.
 *
 *   node tests/bench/runKernelVariants.mjs --script tests/bench/fsmTickMicrobench.mjs --variants shipped,fnArray,cached,msCached
 *   node tests/bench/fsmTickMicrobench.mjs --variant shipped [--entities 3000] [--output path]
 *
 * Three FSM classes with Predator's state counts (3, 9 and 5: 17 state classes, so the load of `onUpdate` from the
 * current state class sees 17 maps), two owner classes with Predator's tickIntervals (4 and 6), each owner ticking an
 * animation FSM and a behaviour FSM. Each state's onUpdate adds to its owner and leaves for another state after a time
 * of its own, so transitions happen at a few per hundred ticks.
 *
 * shipped:  the real FSM (src/core/fsm.js).
 * fnArray:  a subclass whose tick reads the state's onUpdate from a per-class array of functions (one element load on
 *           one array map) and calls it with the state class as receiver.
 * cached:   fnArray, and the owner's ms per tick read once per FSM instance rather than through owner.constructor.
 * msCached: the shipped dispatch, and that ms per tick read once per FSM instance.
 * One variant per process: FSM classes, states and owners made in one process share their call sites' feedback, so
 * two variants there would each see the other's maps. Reports ops/s (one op = one tick of every owner) and a checksum
 * after 600 ticks (the owners' sums and every FSM's states and times).
 */
import { FSM } from '../../src/core/fsm.js';
import { FSMState } from '../../src/core/fsmState.js';
import { isCli, parseArgs, timeIt, warmNormalCompile, writeReport } from './microbenchHelpers.mjs';

/** Per state: how long it stays (ms) and the state it goes to (index in its FSM). */
function makeStates(n, salt) {
  const states = {};
  for (let s = 0; s < n; s++) {
    const stay = 200 + ((s * 137 + salt * 59) % 900);
    const next = (s + 1 + (salt % 2)) % n;
    // A class per state, as games write them: each is its own function, with its own map.
    const State = {
      [`S${salt}_${s}`]: class extends FSMState {
        static onUpdate(owner, i, dt, timeInState) {
          owner.sum += (timeInState & 7) + s;
          if (timeInState > stay) this.fsm.changeState(i, this.fsm._stateArray[next]);
        }
      },
    }[`S${salt}_${s}`];
    states[`S${s}`] = State;
  }
  return states;
}

function makeFsms(Base) {
  class CivilianBehavior extends Base {
    static states = makeStates(3, 1);
    static initial = this.states.S0;
  }
  class PersonAnimation extends Base {
    static states = makeStates(9, 2);
    static initial = this.states.S0;
  }
  class SoldierBehavior extends Base {
    static states = makeStates(5, 3);
    static initial = this.states.S0;
  }
  return [CivilianBehavior, PersonAnimation, SoldierBehavior];
}

class FnArrayFSM extends FSM {
  static _linkStates() {
    super._linkStates();
    this._onUpdates = this._stateArray.map((S) => S.onUpdate);
  }

  tick(dt, owner) {
    if (!owner) return console.warn('FSM.tick called without owner', this.constructor.name);
    const i = this.index;
    const FSMClass = this.constructor;
    const pending = FSMClass.nextState[i];
    if (pending >= 0) FSMClass._executeTransition(i, pending, owner);
    const s = FSMClass.state[i];
    const CurrentState = FSMClass._stateArray[s];
    if (CurrentState) {
      const tickInterval = owner?.constructor?.tickInterval || 1;
      FSMClass.time[i] += dt * 16.67 * tickInterval;
      FSMClass._onUpdates[s].call(CurrentState, owner, i, dt, FSMClass.time[i] | 0);
    }
  }
}

class CachedFSM extends FnArrayFSM {
  constructor(index) {
    super(index);
    this.msPerTick = NaN;
  }

  tick(dt, owner) {
    if (!owner) return console.warn('FSM.tick called without owner', this.constructor.name);
    const i = this.index;
    const FSMClass = this.constructor;
    const pending = FSMClass.nextState[i];
    if (pending >= 0) FSMClass._executeTransition(i, pending, owner);
    const s = FSMClass.state[i];
    const CurrentState = FSMClass._stateArray[s];
    if (CurrentState) {
      let ms = this.msPerTick;
      if (ms !== ms) ms = this.msPerTick = 16.67 * (owner.constructor.tickInterval || 1);
      FSMClass.time[i] += dt * ms;
      FSMClass._onUpdates[s].call(CurrentState, owner, i, dt, FSMClass.time[i] | 0);
    }
  }
}

class MsCachedFSM extends FSM {
  constructor(index) {
    super(index);
    this.msPerTick = NaN;
  }

  tick(dt, owner) {
    if (!owner) return console.warn('FSM.tick called without owner', this.constructor.name);
    const i = this.index;
    const FSMClass = this.constructor;
    const pending = FSMClass.nextState[i];
    if (pending >= 0) FSMClass._executeTransition(i, pending, owner);
    const CurrentState = FSMClass._stateArray[FSMClass.state[i]];
    if (CurrentState) {
      let ms = this.msPerTick;
      if (ms !== ms) ms = this.msPerTick = 16.67 * (owner.constructor.tickInterval || 1);
      FSMClass.time[i] += dt * ms;
      CurrentState.onUpdate(owner, i, dt, FSMClass.time[i] | 0);
    }
  }
}

/** Owners as Predator's: civilians (tickInterval 4) and soldiers (6), an animation FSM and a behaviour FSM each. */
function build(Base, count) {
  const [CivilianBehavior, PersonAnimation, SoldierBehavior] = makeFsms(Base);
  for (const F of [CivilianBehavior, PersonAnimation, SoldierBehavior]) {
    F.initializeArrays(new ArrayBuffer(F.getBufferSize(count)), count);
  }
  class Civilian {
    static tickInterval = 4;
    constructor(index) {
      this.index = index;
      this.sum = 0;
      this.animation = new PersonAnimation(index);
      this.behavior = new CivilianBehavior(index);
    }
    reset() {
      this.sum = 0;
      for (const F of [this.animation.constructor, this.behavior.constructor]) {
        F.state[this.index] = F.initial.stateIndex;
        F.time[this.index] = 0;
        F.nextState[this.index] = -1;
      }
    }
    tick(dt) {
      this.animation.tick(dt, this);
      this.behavior.tick(dt, this);
    }
  }
  class Soldier {
    static tickInterval = 6;
    constructor(index) {
      this.index = index;
      this.sum = 0;
      this.animation = new PersonAnimation(index);
      this.behavior = new SoldierBehavior(index);
    }
    reset() {
      this.sum = 0;
      for (const F of [this.animation.constructor, this.behavior.constructor]) {
        F.state[this.index] = F.initial.stateIndex;
        F.time[this.index] = 0;
        F.nextState[this.index] = -1;
      }
    }
    tick(dt) {
      this.animation.tick(dt, this);
      this.behavior.tick(dt, this);
    }
  }
  const owners = [];
  for (let i = 0; i < count; i++) owners.push(i % 3 === 2 ? new Soldier(i) : new Civilian(i));
  return { owners, fsms: [CivilianBehavior, PersonAnimation, SoldierBehavior] };
}

function tickAll(owners) {
  for (let i = 0; i < owners.length; i++) owners[i].tick(1);
}

function checksum({ owners, fsms }) {
  let h = 0;
  for (const o of owners) h = (h * 31 + o.sum) >>> 0;
  for (const F of fsms) {
    for (let i = 0; i < owners.length; i++) h = (h * 31 + F.state[i] * 1000 + (F.time[i] | 0)) >>> 0;
  }
  return h;
}

const VARIANTS = { shipped: FSM, fnArray: FnArrayFSM, cached: CachedFSM, msCached: MsCachedFSM };

export function runFsmTickMicrobench({ variant = 'shipped', entities = 3000 } = {}) {
  const Base = VARIANTS[variant];
  if (!Base) throw new Error(`unknown variant ${variant} (${Object.keys(VARIANTS).join(', ')})`);
  const w = build(Base, entities);
  // Warm-up through short calls first (a normal compile, not OSR), then the checksum's 600 ticks from the same start.
  const few = w.owners.slice(0, 60);
  warmNormalCompile(() => tickAll(few));
  for (const o of w.owners) o.reset();
  const frames = 600;
  for (let f = 0; f < frames; f++) tickAll(w.owners);
  const sum = checksum(w);
  const cases = {
    tick: timeIt(`fsm tick ${variant} (${entities} owners, 2 FSMs each)`, () => tickAll(w.owners), {
      iterations: 200,
      warmup: 50,
    }),
  };
  return { variant, entities, checksum: sum, cases };
}

if (isCli(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const result = runFsmTickMicrobench({
    variant: args.variant || 'shipped',
    entities: args.entities ? Number(args.entities) : 3000,
  });
  if (args.output) writeReport(String(args.output), result);
}
