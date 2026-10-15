#!/usr/bin/env node
/**
 * Kernel: SoundManager._writeSlot (the slot claim behind every play()) on the
 * shipped class with its own slot SAB, 2048 slots like Predator.
 *
 * The Predator fixture caught all 2048 slots busy: every play() scanned every
 * slot and dropped the sound. Cases: 0, 50, 90 and 100 % occupancy. Between
 * calls the "worklet" frees the slot just claimed so occupancy stays put.
 *
 *   node tests/bench/audioSlotMicrobench.mjs
 *   node tests/bench/audioSlotMicrobench.mjs --output out.json
 */
import { SoundManager } from '../../src/core/soundManager.js';
import { isCli, mulberry32, parseArgs, timeIt, writeReport } from './microbenchHelpers.mjs';

// Shipped claim. `buslist` keeps a per-bus slot list and the two quietest
// voices so a full bus does not walk every other bus's slots.
const originalWriteSlot = SoundManager._writeSlot.bind(SoundManager);
let busListOn = false;
let busLists = null;
let busCount = null;
let quietSlot = null;
let quietVol = null;
let secondSlot = null;
let secondVol = null;
let listPos = null;

function resetBusList() {
  const chI = SoundManager._channelI32;
  busLists = new Array(SoundManager.MAX_CHANNELS);
  busCount = new Int32Array(SoundManager.MAX_CHANNELS);
  quietSlot = new Int32Array(SoundManager.MAX_CHANNELS);
  secondSlot = new Int32Array(SoundManager.MAX_CHANNELS);
  quietVol = new Float64Array(SoundManager.MAX_CHANNELS);
  secondVol = new Float64Array(SoundManager.MAX_CHANNELS);
  for (let bus = 0; bus < SoundManager.MAX_CHANNELS; bus++) {
    const maxV = chI[SoundManager.CHANNEL_HEADER + bus * SoundManager.CHANNEL_STRIDE + 2] >> 8;
    busLists[bus] = new Int32Array(maxV > 0 ? maxV : 1);
    quietSlot[bus] = -1;
    secondSlot[bus] = -1;
    quietVol[bus] = Infinity;
    secondVol[bus] = Infinity;
  }
  listPos = new Int32Array(SoundManager._maxSlots);
  listPos.fill(-1);
}

function noteFreed(slot) {
  const i32 = SoundManager._i32;
  const H = SoundManager.HEADER_SIZE;
  const S = SoundManager.SLOT_SIZE;
  const b = H + slot * S;
  const bus = i32[b + 7] & 0xff;
  Atomics.store(i32, b, SoundManager.STATE_FREE);
  const idx = listPos[slot];
  if (idx < 0) return;
  const list = busLists[bus];
  const last = busCount[bus] - 1;
  const moved = list[last];
  list[idx] = moved;
  if (moved !== slot) {
    listPos[moved] = idx;
    const mb = H + moved * S;
    i32[mb + 7] = (i32[mb + 7] & 0xff) | (idx << 8);
  }
  listPos[slot] = -1;
  busCount[bus] = last;
  if (quietSlot[bus] === slot) {
    quietSlot[bus] = secondSlot[bus];
    quietVol[bus] = secondSlot[bus] >= 0 ? secondVol[bus] : Infinity;
    secondSlot[bus] = -1;
    secondVol[bus] = Infinity;
  } else if (secondSlot[bus] === slot) {
    secondSlot[bus] = -1;
    secondVol[bus] = Infinity;
  }
}

function publishQuiet(bus) {
  const list = busLists[bus];
  const n = busCount[bus];
  const f32 = SoundManager._f32;
  const H = SoundManager.HEADER_SIZE;
  const S = SoundManager.SLOT_SIZE;
  let qS = -1;
  let qV = Infinity;
  let sS = -1;
  let sV = Infinity;
  for (let i = 0; i < n; i++) {
    const slot = list[i];
    const vol = f32[H + slot * S + 4];
    if (qS < 0 || vol < qV || (vol === qV && slot < qS)) {
      sS = qS;
      sV = qV;
      qS = slot;
      qV = vol;
    } else if (vol < sV || (vol === sV && (sS < 0 || slot < sS))) {
      sS = slot;
      sV = vol;
    }
  }
  quietSlot[bus] = qS;
  quietVol[bus] = qV;
  secondSlot[bus] = sS;
  secondVol[bus] = sV;
}

