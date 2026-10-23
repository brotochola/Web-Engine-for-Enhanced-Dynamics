import test from 'node:test';
import assert from 'node:assert/strict';

import { compareSamples, instantiateKernel, kernelEntry } from '../bench/wasmKernelHelpers.mjs';
import { createSpatialPublishMemory } from '../../src/util/spatialPublishMemory.js';

// E-76 T4: the WASM kernel harness. Its verdict rule is HOW_WE_MEASURE's (3 % and 90 % of the
// cross comparisons), and it links a module the way the product must: the memory and nothing else.

test('compareSamples: a verdict needs 3 % and 90 % of the cross comparisons', () => {
  const base = [100, 101, 99, 100, 102, 98, 100, 101, 99];
  const faster = base.map((v) => v * 1.1);
  const r = compareSamples(base, faster);
  assert.equal(r.verdict, 'FASTER');
  assert.equal(r.crossTotal, 81);
  assert.equal(r.pairedWins, 9);
  assert.equal(compareSamples(base, base.map((v) => v * 0.9)).verdict, 'SLOWER');
  // 3 % on the medians but overlapping samples: a tie.
  const overlapping = [90, 130, 95, 125, 92, 128, 99, 104, 103];
  const t = compareSamples(base, overlapping);
  assert.ok(t.deltaPct >= 3, `median delta ${t.deltaPct}`);
  assert.equal(t.verdict, 'TIE');
  // Every comparison won but under 3 %: a tie.
  assert.equal(compareSamples(base, base.map((v) => v + 2.5)).verdict, 'TIE');
});

test('instantiateKernel links the shared memory and nothing else', () => {
  assert.equal(kernelEntry('spatialPublish').output, 'src/workers/spatialPublish.wasm');
  const mem = createSpatialPublishMemory(64, 4, 1);
  const exports = instantiateKernel('spatialPublish', mem.memory);
  assert.equal(typeof exports.publish_batch, 'function');

  // (module (import "env" "memory" (memory 1 1 shared)) (import "env" "f" (func)))
  const bytes = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    0x01, 0x04, 0x01, 0x60, 0x00, 0x00,
    0x02, 0x18, 0x02,
    0x03, 0x65, 0x6e, 0x76, 0x06, 0x6d, 0x65, 0x6d, 0x6f, 0x72, 0x79, 0x02, 0x03, 0x01, 0x01,
    0x03, 0x65, 0x6e, 0x76, 0x01, 0x66, 0x00, 0x00,
  ]);
  const extra = new WebAssembly.Module(bytes);
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  assert.throws(() => instantiateKernel(extra, memory), WebAssembly.LinkError);
});
