// measure:all times each WASM kernel with the variant the engine ships (tests/bench/ci/shipped.mjs): a script renamed, or a
// variant it no longer has, would time the JavaScript a kernel replaced and call it the engine.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { SHIPPED_ARGS, areaOf, reachesEngine, shippedArgs } from '../bench/ci/shipped.mjs';
import { PAINTER_VARIANT } from '../../src/render/painterRadixClient.js';
import { BULLET_TICK_VARIANT } from '../../src/core/bulletTickClient.js';

const BENCH = new URL('../bench/', import.meta.url);

test('each kernel with its own arguments exists and knows the variant', () => {
  for (const [name, list] of Object.entries(SHIPPED_ARGS)) {
    const source = fs.readFileSync(new URL(`${name}.mjs`, BENCH), 'utf8');
    for (const args of list) {
      const variant = /--variant ([^ ]+)/.exec(args)?.[1];
      if (variant) assert.ok(source.includes(variant), `${name}: ${variant}`);
    }
  }
  assert.deepEqual(shippedArgs('tests/bench/painterRadixWasmMicrobench.mjs'), [`--variant ${PAINTER_VARIANT}`]);
  assert.deepEqual(shippedArgs('bulletTickWasmMicrobench.mjs'), [`--variant ${BULLET_TICK_VARIANT.replace('bullet_tick', 'wasm')}`]);
  assert.deepEqual(shippedArgs('rayMicrobench.mjs'), ['']);
});

test('a kernel falls in a part of the engine', () => {
  assert.equal(areaOf('tests/bench/shadowStampWasmMicrobench.mjs'), 'lights and shadows');
  assert.equal(areaOf('rayMicrobench'), 'physics and rays');
  assert.equal(areaOf('preRenderPersistWasmMicrobench'), 'drawing');
});

test('a kernel reaches the engine by itself or through what it imports; one that times ideas of its own does not', () => {
  const at = (f) => reachesEngine(new URL(`../bench/${f}`, import.meta.url));
  assert.equal(at('rayMicrobench.mjs'), true);
  assert.equal(at('visibilitySweepWasmMicrobench.mjs'), true, 'through another bench');
  assert.equal(at('hypotVsSqrtMicrobench.mjs'), false);
  assert.equal(at('wasmCallCostMicrobench.mjs'), false);
});