function rememberVoice(bus, slot, volume) {
  if (quietSlot[bus] < 0) {
    if (busCount[bus] === 1) {
      quietSlot[bus] = slot;
      quietVol[bus] = volume;
    }
    return;
  }
  const qS = quietSlot[bus];
  const qV = quietVol[bus];
  if (volume < qV || (volume === qV && slot < qS)) {
    secondSlot[bus] = qS;
    secondVol[bus] = qV;
    quietSlot[bus] = slot;
    quietVol[bus] = volume;
    return;
  }
  // A new voice is the second-quietest only when it is the other voice on the
  // bus, or when it beats a second we already measured. Guessing it after the
  // second was cleared skips quieter voices still on the bus.
  if (busCount[bus] === 2) {
    secondSlot[bus] = slot;
    secondVol[bus] = volume;
    return;
  }
  const sS = secondSlot[bus];
  if (sS < 0) return;
  const sV = secondVol[bus];
  if (volume < sV || (volume === sV && slot < sS)) {
    secondSlot[bus] = slot;
    secondVol[bus] = volume;
  }
}

function retuneStolen(bus, slot, volume) {
  const sS = secondSlot[bus];
  const sV = secondVol[bus];
  if (sS >= 0 && volume < sV) {
    quietSlot[bus] = slot;
    quietVol[bus] = volume;
    return;
  }
  if (sS >= 0) {
    quietSlot[bus] = sS;
    quietVol[bus] = sV;
  } else {
    quietSlot[bus] = -1;
    quietVol[bus] = Infinity;
  }
  secondSlot[bus] = -1;
  secondVol[bus] = Infinity;
}

function writeSlotBusList(audioId, volume, pitch, pan, loop, channelIndex = 0) {
  const i32 = SoundManager._i32;
  const f32 = SoundManager._f32;
  if (!i32 || !f32) return -1;
  const chI = SoundManager._channelI32;
  if (!chI) return originalWriteSlot(audioId, volume, pitch, pan, loop, channelIndex);

  const H = SoundManager.HEADER_SIZE;
  const S = SoundManager.SLOT_SIZE;
  const max = SoundManager._maxSlots;
  const FREE = SoundManager.STATE_FREE;
  const PLAYING = SoundManager.STATE_PLAYING;
  const bus = channelIndex | 0;
  let maxV = chI[SoundManager.CHANNEL_HEADER + bus * SoundManager.CHANNEL_STRIDE + 2] >> 8;
  if (maxV < 1) maxV = SoundManager.maxVoicesPerChannel;

  const claim = (slot, from) => {
    const b = H + slot * S;
    if (Atomics.compareExchange(i32, b, from, SoundManager.STATE_CLAIMING) !== from) return -1;
    SoundManager._fillSlot(b, audioId, volume, pitch, pan, loop, bus);
    const stored = f32[b + 4];
    if (from === FREE) {
      const idx = busCount[bus];
      busLists[bus][idx] = slot;
      listPos[slot] = idx;
      busCount[bus] = idx + 1;
      i32[b + 7] = bus | (idx << 8);
      rememberVoice(bus, slot, stored);
    } else {
      const idx = listPos[slot];
      if (idx >= 0) i32[b + 7] = bus | (idx << 8);
      retuneStolen(bus, slot, stored);
    }
    SoundManager._raiseHighWater(slot);
    return slot;
  };

  if (busCount[bus] >= maxV) {
    if (quietSlot[bus] < 0 || (volume > quietVol[bus] && secondSlot[bus] < 0)) publishQuiet(bus);
    if (!(volume > quietVol[bus])) {
      Atomics.add(i32, SoundManager.HEADER_DROPPED, 1);
      return -1;
    }
    const got = claim(quietSlot[bus], PLAYING);
    if (got >= 0) return got;
    publishQuiet(bus);
    if (!(volume > quietVol[bus])) {
      Atomics.add(i32, SoundManager.HEADER_DROPPED, 1);
      return -1;
    }
    const again = claim(quietSlot[bus], PLAYING);
    if (again >= 0) return again;
    Atomics.add(i32, SoundManager.HEADER_DROPPED, 1);
    return -1;
  }

  let hw = Atomics.load(chI, 5);
  if (hw < 0) hw = 0;
  if (hw > max) hw = max;
  const scan = hw < max ? hw : max;
  let free = -1;
  for (let s = 0; s < scan; s++) {
    if (Atomics.load(i32, H + s * S) === FREE) {
      free = s;
      break;
    }
  }
  if (free >= 0) {
    const got = claim(free, FREE);
    if (got >= 0) return got;
  } else if (hw < max) {
    const got = claim(hw, FREE);
    if (got >= 0) return got;
  }
  if (quietSlot[bus] < 0) publishQuiet(bus);
  if (quietSlot[bus] >= 0 && volume > quietVol[bus]) {
    const got = claim(quietSlot[bus], PLAYING);
    if (got >= 0) return got;
  }
  Atomics.add(i32, SoundManager.HEADER_DROPPED, 1);
  return -1;
}

