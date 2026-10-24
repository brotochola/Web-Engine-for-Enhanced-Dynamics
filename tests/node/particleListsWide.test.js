// E-129: the particle list builds for a pool past 65 535 slots (wasm/particleLists.c's _u32 exports, whose
// lists are u32 [count, index, ...]). On a 70 007-slot pool in a shared memory laid out as the particle memory
// lays it out (the component at byte 0, the lists after it), with full, empty and partial 16-slot blocks and a
// tail of 7, every live slot past 65 535 in some block:
// - build_lists_u32 / build_lists_turned_u32 / build_active_u32 give the JS builds' lists (into Uint32Array
//   lists) and isItOnScreen bytes exactly, under box and turned cameras and with no camera;
// - build_lists_f32x4_u32 / build_lists_turned_f32x4_u32 hold compareListBuilds' tolerance against them (the
//   float32 test's, particleListsF32.test.js);
// - on the first 12 007 slots each u32 export writes the values its 16-bit export writes, flag for flag: the
//   width changes the list type and nothing else.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ParticleComponent } from '../../src/components/particleComponent.js';
import {
  buildActiveAndVisibleListBuffers,
  buildActiveAndVisibleListBuffersTurned,
  buildActiveListBuffers,
} from '../../src/util/particleIntegrate.js';
import { layoutRegions } from '../../src/util/wasmMemoryMap.js';
import { buildActiveParticleListWasm, buildParticleListsWasm } from '../../src/workers/particleListsClient.js';
import { mulberry32 } from '../bench/microbenchHelpers.mjs';
import { caseCamera, compareListBuilds, snapshotLists } from '../bench/particleListsWasmMicrobench.mjs';
import { instantiateKernel } from '../bench/wasmKernelHelpers.mjs';

const N = 70007;
const SMALL = 12007;
const pc = ParticleComponent;
const map = layoutRegions([
  { name: 'component', bytes: pc.getBufferSize(N) },
  { name: 'active32', bytes: (N + 2) * 4 },
  { name: 'visible32', bytes: (N + 2) * 4 },
  { name: 'active16', bytes: (SMALL + 2) * 2 },
  { name: 'visible16', bytes: (SMALL + 2) * 2 },
]);
const memory = new WebAssembly.Memory({ initial: map.pages, maximum: map.pages, shared: true });
pc.initializeArrays(memory.buffer, N);
const R = map.regions;
const active32 = new Uint32Array(memory.buffer, R.active32.byte, N + 2);
const visible32 = new Uint32Array(memory.buffer, R.visible32.byte, N + 2);
const active16 = new Uint16Array(memory.buffer, R.active16.byte, SMALL + 2);
const visible16 = new Uint16Array(memory.buffer, R.visible16.byte, SMALL + 2);
const k = instantiateKernel('particleLists', memory);

/** buildParticleListsWasm's binding for a pair of exports and a pair of list regions. */
function binding(build, buildTurned, buildActive, activeByte, visibleByte) {
  return {
    build: k[build],
    buildTurned: k[buildTurned],
    buildActive: k[buildActive],
    activeByte: pc.active.byteOffset,
    xByte: pc.x.byteOffset,
    yByte: pc.y.byteOffset,
    onScreenByte: pc.isItOnScreen.byteOffset,
    activeListByte: activeByte,
    visibleListByte: visibleByte,
  };
}
const wide = binding('build_lists_u32', 'build_lists_turned_u32', 'build_active_u32', R.active32.byte, R.visible32.byte);
const wideF32 = binding('build_lists_f32x4_u32', 'build_lists_turned_f32x4_u32', 'build_active_u32', R.active32.byte, R.visible32.byte);
const narrow = binding('build_lists', 'build_lists_turned', 'build_active', R.active16.byte, R.visible16.byte);
const narrowF32 = binding('build_lists_f32x4', 'build_lists_turned_f32x4', 'build_active', R.active16.byte, R.visible16.byte);

const CAMERAS = {
  stress: caseCamera(0.3, 0, 0, 0),
  zoomed: caseCamera(1, 2000, 1500, 0),
  turned: caseCamera(0.6, 2000, 1500, 0.785),
  backwards: caseCamera(0.45, 800, 600, -1.1),
};

