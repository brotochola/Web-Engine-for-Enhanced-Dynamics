import test from 'node:test';
import assert from 'node:assert/strict';

import { FSM } from '../../src/core/fsm.js';
import { FSMState } from '../../src/core/fsmState.js';

// FSM.tick hands each state its time in state. A fractional double crossing that call (a different
// onUpdate per state, which TurboFan does not inline) was a heap number per tick in Chrome, so the
// time goes as whole milliseconds (E-105): the accumulated time, truncated.

const seen = [];

class WaitState extends FSMState {
  static onUpdate(owner, i, dt, timeInState) {
    seen.push(timeInState);
    if (timeInState >= 60) this.fsm.changeState(i, this.fsm.states.GO);
  }
}

class GoState extends FSMState {
  static onUpdate(owner, i, dt, timeInState) {
    seen.push(timeInState);
  }
}

class TickTestFSM extends FSM {
  static states = { WAIT: WaitState, GO: GoState };
  static initial = this.states.WAIT;
}

test('onUpdate gets the time in state in whole milliseconds, reset by a transition', () => {
  TickTestFSM.initializeArrays(new SharedArrayBuffer(TickTestFSM.getBufferSize(2)), 2);
  const fsm = new TickTestFSM(1);
  const owner = { constructor: { tickInterval: 1 } };
  seen.length = 0;
  const expected = [];
  const time = new Float32Array(1); // the FSM's own column precision
  for (let k = 0; k < 8; k++) {
    if (k === 4) time[0] = 0; // the WAIT state asked for GO at 66 ms; the transition resets the clock
    time[0] += 1 * 16.67 * 1;
    expected.push(time[0] | 0);
    fsm.tick(1, owner);
  }
  assert.deepEqual(seen, expected);
  assert.deepEqual(seen, [16, 33, 50, 66, 16, 33, 50, 66]);
  assert.ok(seen.every(Number.isInteger));
  assert.equal(TickTestFSM.getStateName(1), 'GO');
});

test('a decimated entity accumulates its tick interval', () => {
  TickTestFSM.initializeArrays(new SharedArrayBuffer(TickTestFSM.getBufferSize(1)), 1);
  const fsm = new TickTestFSM(0);
  seen.length = 0;
  fsm.tick(1, { constructor: { tickInterval: 3 } });
  assert.deepEqual(seen, [50]); // 16.67 * 3 = 50.01
});
