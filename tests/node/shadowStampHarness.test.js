// The stamp kernel's bench harness (tests/bench/shadowStampKernel.mjs, which shadowStampWasmMicrobench.mjs and the
// scoreboard's shadowStamp row time) feeds the kernel what pre-render does: on the Predator fixture its wasm stamp
// writes the JS reference's rows, bit for bit. A harness that wrote its own light records drifted once (DX-SPOT grew
// the record from 5 to 11 doubles; the harness kept writing 5, the kernel read the lights wrong and stamped 708 rows
// for 7877, and the scoreboard read that as twice as fast). It writes through the product's writeStampLights now.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { stampLightRange } from '../reference/shadowStamp.mjs';
import { loadPredatorFixture } from '../bench/predatorFixture.mjs';
import { createStampKernel } from '../bench/shadowStampKernel.mjs';

const KERNEL_URL = pathToFileURL(path.resolve(import.meta.dirname, '../../src/wasm/engine.wasm'));

test('the stamp harness: the kernel on the Predator fixture writes the JS reference rows', async () => {
  const fx = loadPredatorFixture();
  assert.ok(fx, 'tests/fixtures/predator-frame.bin');
  const k = await createStampKernel(fx, {}, KERNEL_URL);
  const spec = k.spec;
  const rows = new Uint8Array(spec.stamp.buffer, spec.stamp.byteOffset, spec.stamp.byteLength);
  const idx = new Uint8Array(spec.stampLightIdx.buffer, spec.stampLightIdx.byteOffset, spec.stampLightIdx.byteLength);

  rows.fill(0xa5);
  idx.fill(0xa5);
  const jsCursor = stampLightRange(spec);
  const jsRows = rows.slice();
  const jsIdx = idx.slice();

  rows.fill(0xa5);
  idx.fill(0xa5);
  const cursor = k.stampWasm();

  assert.ok(jsCursor > 1000, `the fixture stamps a real frame (${jsCursor} rows)`);
  assert.equal(cursor, jsCursor);
  assert.deepEqual(rows, jsRows);
  assert.deepEqual(idx, jsIdx);
});