/** Full, empty and partial blocks; positions over the world and past it, and a few odd values. */
function populate(r) {
  for (let b = 0; b < N; b += 16) {
    const u = r();
    for (let i = b; i < Math.min(b + 16, N); i++) pc.active[i] = u < 0.4 ? 1 : u < 0.6 ? 0 : r() < 0.6 ? 1 : 0;
  }
  for (let i = 0; i < N; i++) {
    const u = r();
    if (u < 0.01) {
      pc.x[i] = [NaN, Infinity, -Infinity, 3e38, -0][Math.floor(r() * 5)];
      pc.y[i] = r() * 3000;
    } else {
      pc.x[i] = r() * 5000 - 500;
      pc.y[i] = r() * 4000 - 500;
    }
  }
}

const localIndices = new Uint32Array(N);
const jsActive = new Uint32Array(N + 1);
const jsVisible = new Uint32Array(N + 1);

function jsBuild(n, cam) {
  pc.isItOnScreen.fill(0);
  const b = cam.bounds;
  if (cam.rotation) {
    buildActiveAndVisibleListBuffersTurned(pc, n, localIndices, jsActive, jsVisible, n, b, cam.rotation, cam.w, cam.h, cam.cull);
  } else {
    buildActiveAndVisibleListBuffers(pc, n, localIndices, jsActive, jsVisible, n, b);
  }
  return snapshotLists(jsActive, jsVisible, pc.isItOnScreen, n);
}

function wasmBuild(b, n, cam, act, vis) {
  pc.isItOnScreen.fill(0);
  buildParticleListsWasm(b, n, cam.bounds, cam.rotation, cam.w, cam.h, cam.cull);
  return snapshotLists(act, vis, pc.isItOnScreen, n);
}

function firstDiff(a, b) {
  if (a.length !== b.length) return `length ${a.length} against ${b.length}`;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return `at ${i}: ${a[i]} against ${b[i]}`;
  return null;
}

function sameBuild(a, b) {
  return firstDiff(a.active, b.active) ?? firstDiff(a.visible, b.visible) ?? firstDiff(a.on, b.on);
}

test('the u32 list builds give the JS lists past 65 535 slots, and the float32 ones its tolerance', () => {
  populate(mulberry32(0x129a));
  let pastU16 = 0;
  for (let i = 65536; i < N; i++) pastU16 += pc.active[i];
  assert.ok(pastU16 > 1000, `${pastU16} live slots past 65 535`);
  for (const [name, cam] of Object.entries(CAMERAS)) {
    const js = jsBuild(N, cam);
    const got = wasmBuild(wide, N, cam, active32, visible32);
    assert.equal(sameBuild(js, got), null, `${name}: build_lists${cam.rotation ? '_turned' : ''}_u32 against JS`);
    assert.ok(js.active[js.active.length - 1] > 65535 && js.visible[0] > 0, `${name}: the lists reach past 65 535`);
    const f32 = wasmBuild(wideF32, N, cam, active32, visible32);
    const stats = { flips: 0, worst: 0 };
    assert.equal(compareListBuilds(js, f32, pc.x, pc.y, cam, stats), null, `${name}: the float32 u32 build`);
  }
  // No camera yet: the active list alone, the visible count 0.
  visible32[0] = 7;
  const count = buildActiveParticleListWasm(wide, N);
  const jsCount = buildActiveListBuffers(N, pc.active, localIndices, jsActive, N);
  assert.equal(count, jsCount);
  assert.equal(firstDiff(active32.subarray(0, 1 + count), jsActive.subarray(0, 1 + jsCount)), null, 'build_active_u32');
  assert.equal(visible32[0], 0, 'build_active_u32 sets the visible count to 0');
});

test('on a pool of 16-bit size each u32 export writes the values of its 16-bit export', () => {
  populate(mulberry32(0x129b));
  for (const [name, cam] of Object.entries(CAMERAS)) {
    for (const [w, n] of [[wide, narrow], [wideF32, narrowF32]]) {
      const a = wasmBuild(n, SMALL, cam, active16, visible16);
      const b = wasmBuild(w, SMALL, cam, active32, visible32);
      assert.equal(sameBuild(a, b), null, `${name}: ${w === wide ? 'double' : 'float32'} builds`);
    }
  }
  const c16 = buildActiveParticleListWasm(narrow, SMALL);
  const c32 = buildActiveParticleListWasm(wide, SMALL);
  assert.equal(c16, c32);
  assert.equal(firstDiff(active16.subarray(0, 1 + c16), active32.subarray(0, 1 + c32)), null, 'build_active');
});
