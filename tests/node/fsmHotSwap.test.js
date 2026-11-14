import test from 'node:test';
import assert from 'node:assert/strict';

import { swapModule } from '../../src/core/debug/hotSwap.js';
import { FSM } from '../../src/core/fsm.js';
import { FSMState } from '../../src/core/fsmState.js';

// A hot swap copies a module's new code onto the running classes (core/debug/hotSwap.js). An FSM reads its states'
// hooks from arrays it fills when it links (E-146: onUpdate), so the swap has it read them again: the next tick runs
// the new onUpdate, the next transition the new onExit and onEnter, including a hook the old state did not define.

/** An FSM module as a fresh evaluation builds it; `tag` marks which version wrote each line of the log. */
function version(tag, { runExit = true, exportStates = true } = {}) {
  const log = [];
  const ns = new Function('FSM', 'FSMState', 'log', `
    class IdleState extends FSMState {
      static onEnter(owner, i, from) { log.push('${tag} enter IDLE from ' + from); }
      static onExit(owner, i, to) { log.push('${tag} exit IDLE to ' + to); }
      static onUpdate(owner, i) { log.push('${tag} update IDLE'); this.fsm.changeState(i, this.fsm.states.RUN); }
    }
    class RunState extends FSMState {
      static onEnter(owner, i, from) { log.push('${tag} enter RUN from ' + from); }
      ${runExit ? `static onExit(owner, i, to) { log.push('${tag} exit RUN to ' + to); }` : ''}
      static onUpdate(owner, i) { log.push('${tag} update RUN'); this.fsm.changeState(i, this.fsm.states.IDLE); }
    }
    class MoveFSM extends FSM {
      static states = { IDLE: IdleState, RUN: RunState };
      static initial = this.states.IDLE;
    }
    return ${exportStates ? '{ MoveFSM, IdleState, RunState }' : '{ MoveFSM }'};
  `)(FSM, FSMState, log);
  return { ns, log };
}

function start(live) {
  const F = live.ns.MoveFSM;
  F.initializeArrays(new ArrayBuffer(F.getBufferSize(1)), 1);
  return { F, fsm: new F(0), owner: { constructor: { tickInterval: 1 } } };
}

test('after a swap the FSM runs the new onUpdate, onExit and onEnter', () => {
  const live = version('old');
  const { F, fsm, owner } = start(live);
  fsm.tick(1, owner); // IDLE asks for RUN
  const fresh = version('new');
  const result = swapModule(live.ns, fresh.ns);
  assert.equal(result.reload, null);
  assert.deepEqual(result.swapped.sort(), ['IdleState', 'MoveFSM', 'RunState']);
  fsm.tick(1, owner);
  fsm.tick(1, owner);
  assert.deepEqual(live.log, ['old update IDLE']);
  assert.deepEqual(fresh.log, [
    'new exit IDLE to RUN',
    'new enter RUN from IDLE',
    'new update RUN',
    'new exit RUN to IDLE',
    'new enter IDLE from RUN',
    'new update IDLE',
  ]);
  assert.equal(F.getStateName(0), 'IDLE');
});

test('a hook the new version adds to a state runs from the next transition', () => {
  const live = version('old', { runExit: false });
  const { fsm, owner } = start(live);
  fsm.tick(1, owner); // IDLE asks for RUN
  fsm.tick(1, owner); // RUN entered (no onExit of its own), asks for IDLE
  const fresh = version('new', { runExit: true });
  assert.equal(swapModule(live.ns, fresh.ns).reload, null);
  fsm.tick(1, owner);
  assert.deepEqual(live.log, ['old update IDLE', 'old exit IDLE to RUN', 'old enter RUN from IDLE', 'old update RUN']);
  assert.deepEqual(fresh.log, ['new exit RUN to IDLE', 'new enter IDLE from RUN', 'new update IDLE']);
});

// N-168: Predator's FSM modules export only the FSM; its states live in its `states` object. A swap pairs them through it,
// so they keep their state numbers and changeState still reaches them (it used to write state 0 for every one).
test('a swap of an FSM module whose states are not exported keeps its states numbered', () => {
  const live = version('old', { exportStates: false });
  const { F, fsm, owner } = start(live);
  fsm.tick(1, owner); // IDLE asks for RUN
  const fresh = version('new', { exportStates: false });
  const result = swapModule(live.ns, fresh.ns);
  assert.equal(result.reload, null);
  assert.deepEqual(result.swapped.sort(), ['IdleState', 'MoveFSM', 'RunState']);
  fsm.tick(1, owner);
  assert.equal(F.getStateName(0), 'RUN', 'the pending transition reached RUN');
  fsm.tick(1, owner);
  assert.equal(F.getStateName(0), 'IDLE', 'and RUN\'s request reached IDLE');
  assert.deepEqual(fresh.log, [
    'new exit IDLE to RUN',
    'new enter RUN from IDLE',
    'new update RUN',
    'new exit RUN to IDLE',
    'new enter IDLE from RUN',
    'new update IDLE',
  ]);
});
