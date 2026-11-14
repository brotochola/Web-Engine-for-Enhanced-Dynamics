#!/usr/bin/env node
/**
 * E-146 (the FSM half), E-301 (the transition): `FSM.tick` over Predator's shape of state machines, called from the
 * entities' own ticks the way games call it.
 *
 *   node tests/bench/runKernelVariants.mjs --script tests/bench/fsmTickMicrobench.mjs --variants shipped,fnArray,cached,msCached
 *   node tests/bench/fsmTickMicrobench.mjs --variant shipped [--entities 3000] [--hooks none|predator|all]
 *     [--stay-scale 1] [--check] [--output path]
 *
 * Three FSM classes with Predator's state counts (3, 9 and 5: 17 state classes, so the load of `onUpdate` from the
 * current state class sees 17 maps), two owner classes with Predator's tickIntervals (4 and 6), each owner ticking an
 * animation FSM and a behaviour FSM. Each state's onUpdate adds to its owner and leaves for another state after a time
 * of its own (200 to 1100 ms, times `--stay-scale`), so an FSM changes state every few of its owner's ticks.
 *
 * --hooks (E-301: what a transition calls):
 *   none:     no state defines onEnter or onExit (they inherit FSMState's empty ones). The kernel before E-301.
 *   predator: Predator's own: an onEnter on all 9 animation states, on 4 of the soldier's 5 and 1 of the civilian's
 *             3, an onExit on 2 of the civilian's 3.
 *   all:      every state defines both.
 * Each hook adds its state and the other state's number (from the name it is passed) to the owner, so the checksum
 * holds the hooks' calls, their arguments and their order against the state writes.
 * --stay-scale 0 makes every FSM change state on every tick of its owner (a transition per FSM tick).
 *
 * shipped:  the real FSM (src/core/fsm.js).
 * fnArray:  a subclass whose tick reads the state's onUpdate from a per-class array of functions (one element load on
 *           one array map) and calls it with the state class as receiver.
 * cached:   fnArray, and the owner's ms per tick read once per FSM instance rather than through owner.constructor.
 * msCached: the shipped dispatch, and that ms per tick read once per FSM instance.
 * One variant per process: FSM classes, states and owners made in one process share their call sites' feedback, so
 * two variants there would each see the other's maps. Reports ops/s (one op = one tick of every owner), a checksum
 * after 600 ticks (the owners' sums and every FSM's states and times) and the transitions per op over those ticks.
 * --check stops after the checksum (no timing).
 */
import { FSM } from '../../src/core/fsm.js';
import { FSMState } from '../../src/core/fsmState.js';
import { isCli, parseArgs, timeIt, warmNormalCompile, writeReport } from './microbenchHelpers.mjs';

/** The state number in a state's name ('S3' → 3), or 7 for none (an FSM's first state has no previous one). */
function stateNumber(name) {
  return name === null ? 7 : name.charCodeAt(1) - 48;
}

/**
 * One state class. Four class literals, by which hooks the state defines, as games write them (statics in the
 * literal); each evaluation is its own function, with its own map.
 */
