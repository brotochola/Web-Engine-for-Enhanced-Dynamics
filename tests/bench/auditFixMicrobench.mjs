// Kernel for the audit hygiene edits. Each case calls the shipped function.
// Does not patch src/. Run twice, once per tree, and compare ops/s.
//
//   node tests/bench/auditFixMicrobench.mjs --output tests/results/audit-fixes/one.json

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Camera } from '../../src/core/camera.js';
import { ChainPoints } from '../../src/core/chainPoints.js';
import { Collider } from '../../src/components/collider.js';
import { Layer } from '../../src/core/layer.js';
import { MeshGeometry, resetMeshGeometryWarns } from '../../src/core/meshGeometry.js';
import { MeshRenderer } from '../../src/components/meshRenderer.js';
import { RigidBody } from '../../src/components/rigidBody.js';
import { SharedResource } from '../../src/core/sharedResource.js';
import { SoundManager } from '../../src/core/soundManager.js';
import { Transform } from '../../src/components/transform.js';
import { ShapeType } from '../../src/util/configDefaults.js';
import { DEFAULT_LAYERS } from '../../src/util/configDefaults.js';
import {
  readTextureUpload,
  writeTextureUpload,
} from '../../src/core/layerTextureUpload.js';
import { checksumFloats, checksumInts, isCli, parseArgs, timeIt, writeReport } from './microbenchHelpers.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SEED = 0xa0d17001;

function row(name, timed, checksum) {
  return {
    opsPerSec: timed.opsPerSec,
    n: timed.iterations,
    seed: SEED,
    checksum,
    sampleMs: timed.ms,
  };
}

function loadWorklet() {
  const src = fs.readFileSync(path.join(repoRoot, 'src', 'workers', 'audioMixerProcessor.js'), 'utf8');
  const prev = {
    registerProcessor: globalThis.registerProcessor,
    AudioWorkletProcessor: globalThis.AudioWorkletProcessor,
    sampleRate: globalThis.sampleRate,
  };
  globalThis.AudioWorkletProcessor = class {
    constructor() {
      this.port = { postMessage() {}, set onmessage(_v) {}, get onmessage() { return null; } };
    }
  };
  globalThis.sampleRate = 48000;
  let Cls = null;
  globalThis.registerProcessor = (_n, c) => {
    Cls = c;
  };
  try {
    new Function(src)();
  } finally {
    globalThis.registerProcessor = prev.registerProcessor;
    globalThis.AudioWorkletProcessor = prev.AudioWorkletProcessor;
    globalThis.sampleRate = prev.sampleRate;
  }
  if (!Cls) throw new Error('worklet did not register');
  globalThis.sampleRate = 48000;
  return Cls;
}

function audioOneShot() {
  const Mixer = loadWorklet();
  const slots = 32;
  const frames = 128;
  const H = 4;
  const S = 8;
  const tailBase = 8 + 8 * 8;
  const p = new Mixer();
  const sab = new SharedArrayBuffer((H + slots * S) * 4);
  const i32 = new Int32Array(sab);
  const f32 = new Float32Array(sab);
  f32[2] = 1;
  f32[3] = 1;
  p._i32 = i32;
  p._f32 = f32;
  p._max = slots;
  p._ready = true;
  p._assets = new Map();
  const samples = new Float32Array(16).fill(0.25);
  p._assets.set(1, { ch: [samples], len: 16, nCh: 1 });
  const chWords = tailBase + 16;
  const chI = new Int32Array(chWords);
  const chF = new Float32Array(chI.buffer);
  chF[0] = 1;
  chI[5] = slots;
  const cb = 8;
  chF[cb] = 1;
  chI[cb + 2] = 32 << 8;
  chF[cb + 3] = 1;
  chF[cb + 4] = 1;
  chF[cb + 5] = 1;
  p._chI32 = chI;
  p._chF32 = chF;
  p._channelCount = 1;
  p._setVoiceCap(32);
  p._applyMaxVoices([32]);
  p._env.fill(1);
  p._masterEnv = 1;
  const L = new Float32Array(frames);
  const R = new Float32Array(frames);
  const out = [{ 0: L, 1: R }];
  const arm = () => {
    for (let s = 0; s < slots; s++) {
      const b = H + s * S;
      i32[b + 1] = 1;
      i32[b + 5] = 0;
      i32[b + 7] = 0;
      f32[b + 2] = 1;
      f32[b + 3] = 0;
      f32[b + 4] = 0.5;
      f32[b + 6] = 14;
      Atomics.store(i32, b, 1);
    }
    chI[tailBase] = 0;
  };
  arm();
  p.process([], out);
  let sum = 0;
  let free = 0;
  for (let i = 0; i < frames; i++) sum += L[i];
  for (let s = 0; s < slots; s++) if (Atomics.load(i32, H + s * S) === 0) free++;
  const checksum = checksumFloats(new Float32Array([sum, free, chI[tailBase]]), 3);
  const timed = timeIt('audio one-shot quantum', (n) => {
    for (let i = 0; i < n; i++) {
      arm();
      L.fill(0);
      R.fill(0);
      p.process([], out);
    }
  }, { iterations: 2000, silent: true });
  return row('audioOneShot', timed, checksum);
}

