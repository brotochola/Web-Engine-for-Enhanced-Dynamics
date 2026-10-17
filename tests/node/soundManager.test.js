import test from 'node:test';
import assert from 'node:assert/strict';

import { SoundManager } from '../../src/core/soundManager.js';

function boot({ slots = 8, channels } = {}) {
  SoundManager.setEnabled(true);
  SoundManager._nameToId.clear();
  SoundManager._idToName.length = 0;
  SoundManager._clearAssets();
  SoundManager._muted = false;
  SoundManager._savedMasterVolume = 1;
  delete globalThis.Camera;
  const sab = new SharedArrayBuffer((SoundManager.HEADER_SIZE + slots * SoundManager.SLOT_SIZE) * 4);
  SoundManager.initializeSlotSAB({ sab, maxSlots: slots });
  SoundManager._f32[SoundManager.HEADER_MIX_GAIN] = 1;
  SoundManager._f32[SoundManager.HEADER_MASTER_VOL] = 1;
  SoundManager.configureChannels(channels || {
    sfx: { volume: 1, pan: 0, maxVoices: slots },
  });
  SoundManager._ensureLevelsSab();
  SoundManager._levelsI32.fill(0);
  SoundManager._levelsReadIndex = -1;
  SoundManager._assignId('hit');
  SoundManager._assignId('quiet');
  SoundManager._assignId('loud');
  SoundManager._assignId('soft');
}

test('play, stop, stopSlot, and stopAll own the slot table', { concurrency: false }, () => {
  boot();
  const slot = SoundManager.play('hit', 0.5, 1, 1, 1, 0, Number.NaN, Number.NaN, 'sfx');
  assert.equal(slot, 0);
  assert.equal(SoundManager.getActiveSlotCount(), 1);
  const voices = SoundManager.readPlayingVoices([]);
  assert.equal(voices.length, 1);
  assert.equal(voices[0].name, 'hit');
  assert.equal(voices[0].loop, 1);
  assert.equal(voices[0].cursor, 0);
  assert.equal(voices[0].channelName, 'sfx');
  assert.equal(voices[0].channel, 0);
  assert.ok(Math.abs(voices[0].volume - 0.5) < 1e-5);

  SoundManager.stopSlot(slot);
  assert.equal(SoundManager.getActiveSlotCount(), 0);

  SoundManager.play('hit', 1, 1, 1, 0, 0, Number.NaN, Number.NaN, 'sfx');
  SoundManager.play('quiet', 1, 1, 1, 0, 0, Number.NaN, Number.NaN, 'sfx');
  SoundManager.stop('hit');
  const left = SoundManager.readPlayingVoices([]);
  assert.equal(left.length, 1);
  assert.equal(left[0].name, 'quiet');

  SoundManager.play('loud', 1, 1, 1, 0, 0, Number.NaN, Number.NaN, 'sfx');
  SoundManager.stopAll();
  assert.equal(SoundManager.getActiveSlotCount(), 0);
});

test('bus volume, pan, mute, master, and mix gain write the shared buffers', { concurrency: false }, () => {
  boot();
  const bus = SoundManager.channel('sfx');
  bus.volume = 0.4;
  bus.pan = -0.5;
  assert.ok(Math.abs(bus.volume - 0.4) < 1e-6);
  assert.ok(Math.abs(bus.pan + 0.5) < 1e-6);
  bus.muted = true;
  assert.equal(bus.muted, true);
  bus.muted = false;
  assert.equal(bus.muted, false);

  SoundManager.setMixGain(0.25);
  assert.equal(SoundManager.getMixGain(), 0.25);
  SoundManager.setMasterVolume(0.8);
  assert.equal(SoundManager.getMasterVolume(), 0.8);
  SoundManager.setMuted(true);
  assert.equal(SoundManager.isMuted(), true);
  assert.equal(SoundManager._f32[SoundManager.HEADER_MASTER_VOL], 0);
  SoundManager.setMuted(false);
  assert.ok(Math.abs(SoundManager._f32[SoundManager.HEADER_MASTER_VOL] - 0.8) < 1e-6);
});

