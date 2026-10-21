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
  assert.equal(audioThreadRelease(held), SoundManager.STATE_PLAYING);
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

// The audio thread frees a voice with a CAS 1 -> 0 and never touches the bus lists
// (audioMixerProcessor.js releaseVoice). The old bus keeps the slot in its list until
// its next play. If another bus re-claims that slot first, the old entry must not be
// read as a live voice of the old bus. A won CAS also bumps the release counter, which
// tells the host its lists may hold dead entries (E-46).
function audioThreadRelease(slot) {
  const b = SoundManager.HEADER_SIZE + slot * SoundManager.SLOT_SIZE;
  const was = Atomics.compareExchange(SoundManager._i32, b, SoundManager.STATE_PLAYING, SoundManager.STATE_FREE);
  if (was === SoundManager.STATE_PLAYING) Atomics.add(SoundManager._channelI32, SoundManager.CHANNEL_RELEASED, 1);
  return was;
}

function twoBuses() {
  boot({
    slots: 4,
    channels: {
      ui: { volume: 1, pan: 0, maxVoices: 1 },
      sfx: { volume: 1, pan: 0, maxVoices: 4 },
    },
  });
}

test('a slot freed by the audio thread and re-claimed by another bus is not counted by its old bus', { concurrency: false }, () => {
  twoBuses();
  const click = SoundManager.play('hit', 0.5, 1, 1, 0, 0, Number.NaN, Number.NaN, 'ui');
  assert.equal(click, 0);
  assert.equal(audioThreadRelease(click), SoundManager.STATE_PLAYING);
  const boom = SoundManager.play('loud', 0.9, 1, 1, 0, 0, Number.NaN, Number.NaN, 'sfx');
  assert.equal(boom, 0, 'sfx takes the lowest free slot, the one ui used to hold');

  const next = SoundManager.play('quiet', 0.1, 1, 1, 0, 0, Number.NaN, Number.NaN, 'ui');
  assert.notEqual(next, -1, 'ui holds no voice, so a quiet click must not be dropped');
  assert.equal(Atomics.load(SoundManager._i32, SoundManager.HEADER_DROPPED), 0);
  const names = SoundManager.readPlayingVoices([]).map((v) => `${v.name}:${v.channelName}`).sort();
  assert.deepEqual(names, ['loud:sfx', 'quiet:ui']);
});

test('a bus never steals a voice that another bus re-claimed', { concurrency: false }, () => {
  twoBuses();
  const click = SoundManager.play('hit', 0.2, 1, 1, 0, 0, Number.NaN, Number.NaN, 'ui');
  audioThreadRelease(click);
  const boom = SoundManager.play('loud', 0.3, 1, 1, 0, 0, Number.NaN, Number.NaN, 'sfx');
  assert.equal(boom, 0);

  // Louder than the stale cached quietest ui voice (0.2): the old code stole slot 0.
  const louder = SoundManager.play('soft', 0.8, 1, 1, 0, 0, Number.NaN, Number.NaN, 'ui');
  assert.notEqual(louder, boom, 'the sfx voice on slot 0 must survive');
  const voices = SoundManager.readPlayingVoices([]);
  const onSlot0 = voices.find((v) => v.slot === 0);
  assert.ok(onSlot0, 'slot 0 is still playing');
  assert.equal(onSlot0.name, 'loud');
  assert.equal(onSlot0.channelName, 'sfx');
  assert.equal(voices.length, 2);
});