function makeState(s, stay, next, enter, exit) {
  if (enter && exit) {
    return class extends FSMState {
      static onEnter(owner, i, fromState) {
        owner.sum += 3 + s * 11 + stateNumber(fromState);
      }
      static onExit(owner, i, toState) {
        owner.sum += 5 + s * 13 + stateNumber(toState) * 17;
      }
      static onUpdate(owner, i, dt, timeInState) {
        owner.sum += (timeInState & 7) + s;
        if (timeInState > stay) this.fsm.changeState(i, this.fsm._stateArray[next]);
      }
    };
  }
  if (enter) {
    return class extends FSMState {
      static onEnter(owner, i, fromState) {
        owner.sum += 3 + s * 11 + stateNumber(fromState);
      }
      static onUpdate(owner, i, dt, timeInState) {
        owner.sum += (timeInState & 7) + s;
        if (timeInState > stay) this.fsm.changeState(i, this.fsm._stateArray[next]);
      }
    };
  }
  if (exit) {
    return class extends FSMState {
      static onExit(owner, i, toState) {
        owner.sum += 5 + s * 13 + stateNumber(toState) * 17;
      }
      static onUpdate(owner, i, dt, timeInState) {
        owner.sum += (timeInState & 7) + s;
        if (timeInState > stay) this.fsm.changeState(i, this.fsm._stateArray[next]);
      }
    };
  }
  return class extends FSMState {
    static onUpdate(owner, i, dt, timeInState) {
      owner.sum += (timeInState & 7) + s;
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
function makeStates(n, salt, hooks, stayScale) {
  const states = {};
  for (let s = 0; s < n; s++) {
    const stay = Math.round((200 + ((s * 137 + salt * 59) % 900)) * stayScale);
    const next = (s + 1 + (salt % 2)) % n;
    states[`S${s}`] = makeState(s, stay, next, hooks.enter(salt, s), hooks.exit(salt, s));
  }
  return states;
}

function makeFsms(Base, hooks, stayScale) {
  class CivilianBehavior extends Base {
    static states = makeStates(3, 1, hooks, stayScale);
    static initial = this.states.S0;
  }
  class PersonAnimation extends Base {
    static states = makeStates(9, 2, hooks, stayScale);
    static initial = this.states.S0;
  }
  class SoldierBehavior extends Base {
    static states = makeStates(5, 3, hooks, stayScale);
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
function build(Base, count, hooks, stayScale) {
  const [CivilianBehavior, PersonAnimation, SoldierBehavior] = makeFsms(Base, hooks, stayScale);
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

/** Entries whose state changed since the last copy of the FSMs' state columns (no state here leaves for itself). */
function countChanged(fsms, before, n) {
  let changed = 0;
  for (let f = 0; f < fsms.length; f++) {
    const now = fsms[f].state;
    const was = before[f];
    for (let i = 0; i < n; i++) {
      if (now[i] !== was[i]) {
        changed++;
        was[i] = now[i];
      }
    }
  }
  return changed;
}

const VARIANTS = { shipped: FSM, fnArray: FnArrayFSM, cached: CachedFSM, msCached: MsCachedFSM };

export function runFsmTickMicrobench({ variant = 'shipped', entities = 3000, hooks = 'none', stayScale = 1, check = false } = {}) {
  const Base = VARIANTS[variant];
  if (!Base) throw new Error(`unknown variant ${variant} (${Object.keys(VARIANTS).join(', ')})`);
  const hookSpec = HOOKS[hooks];
  if (!hookSpec) throw new Error(`unknown --hooks ${hooks} (${Object.keys(HOOKS).join(', ')})`);
  if (!(stayScale >= 0)) throw new Error(`--stay-scale must be a number >= 0, got ${stayScale}`);
  const w = build(Base, entities, hookSpec, stayScale);
  // Warm-up through short calls first (a normal compile, not OSR), then the checksum's 600 ticks from the same start.
  if (!check) {
    const few = w.owners.slice(0, 60);
    warmNormalCompile(() => tickAll(few));
  }
  for (const o of w.owners) o.reset();
  const frames = 600;
  const before = w.fsms.map((F) => F.state.slice(0, entities));
  let transitions = 0;
  for (let f = 0; f < frames; f++) {
    tickAll(w.owners);
    transitions += countChanged(w.fsms, before, entities);
  }
  const sum = checksum(w);
  const transitionsPerOp = transitions / frames;
  const config = `${entities} owners, 2 FSMs each, hooks ${hooks}, stay-scale ${stayScale}`;
  console.log(`fsm tick ${variant} (${config}): checksum ${sum}, ${transitionsPerOp.toFixed(1)} transitions per op`);
  if (check) return { variant, entities, hooks, stayScale, checksum: sum, transitionsPerOp, cases: {} };
  const cases = {
    tick: timeIt(`fsm tick ${variant} (${config})`, () => tickAll(w.owners), {
      iterations: 200,
      warmup: 50,
    }),
  };
  return { variant, entities, hooks, stayScale, checksum: sum, transitionsPerOp, cases };
}

if (isCli(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const result = runFsmTickMicrobench({
    variant: args.variant || 'shipped',
    entities: args.entities ? Number(args.entities) : 3000,
    hooks: args.hooks || 'none',
    stayScale: args['stay-scale'] === undefined ? 1 : Number(args['stay-scale']),
    check: Boolean(args.check),
  });
  if (args.output) writeReport(String(args.output), result);
}