function popListed(slot) {
  const i32 = SoundManager._i32;
  const chI = SoundManager._channelI32;
  const H = SoundManager.HEADER_SIZE;
  const S = SoundManager.SLOT_SIZE;
  const b = H + slot * S;
  const packed = i32[b + 7] | 0;
  const idx = packed >>> 8;
  const tail = SoundManager._tail(0);
  const count = chI[tail + 1] | 0;
  if (idx >= 0 && idx < count) {
    const list = tail + SoundManager.TAIL_META;
    const last = count - 1;
    const moved = chI[list + last] | 0;
    chI[list + idx] = moved;
    if (moved !== slot) {
      const mb = H + moved * S;
      i32[mb + 7] = (i32[mb + 7] & 0xff) | (idx << 8);
    }
    chI[tail + 1] = last;
  }
  Atomics.store(i32, b, SoundManager.STATE_FREE);
}

function audioPlay() {
  const slots = 64;
  const sab = new SharedArrayBuffer((SoundManager.HEADER_SIZE + slots * SoundManager.SLOT_SIZE) * 4);
  SoundManager.setEnabled(true);
  SoundManager.initializeSlotSAB({ sab, maxSlots: slots });
  SoundManager._f32[SoundManager.HEADER_MIX_GAIN] = 1;
  SoundManager._f32[SoundManager.HEADER_MASTER_VOL] = 1;
  SoundManager.configureChannels({ sfx: { volume: 1, pan: 0, maxVoices: 48 } });
  for (let i = 0; i < 16; i++) {
    const slot = SoundManager._writeSlot(i + 1, 0.8, 1, 0, 0, 0);
    if (slot < 0) throw new Error('audio play fill failed');
  }
  const probe = SoundManager._writeSlot(99, 0.4, 1, 0, 0, 0);
  if (probe < 0) throw new Error('audio play probe failed');
  popListed(probe);
  const timed = timeIt('audio play while list is live', (n) => {
    let acc = 0;
    for (let i = 0; i < n; i++) {
      const slot = SoundManager._writeSlot(99, 0.4, 1, 0, 0, 0);
      acc += slot;
      if (slot >= 0) popListed(slot);
    }
    return acc;
  }, { iterations: 20000, silent: true });
  return row('audioPlay', timed, probe);
}