test('a bus at its cap still accepts a play after those slots were freed', { concurrency: false }, () => {
  boot({
    slots: 2,
    channels: { sfx: { volume: 1, pan: 0, maxVoices: 1 } },
  });
  const held = SoundManager.play('loud', 0.9, 1, 1, 0, 0, Number.NaN, Number.NaN, 'sfx');
  assert.equal(held, 0);
  Atomics.store(SoundManager._i32, SoundManager.HEADER_SIZE, SoundManager.STATE_FREE);
  const next = SoundManager.play('soft', 0.1, 1, 1, 0, 0, Number.NaN, Number.NaN, 'sfx');
  assert.equal(next, 0);
  assert.equal(SoundManager.getActiveSlotCount(), 1);
  const voices = SoundManager.readPlayingVoices([]);
  assert.equal(voices.length, 1);
  assert.equal(voices[0].name, 'soft');
});

test('a full bus drops a quieter voice and counts it', { concurrency: false }, () => {
  boot({
    slots: 4,
    channels: { sfx: { volume: 1, pan: 0, maxVoices: 1 } },
  });
  const quiet = SoundManager.play('quiet', 0.2, 1, 1, 0, 0, Number.NaN, Number.NaN, 'sfx');
  assert.equal(quiet, 0);
  const loud = SoundManager.play('loud', 0.9, 1, 1, 0, 0, Number.NaN, Number.NaN, 'sfx');
  assert.equal(loud, 0);
  assert.equal(SoundManager.getActiveSlotCount(), 1);
  const replaced = SoundManager.readPlayingVoices([]);
  assert.equal(replaced[0].name, 'loud');
  const dropped = SoundManager.play('soft', 0.1, 1, 1, 0, 0, Number.NaN, Number.NaN, 'sfx');
  assert.equal(dropped, -1);
  assert.equal(Atomics.load(SoundManager._i32, SoundManager.HEADER_DROPPED), 1);
  assert.equal(SoundManager.getActiveSlotCount(), 1);
});

test('sampleOutputLevels reuses one object and clears the clip flag', { concurrency: false }, () => {
  boot();
  const i32 = SoundManager._levelsI32;
  const f32 = SoundManager._levelsF32;
  const ring = SoundManager.LEVEL_RING;
  const base = SoundManager.LEVEL_HEADER;
  f32[base] = 0.5;
  f32[base + ring] = 0.25;
  f32[base + ring * 2] = 0.04;
  Atomics.store(i32, 1, 1);
  Atomics.store(i32, 0, 1);
  const first = SoundManager.sampleOutputLevels();
  assert.equal(first.clip, true);
  assert.equal(first.count, 1);
  assert.ok(Math.abs(first.peakL - 0.5) < 1e-6);
  assert.ok(Math.abs(first.peakR - 0.25) < 1e-6);
  assert.ok(Math.abs(first.rms - 0.2) < 1e-5);
  const second = SoundManager.sampleOutputLevels();
  assert.equal(first, second);
  assert.equal(second.clip, false);
  assert.equal(second.count, 0);
});

test('getMetrics fills the object it is given', { concurrency: false }, () => {
  boot();
  const out = { activeSlots: -1 };
  assert.equal(SoundManager.getMetrics(out), out);
  assert.equal(out.activeSlots, 0);
  assert.equal(out.maxSlots, 8);
  assert.equal(out.state, 'closed');
});

test('an undeclared channel warns once after configure', { concurrency: false }, () => {
  boot();
  const warns = [];
  const orig = console.warn;
  console.warn = (msg) => warns.push(String(msg));
  try {
    SoundManager.channel('sfx');
    SoundManager.channel('missing');
    SoundManager.channel('missing');
  } finally {
    console.warn = orig;
  }
  assert.equal(warns.length, 1);
  assert.match(warns[0], /missing/);
});

test('a sound far outside the camera takes no slot', { concurrency: false }, () => {
  boot();
  globalThis.Camera = {
    zoom: 1,
    getViewportBounds() {
      return { left: 0, right: 100, top: 0, bottom: 100, width: 100, height: 100 };
    },
  };
  const slot = SoundManager.play('hit', 1, 1, 1, 0, 0, 10000, 10000, 'sfx');
  assert.equal(slot, -1);
  assert.equal(SoundManager.getActiveSlotCount(), 0);
  delete globalThis.Camera;
});
