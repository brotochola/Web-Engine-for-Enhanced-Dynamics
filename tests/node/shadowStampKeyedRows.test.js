// E-359: with maxShadowsPerEntity and point lights at full shade, keyed caster rows (7 floats into 11, the light vec4 after
// them) go through their own loop in wasm/shadowStamp.c: each light's vec4 converted once, a caster's floats loaded once,
// each row written with wide stores. Here every frame is stamped from its full rows and from the keyed rows made from
// them, as shadowStampKeyed.test.js does, with stamps that fill up mid-caster and a stamp base: the same count, the same
// light per row, each keyed row's 7 floats its caster's bit for bit and its light vec4 the full row's, and nothing written
// past the count.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  GPU_CASTER_FLOATS, GPU_CASTER_LIGHT_FLOAT, GPU_KEYED_CASTER_FLOATS, GPU_KEYED_STAMP_FLOATS, GPU_SPRITE_FLOATS,
} from '../../src/render/gpuQueueLayout.js';
import { stampLightRangeWasm } from '../../src/render/shadowStampClient.js';
import { PER_ENTITY, frame, rng, setup, specFor } from '../helpers/shadowStampFrames.mjs';

const SF = GPU_CASTER_FLOATS;
const KF = GPU_KEYED_CASTER_FLOATS;
const KS = GPU_KEYED_STAMP_FLOATS;

function stampBits(dst, spec, b, floats) {
  const words = new Uint32Array(dst.stamp.buffer, dst.stamp.byteOffset, dst.stamp.length);
  words.fill(0xa5a5a5a5);
  dst.stampLightIdx.fill(0xa5a5);
  const cursor = stampLightRangeWasm(b, spec);
  return { cursor, words: words.slice(), lightIdx: dst.stampLightIdx.slice() };
}

test('keyed rows with maxShadowsPerEntity: the full rows\' pairs, bit for bit, stamps that fill up included', async () => {
  const { caps, dst, b, scratch } = await setup();
  const r = rng(359);
  let rows = 0;
  let filled = 0;
  for (let j = 0; j < 36; j++) {
    const k = 2 + 6 * j; // even (no cone lights) and 2 mod 3 (no dim lights, maxShadowsPerEntity on)
    const f = frame(r, k, caps, dst);
    f.maxPerEntity = 1 + (j % PER_ENTITY);
    f.stampBase = j % 4 === 1 ? 5 : 0;
    if (j % 3 === 1) f.stampCap = f.stampBase + 1 + Math.floor(r() * 200);
    const full = dst.sun.slice(0, f.nSun * SF);
    const a = stampBits(dst, specFor(f, dst, scratch), b, SF);
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
    const keyed = new Uint32Array(dst.sun.slice(0, f.nSun * KF).buffer);
    const kb = stampBits(dst, { ...specFor(f, dst, scratch), sunFloats: KF, stampFloats: KS, lightFloat: KF }, b, KS);
    assert.equal(kb.cursor, a.cursor, `frame ${j}: the stamp count`);
    if (kb.cursor === f.stampCap) filled++;
    const base = f.stampBase;
    for (let q = base; q < kb.cursor; q++) {
      assert.equal(kb.lightIdx[q], a.lightIdx[q], `frame ${j}, row ${q}: its light`);
      const c = new Float32Array(kb.words.buffer, (q * KS + 2) * 4, 1)[0];
      assert.ok(Number.isInteger(c) && c >= 0 && c < f.nSun, `frame ${j}, row ${q}: a caster's key`);
      for (let w = 0; w < KF; w++) assert.equal(kb.words[q * KS + w], keyed[c * KF + w], `frame ${j}, row ${q}: keyed float ${w}`);
      for (let w = 0; w < 4; w++) {
        assert.equal(kb.words[q * KS + KF + w], a.words[q * SF + GPU_CASTER_LIGHT_FLOAT + w], `frame ${j}, row ${q}: light ${w}`);
      }
      rows++;
    }
    for (let w = kb.cursor * KS; w < kb.words.length; w++) assert.equal(kb.words[w], 0xa5a5a5a5, `frame ${j}: a word past the stamp`);
    for (let q = kb.cursor; q < kb.lightIdx.length; q++) assert.equal(kb.lightIdx[q], 0xa5a5, `frame ${j}: a light index past the stamp`);
  }
  assert.ok(rows > 2000, `the frames stamp rows (${rows})`);
  assert.ok(filled >= 6, `stamps that fill up (${filled})`);
});