function chainScratch() {
  const src = fs.readFileSync(path.join(repoRoot, 'src', 'box2d', 'weedjsPost.js'), 'utf8');
  const mallocs = [];
  let next = 256;
  const heap = new Float32Array(4096);
  const Module = {
    _malloc(bytes) {
      const ptr = next;
      next += bytes;
      mallocs.push(bytes);
      return ptr;
    },
    _free() {},
    get HEAPF32() {
      return heap;
    },
  };
  let api;
  const mark = src.indexOf('// chain-scratch-start');
  if (mark >= 0) {
    const end = src.indexOf('// chain-scratch-end', mark);
    const slice = src.slice(mark, end);
    api = new Function('Module', `
      let maxChainPoints = 0;
      ${slice}
      return {
        setMax(n) { maxChainPoints = n | 0; },
        ensure() { ensureChainVertexScratch(); },
        base() { return chainVertexHeapFloatIndex; },
      };
    `)(Module);
  } else {
    api = new Function('Module', `
      let maxChainPoints = 0;
      let chainVertexHeapPointer = 0;
      let chainVertexHeapFloatIndex = 0;
      function ensureChainVertexScratch() {
        if (chainVertexHeapPointer || !(maxChainPoints > 0)) return;
        chainVertexHeapPointer = Module._malloc(maxChainPoints * 2 * 4);
        chainVertexHeapFloatIndex = chainVertexHeapPointer >> 2;
      }
      return {
        setMax(n) { maxChainPoints = n | 0; },
        ensure() { ensureChainVertexScratch(); },
        base() { return chainVertexHeapFloatIndex; },
      };
    `)(Module);
  }
  api.setMax(1024);
  api.ensure();
  const base = api.base();
  const checksum = mallocs[0] | 0;
  const timed = timeIt('chain scratch already sized', (n) => {
    const view = Module.HEAPF32;
    let acc = 0;
    for (let i = 0; i < n; i++) {
      api.ensure();
      const v = i & 1023;
      view[base + v] = v;
      acc += view[base + v];
    }
    return acc;
  }, { iterations: 1500000, silent: true });
  return row('chainScratch', timed, checksum);
}

function freeSpan() {
  MeshGeometry.reset();
  resetMeshGeometryWarns();
  const bytes = MeshGeometry.getBufferSize(64, 0, 4);
  MeshGeometry.initializeArrays(new SharedArrayBuffer(bytes), 64, 0, 4);
  const off = MeshGeometry.vertFreeOff;
  const len = MeshGeometry.vertFreeLen;
  const count = MeshGeometry.vertFreeCount;
  const once = () => {
    count[0] = 2;
    off[0] = 0;
    len[0] = 10;
    off[1] = 10;
    len[1] = 15;
    MeshGeometry._freeSpan(off, len, count, 25, 10);
  };
  once();
  const checksum = checksumInts(new Int32Array([count[0], off[0], len[0], count[0] > 1 ? off[1] : -1, count[0] > 1 ? len[1] : -1]), 5);
  const timed = timeIt('free span merge', (n) => {
    for (let i = 0; i < n; i++) once();
  }, { iterations: 800000, silent: true });
  MeshGeometry.reset();
  return row('freeSpan', timed, checksum);
}

function textureUnion() {
  const view = new Int32Array(new SharedArrayBuffer(32));
  const scratch = { x: 0, y: 0, w: 0, h: 0, resourceIndex: 0, fieldIndex: 0 };
  const read = (v) => (readTextureUpload.length >= 2 ? readTextureUpload(v, scratch) : readTextureUpload(v));
  const once = () => {
    view.fill(0);
    writeTextureUpload(view, 1, 1, 2, 2, 8, 8, 0, 0);
    writeTextureUpload(view, 4, 0, 2, 3, 8, 8, 0, 0);
    const rect = read(view);
    return rect ? rect.w + rect.h * 16 + rect.x * 256 + rect.y * 4096 : -1;
  };
  const checksum = once();
  const timed = timeIt('texture union', (n) => {
    for (let i = 0; i < n; i++) once();
  }, { iterations: 20000, silent: true });
  return row('textureUnion', timed, checksum >>> 0);
}

function locate() {
  class Grid extends SharedResource {}
  const schema = { cells: { type: Uint8Array, length: 64 } };
  Grid.initialize(new SharedArrayBuffer(SharedResource.getBufferSize(schema)), schema);
  const loc = SharedResource.locateView(Grid.cells);
  const checksum = (loc.resourceIndex << 8) | loc.fieldIndex;
  const timed = timeIt('locateView', (n) => {
    let acc = 0;
    for (let i = 0; i < n; i++) {
      const hit = SharedResource.locateView(Grid.cells);
      acc += hit.resourceIndex + hit.fieldIndex;
    }
    return acc;
  }, { iterations: 200000, silent: true });
  SharedResource.resetAll();
  return row('locateView', timed, checksum >>> 0);
}

