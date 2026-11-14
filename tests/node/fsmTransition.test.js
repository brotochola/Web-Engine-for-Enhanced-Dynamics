import test from 'node:test';
import assert from 'node:assert/strict';

import { FSM } from '../../src/core/fsm.js';
import { FSMState } from '../../src/core/fsmState.js';

// A transition calls the old state's onExit (with the next state's name) before the state changes, then the new
// state's onEnter (with the previous state's name) after, each with its state class as `this`. The FSM reads the hooks
// from per-state arrays rather than from the state classes (E-301): these pin what a transition calls, in what order,
// with which arguments and `this`, through tick, forceChangeState (both forms) and initializeEntity, and that a state
// with no hooks of its own (or no FSMState base at all) makes none.

const log = [];

/** What the FSM looked like when a hook ran: its state, time in state and pending transition for the entity. */
function seenBy(F, i) {
  return `${F.getStateName(i)} t=${F.time[i]} next=${F.nextState[i]}`;
}

class GuardState extends FSMState {
  static onEnter(owner, i, fromState) {
    log.push(['enter GUARD', this === GuardState, owner.name, i, fromState, seenBy(this.fsm, i)]);
  }
  static onExit(owner, i, toState) {
    log.push(['exit GUARD', this === GuardState, owner.name, i, toState, seenBy(this.fsm, i)]);
  }
  static onUpdate(owner, i) {
    log.push(['update GUARD', i]);
    if (owner.goTo) this.fsm.changeState(i, owner.goTo);
  }
}

class ChaseState extends FSMState {
  static onEnter(owner, i, fromState) {
    log.push(['enter CHASE', this === ChaseState, owner.name, i, fromState, seenBy(this.fsm, i)]);
  }
  static onExit(owner, i, toState) {
    log.push(['exit CHASE', this === ChaseState, owner.name, i, toState, seenBy(this.fsm, i)]);
  }
  static onUpdate(owner, i) {
    log.push(['update CHASE', i]);
    if (owner.goTo) this.fsm.changeState(i, owner.goTo);
  }
}

/** No hooks of its own: it inherits FSMState's empty onEnter and onExit. */
class WaitState extends FSMState {
  static onUpdate(owner, i) {
    log.push(['update WAIT', i]);
    if (owner.goTo) this.fsm.changeState(i, owner.goTo);
  }
}

/** A hook inherited from a game's own base state runs with the subclass as `this`. */
class LoudState extends FSMState {
  static onEnter(owner, i, fromState) {
    log.push([`enter ${this.name}`, owner.name, i, fromState]);
  }
}
class AlarmState extends LoudState {
  static onUpdate(owner, i) {
    log.push(['update ALARM', i]);
    if (owner.goTo) this.fsm.changeState(i, owner.goTo);
  }
}

/** Not an FSMState at all: only an onUpdate. */
class BareState {
  static onUpdate(owner, i) {
    log.push(['update BARE', i]);
    if (owner.goTo) this.fsm.changeState(i, owner.goTo);
  }
}

class GuardFSM extends FSM {
  static states = { GUARD: GuardState, CHASE: ChaseState, WAIT: WaitState, ALARM: AlarmState, BARE: BareState };
  static initial = this.states.GUARD;
}

function setup(count = 4) {
  GuardFSM.initializeArrays(new SharedArrayBuffer(GuardFSM.getBufferSize(count)), count);
  log.length = 0;
}

function makeOwner(name, i) {
  const owner = { name, goTo: null, constructor: { tickInterval: 1 } };
  const fsm = new GuardFSM(i);
  fsm.owner = owner; // as the engine's component getter does
  return { owner, fsm };
}

