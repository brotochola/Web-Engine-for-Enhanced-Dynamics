// E-358: the stamp keeps each caster's nearest lights as records (the float distance and the light side by side) and its
// last loop finds the lit casters 16 nearest-light counts at a time. On sparse frames (a few small lights over many
// casters, so most 16-caster blocks are unlit, and caster counts that leave a tail past the last block), with ties
// between lights on one spot, one to three shadows a caster and stamps that fill up anywhere, the kernel stamps what
// the JS reference (tests/reference/shadowStamp.mjs) stamps: the cursor, every row and light index, bit for bit.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GPU_CASTER_FLOATS } from '../../src/render/gpuQueueLayout.js';
import { stampLightRangeWasm } from '../../src/render/shadowStampClient.js';
import { stampLightRange } from '../reference/shadowStamp.mjs';
import { LIGHTS, MAX, PER_ENTITY, rng, setup } from '../helpers/shadowStampFrames.mjs';

test('sparse lit casters, block tails and full stamps: the records and the 16-count skip stamp what the JS stamps', async () => {
  const { dst, b, scratch } = await setup();
  const r = rng(0x358);
  const rows = new Uint8Array(dst.stamp.buffer, dst.stamp.byteOffset, dst.stamp.byteLength);
  const idx = new Uint8Array(dst.stampLightIdx.buffer, dst.stampLightIdx.byteOffset, dst.stampLightIdx.byteLength);
  let stamped = 0;
  let filled = 0;
  for (let k = 0; k < 60; k++) {
    const nSun = Math.min(MAX, 16 * (1 + Math.floor(r() * 150)) + (k % 16));
    const side = 3000;
    for (let c = 0; c < nSun; c++) {
      const o = c * GPU_CASTER_FLOATS;
      dst.sun[o] = r() * side;
      dst.sun[o + 1] = r() * side;
      for (let f = 2; f < GPU_CASTER_FLOATS; f++) dst.sun[o + f] = r();
    }
    const lights = [];
    const n = 1 + Math.floor(r() * LIGHTS);
    for (let i = 0; i < n; i++) {
      if (i > 0 && r() < 0.25) {
        lights.push({ ...lights[i - 1] }); // a light on its neighbour's spot: ties on every caster they share
        continue;
      }
      const range = 40 + r() * 260;
      lights.push({ x: r() * side, y: r() * side, intensity: 0.5 + r(), rangeSq: range * range, maxShadows: r() < 0.3 ? 1 + Math.floor(r() * 20) : 0 });
    }
    const spec = {
      sun: dst.sun,
      sunN: nSun,
      sunFloats: GPU_CASTER_FLOATS,
      lights,
      lightBegin: 0,
      lightEnd: lights.length,
      lightStride: 1,
      maxPerLight: [0, 8, 64][k % 3],
      maxPerEntity: 1 + (k % PER_ENTITY),
      used: null,
      ...scratch,
      stamp: dst.stamp,
      stampFloats: GPU_CASTER_FLOATS,
      stampCap: k % 4 === 3 ? 1 + Math.floor(r() * 60) : dst.stamp.length / GPU_CASTER_FLOATS,
      stampBase: 0,
      stampLightIdx: dst.stampLightIdx,
    };
    rows.fill(0xa5);
    idx.fill(0xa5);
    const jsCursor = stampLightRange(spec);
    const jsRows = rows.slice();
    const jsIdx = idx.slice();
    rows.fill(0xa5);
    idx.fill(0xa5);
    const cursor = stampLightRangeWasm(b, spec);
    assert.equal(cursor, jsCursor, `frame ${k} (${nSun} casters, ${lights.length} lights): cursor`);
    assert.equal(rows.findIndex((x, i) => x !== jsRows[i]), -1, `frame ${k}: stamp rows`);
    assert.equal(idx.findIndex((x, i) => x !== jsIdx[i]), -1, `frame ${k}: light indices`);
    if (cursor === spec.stampCap) filled++;
    stamped += cursor;
  }
  assert.ok(stamped > 2000, `the frames stamp rows (${stamped})`);
  assert.ok(filled >= 5, `stamps that fill up (${filled})`);
});