const VARIANTS = {
  base: () => {
    busListOn = false;
    SoundManager._writeSlot = originalWriteSlot;
  },
  buslist: () => {
    busListOn = true;
    SoundManager._writeSlot = writeSlotBusList;
  },
};

/**
 * Contention: `threads` worker_threads (the 3 logic workers) call _writeSlot
 * on one saturated SAB at once. Returns total calls per second.
 */
async function contended(variant, maxSlots, threads, callsPerThread) {
  const { Worker } = await import('node:worker_threads');
  const sab = new SharedArrayBuffer((SoundManager.HEADER_SIZE + maxSlots * SoundManager.SLOT_SIZE) * 4);
  const i32 = new Int32Array(sab);
  for (let s = 0; s < maxSlots; s++) i32[SoundManager.HEADER_SIZE + s * SoundManager.SLOT_SIZE] = SoundManager.STATE_PLAYING;
  const go = new Int32Array(new SharedArrayBuffer(4));
  const workers = [];
  const done = [];
  for (let t = 0; t < threads; t++) {
    const w = new Worker(new URL(import.meta.url), {
      workerData: { role: 'contender', variant, sab, maxSlots, calls: callsPerThread, go: go.buffer },
    });
    workers.push(w);
    done.push(new Promise((res, rej) => {
      w.once('message', res);
      w.once('error', rej);
    }));
  }
  await new Promise((r) => setTimeout(r, 300));
  const t0 = performance.now();
  Atomics.store(go, 0, 1);
  Atomics.notify(go, 0);
  await Promise.all(done);
  const ms = performance.now() - t0;
  for (const w of workers) await w.terminate();
  return { ms, opsPerSec: ((threads * callsPerThread) / ms) * 1000, iterations: threads * callsPerThread, threads };
}

async function contenderMain(data) {
  const { parentPort } = await import('node:worker_threads');
  VARIANTS[data.variant]();
  SoundManager.initializeSlotSAB({ sab: data.sab, maxSlots: data.maxSlots });
  const go = new Int32Array(data.go);
  for (let i = 0; i < 200; i++) SoundManager._writeSlot(7, 0.5, 1, 0, false);
  Atomics.wait(go, 0, 0);
  for (let i = 0; i < data.calls; i++) SoundManager._writeSlot(7, 0.5, 1, 0, false);
  parentPort.postMessage('done');
}

function setupSlots(maxSlots, occupancy, seed) {
  const sab = new SharedArrayBuffer((SoundManager.HEADER_SIZE + maxSlots * SoundManager.SLOT_SIZE) * 4);
  SoundManager.initializeSlotSAB({ sab, maxSlots });
  const i32 = SoundManager._i32;
  const rng = mulberry32(seed);
  const busy = Math.round(maxSlots * occupancy);
  const order = Array.from({ length: maxSlots }, (_, i) => i);
  for (let i = maxSlots - 1; i > 0; i--) {
    const j = (rng() * (i + 1)) | 0;
    [order[i], order[j]] = [order[j], order[i]];
  }
  for (let k = 0; k < busy; k++) {
    Atomics.store(i32, SoundManager.HEADER_SIZE + order[k] * SoundManager.SLOT_SIZE, SoundManager.STATE_PLAYING);
  }
  return i32;
}

