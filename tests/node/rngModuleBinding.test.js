import test from 'node:test';
import assert from 'node:assert/strict';

import { rng, rngFill, seededRandom } from '../../src/util/utils.js';

// E-348: rng() keeps its generator in utils.js's own bindings instead of loading globalThis.rng on every call (a
// global written or added in play deoptimized every function rng() is inlined into). globalThis.rng stays the API: it
// is an accessor over those bindings, so whatever is written there is what rng() and rngFill() use from the next call.

function quietly(fn) {
  const warn = console.warn;
  const warnings = [];
  console.warn = (...a) => warnings.push(a.join(' '));
  try {
    return { value: fn(), warnings };
  } finally {
    console.warn = warn;
  }
}

test('globalThis.rng is an accessor: rng() steps the seededRandom generator written there, as its own calls would', { concurrency: false }, () => {
  const saved = globalThis.rng;
  try {
    const desc = Object.getOwnPropertyDescriptor(globalThis, 'rng');
    assert.equal(typeof desc.get, 'function', 'an accessor');
    assert.equal(typeof desc.set, 'function');
    const g = seededRandom(1234, 'logic0');
    const ref = seededRandom(1234, 'logic0');
    globalThis.rng = g;
    assert.equal(globalThis.rng, g, 'reads back the generator written');
    for (let i = 0; i < 1000; i++) assert.equal(rng(), ref(), `call ${i}`);
    // rng() and the generator's own calls share one stream.
    assert.equal(g(), ref());
    assert.equal(rng(), ref());
    const out = new Float64Array(16);
    rngFill(out, 0, 16);
    for (let i = 0; i < 16; i++) assert.equal(out[i], ref(), `fill ${i}`);
  } finally {
    globalThis.rng = saved;
  }
});

test('a generator written in play (a new seededRandom, then user code\'s own function) is used from the next call', { concurrency: false }, () => {
  const saved = globalThis.rng;
  try {
    globalThis.rng = seededRandom(1, 'main');
    rng();
    const second = seededRandom(99, 'logic1');
    const ref = seededRandom(99, 'logic1');
    globalThis.rng = second;
    for (let i = 0; i < 100; i++) assert.equal(rng(), ref());
    let calls = 0;
    const custom = () => {
      calls++;
      return 0.25;
    };
    globalThis.rng = custom;
    assert.equal(globalThis.rng, custom);
    assert.equal(rng(), 0.25, 'a function without seededRandom\'s state is called');
    assert.equal(rng(), 0.25);
    assert.equal(calls, 2);
    assert.throws(() => rngFill(new Float64Array(1), 0, 1), /seededRandom generator/, 'rngFill needs a seededRandom generator, as before');
    // self.rng is the same property in a worker (self === globalThis there).
    const viaSelf = seededRandom(5, 'worker');
    const refSelf = seededRandom(5, 'worker');
    globalThis.rng = viaSelf;
    assert.equal(rng(), refSelf());
  } finally {
    globalThis.rng = saved;
  }
});

test('with no generator, rng() warns once, seeds with 0 and goes on from that seed', { concurrency: false }, () => {
  const saved = globalThis.rng;
  try {
    globalThis.rng = null;
    assert.equal(globalThis.rng, null);
    const ref = seededRandom(0, 'uninit');
    const { value, warnings } = quietly(() => [rng(), rng()]);
    assert.deepEqual(value, [ref(), ref()]);
    assert.equal(warnings.length, 1);
    assert.equal(typeof globalThis.rng, 'function', 'the seeded generator is installed');
    globalThis.rng = undefined;
    const { value: filled, warnings: w2 } = quietly(() => {
      const out = new Float64Array(3);
      rngFill(out, 0, 3);
      return [...out];
    });
    const ref2 = seededRandom(0, 'uninit');
    assert.deepEqual(filled, [ref2(), ref2(), ref2()]);
    assert.equal(w2.length, 1);
  } finally {
    globalThis.rng = saved;
  }
});