function chainQuery() {
  const n = 1;
  Transform.initializeArrays(new SharedArrayBuffer(Transform.getBufferSize(n)), n);
  Transform.x = new Float32Array(n);
  Transform.y = new Float32Array(n);
  Transform.rotC = new Float32Array(n);
  Transform.rotS = new Float32Array(n);
  Collider.initializeArrays(new SharedArrayBuffer(Collider.getBufferSize(n)), n);
  ChainPoints.initializeArrays(new SharedArrayBuffer(ChainPoints.getBufferSize(128, n)), 128, n);
  const pts = new Float32Array(128 * 2);
  for (let i = 0; i < 128; i++) {
    const a = (i / 128) * Math.PI * 2;
    pts[i * 2] = Math.cos(a) * 40;
    pts[i * 2 + 1] = Math.sin(a) * 40;
  }
  ChainPoints.begin[0] = 0;
  ChainPoints.count[0] = 128;
  ChainPoints.loop[0] = 1;
  ChainPoints.xy.set(pts, 0);
  Transform.x[0] = 100;
  Transform.y[0] = 200;
  Transform.rotC[0] = 0;
  Transform.rotS[0] = 1;
  Collider.offsetX[0] = 3;
  Collider.offsetY[0] = -2;
  const rays = 16;
  let probe = 0;
  for (let i = 0; i < rays; i++) {
    probe += ChainPoints.rayDistance(0, 80 + i, 190, 1, 0, 80);
    probe += ChainPoints.pointNear(0, 90 + i, 200) ? 1 : 0;
  }
  const timed = timeIt('chain ray and pick', (iters) => {
    for (let k = 0; k < iters; k++) {
      for (let i = 0; i < rays; i++) {
        ChainPoints.rayDistance(0, 80 + i, 190, 1, 0, 80);
        ChainPoints.pointNear(0, 90 + i, 200);
      }
    }
  }, { iterations: 200, silent: true });
  return row('chainQuery', timed, checksumFloats(new Float32Array([probe]), 1));
}

function meshPlane() {
  MeshGeometry.reset();
  resetMeshGeometryWarns();
  const bytes = MeshGeometry.getBufferSize(256, 1024, 1);
  MeshGeometry.initializeArrays(new SharedArrayBuffer(bytes), 256, 1024, 1);
  const mr = new MeshRenderer(0);
  mr.setPlane(20, 12, 8, 8);
  const checksum = checksumFloats(MeshGeometry.vertexX, MeshGeometry.vertCount[0]);
  const timed = timeIt('setPlane 8x8', (n) => {
    for (let i = 0; i < n; i++) mr.setPlane(20, 12, 8, 8);
  }, { iterations: 4000, silent: true });
  MeshGeometry.reset();
  return row('setPlane', timed, checksum);
}

function metrics() {
  const slots = 2048;
  const sab = new SharedArrayBuffer((SoundManager.HEADER_SIZE + slots * SoundManager.SLOT_SIZE) * 4);
  SoundManager.initializeSlotSAB({ sab, maxSlots: slots });
  const H = SoundManager.HEADER_SIZE;
  const S = SoundManager.SLOT_SIZE;
  for (let i = 0; i < 128; i++) {
    Atomics.store(SoundManager._i32, H + ((i * 16) % slots) * S, SoundManager.STATE_PLAYING);
  }
  const first = SoundManager.getMetrics();
  const checksum = first.activeSlots | 0;
  const out = {
    activeSlots: 0, maxSlots: 0, loadedSounds: 0, dropped: 0, mixGain: 0,
    masterVolume: 0, muted: false, state: 'closed', sampleRate: 0,
    baseLatency: 0, outputLatency: 0, processMs: 0,
  };
  const timed = timeIt('getMetrics', (n) => {
    for (let i = 0; i < n; i++) SoundManager.getMetrics(out);
  }, { iterations: 200, silent: true });
  return row('getMetrics', timed, checksum);
}

