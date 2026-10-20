// E-24: the frame clock is the instrument the CPU trace could not be.
//
// A stamp that cannot be checked will be believed anyway. These tests are the
// checks that do not need a browser: the layout the physics host copies by
// hand, a publish/stamp round trip on a real SharedArrayBuffer, and the
// verdict rules named before the Predator run. The cross-realm time origin
// is the one thing Node cannot see. The browser probe refuses a phase claim
// when that check fails.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HEADER_BYTES,
  SLOT_BYTES,
  SLOT_COUNT,
  FRAME_CLOCK_BYTES,
  FRAME_CLOCK_SLOTS,
  frameClockSlot,
  createFrameClockBuffer,
  bindFrameClock,
  publishFrame,
  stampStep,
  readPhaseSample,
} from '../../src/util/frameClock.js';
import { summarizePhase } from '../bench/framePhaseSummary.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('layout matches the physics host copy', () => {
  const host = fs.readFileSync(path.join(ROOT, 'src/box2d/physicsHostImpl.js'), 'utf8');
  assert.match(host, /var FC_HEADER = 32;/);
  assert.match(host, /var FC_SLOT = 32;/);
  assert.match(host, /var FC_SEQ = 4;/);
  assert.match(host, /var FC_GEN = 5;/);
  assert.equal(HEADER_BYTES, 32);
  assert.equal(SLOT_BYTES, 32);
  assert.equal(FRAME_CLOCK_BYTES, HEADER_BYTES + SLOT_COUNT * SLOT_BYTES);
  assert.equal(frameClockSlot('physics'), FRAME_CLOCK_SLOTS.physics);
  assert.equal(frameClockSlot('logic', 0), 5);
  assert.equal(frameClockSlot('logic', 8), -1);
  assert.equal(frameClockSlot('spatial', 0), 13);
  assert.equal(frameClockSlot('spatial', 8), -1);
});

test('publish and stamp round-trip on one buffer', () => {
  const view = bindFrameClock(createFrameClockBuffer());
  const abs = 1_700_000_000_000;
  const gen = publishFrame(view, abs);
  assert.equal(gen, 1);
  stampStep(view, frameClockSlot('main'), abs, abs + 1.25);
  stampStep(view, frameClockSlot('preRender'), abs + 0.4, abs + 7.1);
  const sample = readPhaseSample(view);
  assert.equal(sample.mainGen, 1);
  assert.equal(sample.mainT0, abs);
  const main = sample.slots.find((s) => s.name === 'main');
  const pre = sample.slots.find((s) => s.name === 'preRender');
  assert.equal(main.start, abs);
  assert.equal(main.end, abs + 1.25);
  assert.equal(main.gen, 1);
  assert.equal(pre.start, abs + 0.4);
  assert.equal(pre.gen, 1);
  stampStep(view, -1, abs, abs + 1);
  stampStep(view, 99, abs, abs + 1);
  assert.equal(readPhaseSample(view).slots.length, 2);
});

function sampleAt(i, starts) {
  const t0 = 1_700_000_000_000 + i * 16.67;
  return {
    mainGen: i + 1,
    mainT0: t0,
    slots: starts.map((s) => ({
      name: s.name,
      gen: s.gen ?? i + 1,
      start: t0 + s.at,
      end: t0 + s.at + (s.dur ?? 5),
    })),
  };
}

const REQUIRED_STARTS = [
  { name: 'main', at: 0, dur: 0.8 },
  { name: 'physics', at: 0.3, dur: 5 },
  { name: 'renderer', at: 0.4, dur: 3 },
  { name: 'particle', at: 0.5, dur: 1 },
  { name: 'preRender', at: 0.2, dur: 7 },
  { name: 'logic0', at: 0.6, dur: 4 },
  { name: 'spatial0', at: 0.35, dur: 6 },
];

test('clustered starts are wake-together', () => {
  const samples = Array.from({ length: 40 }, (_, i) => sampleAt(i, REQUIRED_STARTS));
  const out = summarizePhase(samples);
  assert.equal(out.verdict, 'wake-together');
  assert.ok(out.spreadMs <= 2);
});

test('starts spread across the frame are offset', () => {
  const spread = REQUIRED_STARTS.map((s, i) => ({ ...s, at: i * 2.4 }));
  const samples = Array.from({ length: 40 }, (_, i) => sampleAt(i, spread));
  const out = summarizePhase(samples);
  assert.equal(out.verdict, 'offset');
  assert.ok(out.spreadMs >= 8);
});

test('a worker on a different epoch breaks the clock', () => {
  const bad = REQUIRED_STARTS.map((s) =>
    s.name === 'physics' ? { ...s, at: 5000 } : s
  );
  const samples = Array.from({ length: 40 }, (_, i) => sampleAt(i, bad));
  const out = summarizePhase(samples);
  assert.equal(out.verdict, 'clock-broken');
  assert.ok(out.broken.includes('physics'));
});

test('a stamp left from the previous frame is not a phase offset', () => {
  const samples = Array.from({ length: 40 }, (_, i) => {
    const base = sampleAt(i, REQUIRED_STARTS.filter((s) => s.name !== 'particle'));
    base.slots.push({
      name: 'particle',
      gen: i,
      start: base.mainT0 - 16.6,
      end: base.mainT0 - 16.6 + 1,
    });
    return base;
  });
  const out = summarizePhase(samples);
  assert.equal(out.verdict, 'wake-together');
  assert.ok(out.spreadMs <= 2);
});

test('torn stamps are not a phase', () => {
  const samples = Array.from({ length: 40 }, (_, i) =>
    sampleAt(i, REQUIRED_STARTS.map((s) => ({ ...s, dur: 80 })))
  );
  const out = summarizePhase(samples);
  assert.equal(out.verdict, 'clock-broken');
});

test('a short capture is not a verdict', () => {
  const out = summarizePhase(Array.from({ length: 5 }, (_, i) => sampleAt(i, REQUIRED_STARTS)));
  assert.equal(out.verdict, 'thin');
});
