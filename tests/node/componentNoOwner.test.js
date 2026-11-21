// E-540: an entity's component instances (this.spriteRenderer, this.walkFSM) were given .owner, the entity, after their
// constructor: a second shape for every facade, read only for an FSM's tickInterval (and, before E-533, a mesh bit).
// A component now knows its entity by index alone, and an FSM reads its entity's tickInterval from its type.
import test from 'node:test';
import assert from 'node:assert/strict';

import { GameObject } from '../../src/core/gameObject.js';
import { Transform } from '../../src/components/transform.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { FSM } from '../../src/core/fsm.js';
import { FSMState } from '../../src/core/fsmState.js';

const N = 4;
const seen = [];

class Wait extends FSMState {
  static onUpdate(i, dt, timeInState) {
    seen.push(timeInState);
  }
}
class PaceFSM extends FSM {
  static states = { WAIT: Wait };
  static initial = this.states.WAIT;
}
class Pacer extends GameObject {
  static components = [SpriteRenderer, PaceFSM];
  static tickInterval = 2;
}

test('E-540: a component made by its entity\'s getter holds no owner, and an FSM ticks by its type\'s interval', () => {
  for (const C of [Transform, SpriteRenderer]) C.initializeArrays(new SharedArrayBuffer(C.getBufferSize(N)), N);
  PaceFSM.initializeArrays(new SharedArrayBuffer(PaceFSM.getBufferSize(N)), N);
  GameObject._assignComponentClassMap(Pacer);
  Pacer.entityType = 5;
  GameObject.classByType[5] = Pacer;
  Transform.entityType[1] = 5;
  const pacer = new Pacer(1, {}, null, { page: true });
  const sprite = pacer.spriteRenderer;
  const fsm = pacer.paceFSM;
  assert.ok(sprite instanceof SpriteRenderer && fsm instanceof PaceFSM);
  for (const c of [sprite, fsm]) {
    assert.equal('owner' in c, false);
    assert.deepEqual(Object.keys(c).filter((k) => k !== 'index' && k !== '_msPerTick'), [], 'its constructor\'s fields only');
  }
  seen.length = 0;
  fsm.tick(1);
  fsm.tick(1);
  assert.deepEqual(seen, [33, 66], 'two frames a tick: 16.67 × 2 ms each');
});