function releaseSlot(slot) {
  if (busListOn) noteFreed(slot);
  else Atomics.store(SoundManager._i32, SoundManager.HEADER_SIZE + slot * SoundManager.SLOT_SIZE, SoundManager.STATE_FREE);
}

const STORM_CAPS = [128, 256, 128, 64];
const STORM_VOLS = [0.35, 0.5, 0.65, 0.8];
const STORM_BUSES = [1, 2, 3];
const _volBits = new Float32Array(1);
const _volU32 = new Uint32Array(_volBits.buffer);

function hashMix(h, x) {
  return Math.imul(h ^ (x >>> 0), 16777619) >>> 0;
}

function setupStorm() {
  const maxSlots = 2048;
  const sab = new SharedArrayBuffer((SoundManager.HEADER_SIZE + maxSlots * SoundManager.SLOT_SIZE) * 4);
  SoundManager.initializeSlotSAB({ sab, maxSlots });
  SoundManager._f32[SoundManager.HEADER_MIX_GAIN] = 1;
  SoundManager._f32[SoundManager.HEADER_MASTER_VOL] = 1;
  SoundManager.configureChannels({
    loops: { volume: 1, pan: 0, maxVoices: STORM_CAPS[0] },
    sfx: { volume: 1, pan: 0, maxVoices: STORM_CAPS[1] },
    hits: { volume: 1, pan: 0, maxVoices: STORM_CAPS[2] },
    voice: { volume: 1, pan: 0, maxVoices: STORM_CAPS[3] },
  });
  if (busListOn) resetBusList();
  for (let bus = 0; bus < STORM_CAPS.length; bus++) {
    for (let i = 0; i < STORM_CAPS[bus]; i++) {
      const slot = SoundManager._writeSlot(i + 1, STORM_VOLS[i & 3], 1, 0, 0, bus);
      if (slot < 0) throw new Error(`storm fill failed bus ${bus} at ${i}`);
    }
  }
}

function lowestPlaying(bus) {
  const i32 = SoundManager._i32;
  const H = SoundManager.HEADER_SIZE;
  const S = SoundManager.SLOT_SIZE;
  const max = SoundManager._maxSlots;
  for (let s = 0; s < max; s++) {
    const b = H + s * S;
    if (Atomics.load(i32, b) === SoundManager.STATE_PLAYING && (i32[b + 7] & 0xff) === bus) return s;
  }
  return -1;
}

function stormSignature(drops) {
  const i32 = SoundManager._i32;
  const f32 = SoundManager._f32;
  const H = SoundManager.HEADER_SIZE;
  const S = SoundManager.SLOT_SIZE;
  const max = SoundManager._maxSlots;
  const rows = [[], [], [], []];
  for (let s = 0; s < max; s++) {
    const b = H + s * S;
    if (Atomics.load(i32, b) !== SoundManager.STATE_PLAYING) continue;
    const bus = i32[b + 7] & 0xff;
    if (bus > 3) continue;
    _volBits[0] = f32[b + 4];
    rows[bus].push((i32[b + 1] * 1315423911) ^ _volU32[0]);
  }
  let h = drops >>> 0;
  for (let bus = 0; bus < 4; bus++) {
    rows[bus].sort((a, b) => a - b);
    h = hashMix(h, rows[bus].length);
    for (let i = 0; i < rows[bus].length; i++) h = hashMix(h, rows[bus][i]);
  }
  return h;
}

