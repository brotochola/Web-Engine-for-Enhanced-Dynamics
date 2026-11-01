// E-191 step 2: the shadow stamp on keyed caster rows (GPU_KEYED_CASTER_FLOATS: x, y, the key and a zero, the shadow
// terms) writes keyed stamp rows (GPU_KEYED_STAMP_FLOATS: the caster row, then its light at GPU_KEYED_CASTER_FLOATS), and
// picks the same (light, caster) pairs in the same order as on the full rows: the stamp reads a row's x and y alone. On
// shadowStampWasm.test.js's random frames, each frame stamped twice, from its full rows and from the keyed rows made
// from them (each caster's key its row).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  GPU_CASTER_FLOATS, GPU_CASTER_LIGHT_FLOAT, GPU_KEYED_CASTER_FLOATS, GPU_KEYED_STAMP_FLOATS, GPU_SPRITE_FLOATS,
} from '../../src/render/gpuQueueLayout.js';
import { stampLightRangeWasm } from '../../src/render/shadowStampClient.js';
import { frame, rng, setup, specFor } from '../helpers/shadowStampFrames.mjs';

const SF = GPU_CASTER_FLOATS;
const KF = GPU_KEYED_CASTER_FLOATS;
const KS = GPU_KEYED_STAMP_FLOATS;

function run(b, spec, dst, floats) {
  const rows = dst.stampLightIdx.length;
  dst.stamp.fill(NaN, 0, Math.min(dst.stamp.length, rows * floats));
  dst.stampLightIdx.fill(0xa5a5, 0, rows);
  const cursor = stampLightRangeWasm(b, spec);
  return { cursor, stamp: dst.stamp.slice(0, cursor * floats), lightIdx: dst.stampLightIdx.slice(0, cursor) };
}

test('keyed caster rows stamp the full rows\' pairs, each a keyed row with its light', async () => {
  const { caps, dst, b, scratch } = await setup();
  const r = rng(191);
  let frames = 0;
  let pairs = 0;
  for (let k = 0; k < 60; k++) {
    const f = frame(r, k, caps, dst);
    const full = dst.sun.slice(0, f.nSun * SF);
    const a = run(b, specFor(f, dst, scratch), dst, SF);

    // The keyed rows of the same casters, over the full ones.
    for (let c = 0; c < f.nSun; c++) {
      const s = c * SF;
      const d = c * KF;
      dst.sun[d] = full[s];
      dst.sun[d + 1] = full[s + 1];
      dst.sun[d + 2] = c;
      dst.sun[d + 3] = 0;
      dst.sun[d + 4] = full[s + GPU_SPRITE_FLOATS];
      dst.sun[d + 5] = full[s + GPU_SPRITE_FLOATS + 1];
      dst.sun[d + 6] = full[s + GPU_SPRITE_FLOATS + 2];
    }
    const keyed = dst.sun.slice(0, f.nSun * KF);
    const spec = { ...specFor(f, dst, scratch), sunFloats: KF, stampFloats: KS, lightFloat: KF };
    const kb = run(b, spec, dst, KS);

    assert.equal(kb.cursor, a.cursor, `frame ${k}: the stamp count`);
    const base = f.stampBase | 0;
    for (let q = base; q < a.cursor; q++) {
      assert.equal(kb.lightIdx[q], a.lightIdx[q], `frame ${k}, row ${q}: its light`);
      const c = kb.stamp[q * KS + 2];
      assert.ok(Number.isInteger(c) && c >= 0 && c < f.nSun, `frame ${k}, row ${q}: a caster's key`);
      for (let w = 0; w < KF; w++) {
        assert.ok(Object.is(kb.stamp[q * KS + w], keyed[c * KF + w]), `frame ${k}, row ${q}: keyed float ${w}`);
      }
      for (let w = 0; w < GPU_CASTER_LIGHT_FLOAT; w++) {
        assert.ok(Object.is(a.stamp[q * SF + w], full[c * SF + w]), `frame ${k}, row ${q}: the full row is caster ${c}'s`);
      }
      for (let w = 0; w < 4; w++) {
        assert.ok(Object.is(kb.stamp[q * KS + KF + w], a.stamp[q * SF + GPU_CASTER_LIGHT_FLOAT + w]), `frame ${k}, row ${q}: light ${w}`);
      }
      pairs++;
    }
    frames++;
  }
  assert.equal(frames, 60);
  assert.ok(pairs > 1000, `the frames stamp pairs (${pairs})`);
});