test('a steal that loses the race to another bus hands the slot back untouched', { concurrency: false }, () => {
  twoBuses();
  const H = SoundManager.HEADER_SIZE;
  const i32 = SoundManager._i32;
  const quiet = SoundManager.play('quiet', 0.2, 1, 1, 0, 0, Number.NaN, Number.NaN, 'ui');
  assert.equal(quiet, 0);
  const sfxBus = SoundManager._channelNameToIndex.get('sfx');
  const hitId = SoundManager._nameToId.get('hit');

  // ui is full, so a louder ui play steals its cached quietest voice (slot 0). Right at
  // that CAS, the audio thread frees slot 0 and an sfx play re-claims it: PLAYING again.
  const realCas = Atomics.compareExchange;
  let raced = false;
  Atomics.compareExchange = function (ta, index, expected, replacement) {
    if (!raced && ta === i32 && index === H && expected === SoundManager.STATE_PLAYING && replacement === SoundManager.STATE_CLAIMING) {
      raced = true;
      realCas.call(Atomics, i32, H, SoundManager.STATE_PLAYING, SoundManager.STATE_FREE);
      i32[H + 1] = hitId;
      i32[H + 7] = sfxBus;
      Atomics.store(i32, H, SoundManager.STATE_PLAYING);
    }
    return realCas.call(Atomics, ta, index, expected, replacement);
  };
  let got;
  try {
    got = SoundManager.play('loud', 0.9, 1, 1, 0, 0, Number.NaN, Number.NaN, 'ui');
  } finally {
    Atomics.compareExchange = realCas;
  }
  assert.ok(raced, 'the interleaving ran');
  assert.equal(Atomics.load(i32, H), SoundManager.STATE_PLAYING, 'slot 0 is not left in CLAIMING');
  assert.equal(i32[H + 1], hitId, 'the sfx voice was not overwritten');
  assert.equal(i32[H + 7] & 0xff, sfxBus);
  assert.equal(got, 1, 'ui lost its only voice, so it takes a free slot instead of dropping');
  assert.equal(Atomics.load(i32, SoundManager.HEADER_DROPPED), 0);
});

test('a bus that re-claims its own freed slot keeps one list entry for it', { concurrency: false }, () => {
  boot({ slots: 4, channels: { sfx: { volume: 1, pan: 0, maxVoices: 2 } } });
  const a = SoundManager.play('hit', 0.5, 1, 1, 0, 0, Number.NaN, Number.NaN, 'sfx');
  const b = SoundManager.play('quiet', 0.6, 1, 1, 0, 0, Number.NaN, Number.NaN, 'sfx');
  assert.deepEqual([a, b], [0, 1]);
  audioThreadRelease(a);
  const c = SoundManager.play('loud', 0.7, 1, 1, 0, 0, Number.NaN, Number.NaN, 'sfx');
  assert.equal(c, 0);
  // Bus is now full with b and c; a quieter play drops, a louder one replaces b (0.6).
  assert.equal(SoundManager.play('soft', 0.1, 1, 1, 0, 0, Number.NaN, Number.NaN, 'sfx'), -1);
  const d = SoundManager.play('soft', 0.9, 1, 1, 0, 0, Number.NaN, Number.NaN, 'sfx');
  assert.equal(d, 1);
  const names = SoundManager.readPlayingVoices([]).map((v) => v.name).sort();
  assert.deepEqual(names, ['loud', 'soft']);
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
    canvasWidth: 100,
    canvasHeight: 100,
    worldToScreen(x, y, out) {
      out.x = x;
      out.y = y;
      return out;
    },
  };
  const slot = SoundManager.play('hit', 1, 1, 1, 0, 0, 10000, 10000, 'sfx');
  assert.equal(slot, -1);
  assert.equal(SoundManager.getActiveSlotCount(), 0);
  delete globalThis.Camera;
});

test('E-46: a voice stopped from the host frees its place on a full bus', { concurrency: false }, () => {
  boot({
    slots: 4,
    channels: { sfx: { volume: 1, pan: 0, maxVoices: 2 } },
  });
  const a = SoundManager.play('loud', 0.9, 1, 1, 0, 0, Number.NaN, Number.NaN, 'sfx');
  const b = SoundManager.play('loud', 0.8, 1, 1, 0, 0, Number.NaN, Number.NaN, 'sfx');
  assert.ok(a >= 0 && b >= 0);
  SoundManager.stopSlot(a);
  // The list still names the stopped slot. The stop bumped the release counter, so
  // the next play walks the list, finds the room and takes it instead of dropping.
  const quiet = SoundManager.play('quiet', 0.1, 1, 1, 0, 0, Number.NaN, Number.NaN, 'sfx');
  assert.notEqual(quiet, -1, 'the bus has room for a quiet voice');
  assert.equal(Atomics.load(SoundManager._i32, SoundManager.HEADER_DROPPED), 0);
  assert.equal(SoundManager.getActiveSlotCount(), 2);
});
