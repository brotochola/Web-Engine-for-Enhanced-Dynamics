// E-170: a component's scalar fields get accessors compiled one per field. Each reads and writes its own column, by
// the component's current array (initializeArrays replaces them on a scene load), and where compiling is not
// allowed (a CSP without 'unsafe-eval') the shared closures do the same.
import test from 'node:test';
import assert from 'node:assert/strict';

import { Component } from '../../src/core/component.js';

function components() {
  class Stats extends Component {
    static ARRAY_SCHEMA = { hp: Float32Array, level: Uint8Array, gold: Float64Array, slots: { type: Int16Array, length: 4 } };
  }
  return Stats;
}

function exercise(Stats) {
  Stats.initializeArrays(new SharedArrayBuffer(Stats.getBufferSize(3)), 3);
  const a = new Stats(1);
  const b = new Stats(2);
  a.hp = 12.5;
  a.level = 300; // a Uint8Array column: stored as 300 & 255
  b.gold = 1e10;
  assert.equal(Stats.hp[1], 12.5);
  assert.equal(a.level, 44);
  assert.equal(b.gold, 1e10);
  assert.equal(b.hp, 0, 'each entity its own slot');
  assert.equal(Object.getOwnPropertyDescriptor(Stats.prototype, 'slots'), undefined, 'a strided field has no accessor');
  // A scene load gives the component new columns: the accessors read those.
  Stats.initializeArrays(new SharedArrayBuffer(Stats.getBufferSize(3)), 3);
  assert.equal(a.hp, 0);
  a.hp = 3;
  assert.equal(Stats.hp[1], 3);
}

test('each field reads and writes its own column, the current one', () => {
  const Stats = components();
  exercise(Stats);
  const get = (name) => Object.getOwnPropertyDescriptor(Stats.prototype, name).get;
  assert.notEqual(get('hp'), get('gold'), 'a function of its own per field');
});

test('where code cannot be compiled the shared accessors do the same', () => {
  const RealFunction = globalThis.Function;
  globalThis.Function = function blocked() {
    throw new EvalError('Code generation from strings disallowed for this context');
  };
  try {
    const Stats = components();
    exercise(Stats);
  } finally {
    globalThis.Function = RealFunction;
  }
});