test('a requested transition runs onExit, then the state write, then onEnter, then the new state\'s onUpdate', () => {
  setup();
  const { owner, fsm } = makeOwner('guard', 2);
  GuardFSM.initializeEntity(2, owner);
  owner.goTo = ChaseState;
  fsm.tick(1, owner); // GUARD's onUpdate asks for CHASE
  owner.goTo = null;
  fsm.tick(1, owner);
  assert.deepEqual(log, [
    ['enter GUARD', true, 'guard', 2, null, 'GUARD t=0 next=-1'],
    ['update GUARD', 2],
    ['exit GUARD', true, 'guard', 2, 'CHASE', 'GUARD t=16.670000076293945 next=1'],
    ['enter CHASE', true, 'guard', 2, 'GUARD', 'CHASE t=0 next=-1'],
    ['update CHASE', 2],
  ]);
  assert.equal(GuardFSM.getStateName(2), 'CHASE');
});

test('changeState to the current state exits and re-enters it', () => {
  setup();
  const { owner, fsm } = makeOwner('guard', 0);
  owner.goTo = GuardState;
  fsm.tick(1, owner);
  owner.goTo = null;
  fsm.tick(1, owner);
  assert.deepEqual(log.map((e) => e.slice(0, 5)), [
    ['update GUARD', 0],
    ['exit GUARD', true, 'guard', 0, 'GUARD'],
    ['enter GUARD', true, 'guard', 0, 'GUARD'],
    ['update GUARD', 0],
  ]);
});

test('forceChangeState, static and instance, transitions at once with the same hooks', () => {
  setup();
  const { owner, fsm } = makeOwner('scout', 1);
  GuardFSM.forceChangeState(1, ChaseState, owner);
  fsm.forceChangeState(GuardState);
  assert.deepEqual(log, [
    ['exit GUARD', true, 'scout', 1, 'CHASE', 'GUARD t=0 next=-1'],
    ['enter CHASE', true, 'scout', 1, 'GUARD', 'CHASE t=0 next=-1'],
    ['exit CHASE', true, 'scout', 1, 'GUARD', 'CHASE t=0 next=-1'],
    ['enter GUARD', true, 'scout', 1, 'CHASE', 'GUARD t=0 next=-1'],
  ]);
  assert.equal(GuardFSM.getStateName(1), 'GUARD');
});

test('states without hooks of their own make no hook call; an inherited hook runs with the subclass as this', () => {
  setup();
  const { owner, fsm } = makeOwner('idler', 3);
  const path = [WaitState, AlarmState, BareState, WaitState, GuardState];
  for (const next of path) {
    owner.goTo = next;
    fsm.tick(1, owner);
  }
  owner.goTo = null;
  fsm.tick(1, owner);
  assert.deepEqual(log.map((e) => e.slice(0, 5)), [
    ['update GUARD', 3],
    ['exit GUARD', true, 'idler', 3, 'WAIT'],
    ['update WAIT', 3],
    ['enter AlarmState', 'idler', 3, 'WAIT'],
    ['update ALARM', 3],
    ['update BARE', 3],
    ['update WAIT', 3],
    ['enter GUARD', true, 'idler', 3, 'WAIT'],
    ['update GUARD', 3],
  ]);
  assert.equal(GuardFSM.getStateName(3), 'GUARD');
});

test('initializeEntity enters the initial state once, from null; one without onEnter makes no call', () => {
  setup();
  const { owner } = makeOwner('spawned', 0);
  GuardFSM.initializeEntity(0, owner);
  assert.deepEqual(log, [['enter GUARD', true, 'spawned', 0, null, 'GUARD t=0 next=-1']]);

  class SilentState extends FSMState {
    static onUpdate() {}
  }
  class QuietFSM extends FSM {
    static states = { WAIT: SilentState };
    static initial = this.states.WAIT;
  }
  QuietFSM.initializeArrays(new SharedArrayBuffer(QuietFSM.getBufferSize(1)), 1);
  log.length = 0;
  QuietFSM.initializeEntity(0, owner);
  assert.deepEqual(log, []);
  assert.equal(QuietFSM.getStateName(0), 'WAIT');
});