function stormScript() {
  const trace = [];
  let drops = 0;
  for (let n = 0; n < 240; n++) {
    const bus = STORM_BUSES[n % 3];
    const vol = STORM_VOLS[n & 3];
    const slot = SoundManager._writeSlot(1000 + n, vol, 1, 0, 0, bus);
    if (slot < 0) drops++;
    let freed = -1;
    if ((n & 7) === 7) {
      const victim = lowestPlaying(STORM_BUSES[(n >> 3) % 3]);
      if (victim >= 0) {
        freed = victim;
        releaseSlot(victim);
      }
    }
    if (process.env.STORM_TRACE) trace.push([n, bus, slot, freed]);
  }
  return {
    hash: stormSignature(drops + Atomics.load(SoundManager._i32, SoundManager.HEADER_DROPPED)),
    drops,
    counter: Atomics.load(SoundManager._i32, SoundManager.HEADER_DROPPED),
    trace,
  };
}

function stormHot() {
  for (let i = 0; i < 8; i++) {
    SoundManager._writeSlot(7, STORM_VOLS[i & 3], 1, 0, 0, STORM_BUSES[i % 3]);
  }
  const victim = lowestPlaying(STORM_BUSES[0]);
  if (victim >= 0) releaseSlot(victim);
}

async function main() {
  const args = parseArgs();
  const variant = String(args.variant || 'base');
  if (!VARIANTS[variant]) throw new Error(`unknown variant ${variant}`);
  VARIANTS[variant]();
  const maxSlots = Number(args.slots ?? 2048);
  const seed = 0xa0d10;
  const cases = {};
  const regimes = {};
  let checksum = 0;
  if (!process.env.STORM_TRACE) {
  for (const occ of [0, 0.5, 0.9, 1]) {
    const i32 = setupSlots(maxSlots, occ, seed);
    const H = SoundManager.HEADER_SIZE;
    const S = SoundManager.SLOT_SIZE;
    let claimed = 0;
    let dropped = 0;
    const call = () => {
      const s = SoundManager._writeSlot(7, 0.5, 1, 0, false);
      if (s >= 0) {
        claimed++;
        Atomics.store(i32, H + s * S, SoundManager.STATE_FREE);
      } else dropped++;
    };
    for (let i = 0; i < 2000; i++) call();
    // Occupancy is unchanged by the loop (each claim is freed), so the outcome
    // per call is fixed: claim when a slot is free, drop when none is.
    regimes[`occ${Math.round(occ * 100)}`] = { claimed, dropped };
    checksum = (checksum * 31 + claimed * 7 + dropped) >>> 0;
    const name = `occ${Math.round(occ * 100)}`;
    cases[name] = timeIt(`_writeSlot ${variant} ${name} (${maxSlots} slots)`, (iters) => {
      for (let i = 0; i < iters; i++) call();
    }, { iterations: 2000 });
  }
  }
  setupStorm();
  const storm = stormScript();
  const stormHash = storm.hash;
  checksum = (checksum * 31 + stormHash) >>> 0;
  regimes.storm = { checksum: stormHash, drops: storm.drops, counter: storm.counter };
  if (process.env.STORM_TRACE) {
    const fs = await import('node:fs');
    fs.writeFileSync(`tests/results/audio-kernels/storm-trace-${variant}.json`, JSON.stringify(storm.trace));
    console.log('drops', storm.drops, 'counter', storm.counter, 'hash', stormHash);
    return;
  }
  cases.storm = timeIt(`_writeSlot ${variant} storm`, (iters) => {
    for (let i = 0; i < iters; i++) stormHot();
  }, { iterations: 400 });
  // Predator regime: saturated slots, 3 logic workers claiming at once.
  const reps = [];
  for (let r = 0; r < 5; r++) reps.push(await contended(variant, maxSlots, 3, 400));
  reps.sort((a, b) => a.opsPerSec - b.opsPerSec);
  cases.occ100x3 = reps[2];
  console.log(`_writeSlot ${variant} occ100x3: ${Math.round(cases.occ100x3.opsPerSec)} calls/s (3 threads)`);
  const report = {
    feature: 'audio-slot-claim',
    functions: ['SoundManager._writeSlot'],
    variant,
    n: maxSlots,
    seed,
    regimes,
    checksum,
    cases,
  };
  if (args.output) writeReport(String(args.output), report);
  else console.log(JSON.stringify(regimes));
}

const { isMainThread, workerData } = await import('node:worker_threads');
if (!isMainThread && workerData?.role === 'contender') await contenderMain(workerData);
else if (isCli(import.meta.url)) await main();