function cameraAngle() {
  const data = new Float32Array(Camera.FLOAT_COUNT);
  Camera.initialize(data, 800, 600);
  Camera.setAngle(0.25);
  const checksum = checksumFloats(new Float32Array([data[Camera.IDX_ROTATION]]), 1);
  const timed = timeIt('camera setAngle', (n) => {
    let acc = 0;
    for (let i = 0; i < n; i++) {
      Camera.setAngle((i & 7) * 0.01);
      acc += Camera.rotation;
    }
    return acc;
  }, { iterations: 1500000, silent: true });
  return row('cameraSetAngle', timed, checksum);
}

function channelLookup() {
  SoundManager.configureChannels({ sfx: { volume: 1, pan: 0, maxVoices: 8 } });
  const bus = SoundManager.channel('sfx');
  const checksum = checksumFloats(new Float32Array([bus.volume]), 1);
  const timed = timeIt('channel lookup', (n) => {
    let acc = 0;
    for (let i = 0; i < n; i++) acc += SoundManager.channel('sfx').volume;
    return acc;
  }, { iterations: 1500000, silent: true });
  return row('channelLookup', timed, checksum);
}

function chainMass() {
  const n = 1;
  RigidBody.initializeArrays(new SharedArrayBuffer(RigidBody.getBufferSize(n)), n);
  Collider.initializeArrays(new SharedArrayBuffer(Collider.getBufferSize(n)), n);
  RigidBody.active[0] = 1;
  RigidBody.static[0] = 1;
  Collider.active[0] = 1;
  Collider.shapeType[0] = ShapeType.Chain;
  Collider.width[0] = 10;
  Collider.height[0] = 4;
  RigidBody.syncMassFromCollider(0);
  const checksum = checksumFloats(new Float32Array([
    RigidBody.mass[0],
    RigidBody.invMass[0],
    RigidBody.invInertia[0],
  ]), 3);
  const timed = timeIt('chain syncMass', (iters) => {
    for (let i = 0; i < iters; i++) RigidBody.syncMassFromCollider(0);
  }, { iterations: 400000, silent: true });
  return row('chainMass', timed, checksum);
}

function pictureUpload() {
  class Grid extends SharedResource {}
  const schema = { cells: { type: Uint8Array, length: 64 } };
  Layer.reset();
  SharedResource.resetAll();
  Grid.initialize(new SharedArrayBuffer(SharedResource.getBufferSize(schema)), schema);
  Layer.initializeFromConfig({
    planet: {
      zIndex: 1,
      shader: {
        fragment: '/x.frag',
        worldRect: { width: 32, height: 32 },
        textures: [{ name: 'cells', format: 'r8unorm', size: { width: 8, height: 8 } }],
      },
    },
  }, DEFAULT_LAYERS);
  Layer.resolveSharedTextures();
  const layer = Layer.get('planet');
  const once = () => {
    layer.updateTexture('cells', Grid.cells, 1, 1, 2, 2);
    layer.updateTexture('cells', Grid.cells, 4, 0, 2, 3);
    const rect = Layer.consumeTextureUpload(layer.id, 'cells');
    return rect ? rect.w + rect.h * 16 : -1;
  };
  const checksum = once();
  const timed = timeIt('updateTexture union', (n) => {
    for (let i = 0; i < n; i++) once();
  }, { iterations: 12000, silent: true });
  Layer.reset();
  SharedResource.resetAll();
  return row('pictureUpload', timed, checksum >>> 0);
}

const CASES = [
  ['audioOneShot', audioOneShot],
  ['audioPlay', audioPlay],
  ['chainScratch', chainScratch],
  ['freeSpan', freeSpan],
  ['textureUnion', textureUnion],
  ['locateView', locate],
  ['chainQuery', chainQuery],
  ['setPlane', meshPlane],
  ['getMetrics', metrics],
  ['cameraSetAngle', cameraAngle],
  ['channelLookup', channelLookup],
  ['chainMass', chainMass],
  ['pictureUpload', pictureUpload],
];

function main() {
  const args = parseArgs();
  const cases = {};
  for (const [name, fn] of CASES) {
    cases[name] = fn();
  }
  const payload = { seed: SEED, n: CASES.length, checksum: cases.chainQuery.checksum, cases };
  if (args.output) writeReport(args.output, payload);
  return payload;
}

if (isCli(import.meta.url)) main();

export { main };
