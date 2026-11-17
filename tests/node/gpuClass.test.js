import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GPU_DISCRETE, GPU_INTEGRATED, GPU_SOFTWARE, GPU_TILED, GPU_UNKNOWN, gpuClassOf, gpuVendorOf, webglRendererName,
} from '../../src/render/gpuClass.js';
import { opaquePassOn, opaquePassSuits } from '../../src/render/opaquePass.js';
import { DEBUG_DEFAULTS } from '../../src/util/configDefaults.js';

// E-502: the GPU's class from its renderer name, as browsers give it (ANGLE on Windows and macOS, Mesa on Linux, the
// mobile drivers' own), and E-448's opaque pass kept off where the GPU's class and maker say it costs.

const NAMES = {
  [GPU_INTEGRATED]: [
    'ANGLE (Intel, Intel(R) HD Graphics 620 (0x00005916) Direct3D11 vs_5_0 ps_5_0, D3D11)',
    'ANGLE (Intel, Intel(R) UHD Graphics 630 (0x00003E92) Direct3D11 vs_5_0 ps_5_0, D3D11)',
    'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics (0x00009A49) Direct3D11 vs_5_0 ps_5_0, D3D11)',
    'ANGLE (Intel, Intel(R) Arc(TM) Graphics (0x00007D55) Direct3D11 vs_5_0 ps_5_0, D3D11)',
    'ANGLE (Intel, Intel(R) Arc(TM) 140V GPU (16GB) (0x000064A0) Direct3D11 vs_5_0 ps_5_0, D3D11)',
    'ANGLE (Intel Inc., ANGLE Metal Renderer: Intel(R) Iris(TM) Plus Graphics, Unspecified Version)',
    'Mesa Intel(R) UHD Graphics 620 (KBL GT2)',
    'Intel(R) HD Graphics 400',
    'ANGLE (AMD, AMD Radeon(TM) Graphics (0x00001638) Direct3D11 vs_5_0 ps_5_0, D3D11)',
    'ANGLE (AMD, AMD Radeon(TM) Vega 8 Graphics (0x000015D8) Direct3D11 vs_5_0 ps_5_0, D3D11)',
    'ANGLE (AMD, AMD Radeon 780M Graphics (0x000015BF) Direct3D11 vs_5_0 ps_5_0, D3D11)',
    'ANGLE (AMD, AMD Radeon(TM) R7 Graphics (0x00009874) Direct3D11 vs_5_0 ps_5_0, D3D11)',
    'AMD Custom GPU 0405 (vangogh, LLVM 15.0.7, DRM 3.54, 6.1.52-valve9-1-neptune-61)',
    'ANGLE (Samsung Xclipse 920) on Vulkan 1.1.179',
    'NVIDIA Tegra X1 (nvgpu)/integrated',
  ],
  [GPU_DISCRETE]: [
    'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 (0x00001F91) Direct3D11 vs_5_0 ps_5_0, D3D11)',
    'ANGLE (NVIDIA, NVIDIA GeForce MX110 (0x0000174E) Direct3D11 vs_5_0 ps_5_0, D3D11)',
    'ANGLE (NVIDIA, NVIDIA GeForce RTX 4090 (0x00002684) Direct3D11 vs_5_0 ps_5_0, D3D11)',
    'ANGLE (NVIDIA, NVIDIA Quadro P2000 (0x00001C30) Direct3D11 vs_5_0 ps_5_0, D3D11)',
    'ANGLE (AMD, AMD Radeon RX 6600 XT (0x000073FF) Direct3D11 vs_5_0 ps_5_0, D3D11)',
    'ANGLE (ATI Technologies Inc., ANGLE Metal Renderer: AMD Radeon Pro 5500M, Unspecified Version)',
    'AMD Radeon RX 580 (polaris10, LLVM 15.0.6, DRM 3.49, 6.1.0-13-amd64)',
    'ANGLE (Intel, Intel(R) Arc(TM) A770 Graphics (0x000056A0) Direct3D11 vs_5_0 ps_5_0, D3D11)',
    'ANGLE (Intel, Intel(R) Arc(TM) B580 Graphics (0x0000E20B) Direct3D11 vs_5_0 ps_5_0, D3D11)',
    'NVIDIA GeForce GTX 980, or similar',
  ],
  [GPU_TILED]: [
    'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)',
    'Apple M1',
    'Apple GPU',
    'Mali-G78',
    'ANGLE (ARM, Mali-G710, OpenGL ES 3.2)',
    'Immortalis-G715',
    'Adreno (TM) 650',
    'PowerVR Rogue GE8320',
    'V3D 4.2',
  ],
  [GPU_SOFTWARE]: [
    'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)',
    'Google SwiftShader',
    'llvmpipe (LLVM 15.0.7, 256 bits)',
    'ANGLE (Microsoft, Microsoft Basic Render Driver (0x0000008C) Direct3D11 vs_5_0 ps_5_0, D3D11)',
  ],
  [GPU_UNKNOWN]: ['', 'WebKit WebGL', 'Mozilla'],
};

test('gpuClassOf reads each GPU class from real renderer names', () => {
  for (const [gpuClass, names] of Object.entries(NAMES)) {
    for (const name of names) assert.equal(gpuClassOf(name), gpuClass, name);
  }
});

test('gpuClassOf calls a missing name unknown', () => {
  assert.equal(gpuClassOf(null), GPU_UNKNOWN);
  assert.equal(gpuClassOf(undefined), GPU_UNKNOWN);
});

/** A WebGL context with only what webglRendererName reads. */
function fakeGl(unmasked, plain) {
  const info = { UNMASKED_RENDERER_WEBGL: 0x9246 };
  return {
    RENDERER: 0x1f01,
    getExtension: (name) => (name === 'WEBGL_debug_renderer_info' && unmasked !== null ? info : null),
    getParameter: (p) => (p === info.UNMASKED_RENDERER_WEBGL ? unmasked : p === 0x1f01 ? plain : null),
  };
}

test('webglRendererName takes the unmasked name, else the plain one, else none', () => {
  const hd620 = NAMES[GPU_INTEGRATED][0];
  assert.equal(webglRendererName(fakeGl(hd620, 'WebKit WebGL')), hd620);
  assert.equal(webglRendererName(fakeGl(null, 'Intel(R) HD Graphics 400')), 'Intel(R) HD Graphics 400');
  assert.equal(webglRendererName(fakeGl('', 'Apple GPU')), 'Apple GPU');
  assert.equal(webglRendererName(fakeGl(null, null)), '');
  assert.equal(webglRendererName(null), '');
});

test('gpuVendorOf names the maker in WebGPU\'s spelling', () => {
  const cases = [
    [NAMES[GPU_INTEGRATED][0], 'intel'],
    ['ANGLE (Intel Inc., ANGLE Metal Renderer: Intel(R) Iris(TM) Plus Graphics, Unspecified Version)', 'intel'],
    ['ANGLE (AMD, AMD Radeon(TM) Graphics (0x00001636) Direct3D11 vs_5_0 ps_5_0, D3D11)', 'amd'],
    ['ANGLE (ATI Technologies Inc., ANGLE Metal Renderer: AMD Radeon Pro 5500M, Unspecified Version)', 'amd'],
    ['AMD Custom GPU 0405 (vangogh, LLVM 15.0.7, DRM 3.54, 6.1.52-valve9-1-neptune-61)', 'amd'],
    [NAMES[GPU_DISCRETE][0], 'nvidia'],
    ['NVIDIA Tegra X1 (nvgpu)/integrated', 'nvidia'],
    ['ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)', 'apple'],
    ['ANGLE (ARM, Mali-G710, OpenGL ES 3.2)', 'arm'],
    ['Adreno (TM) 650', 'qualcomm'],
    ['PowerVR Rogue GE8320', 'imagination'],
    ['V3D 4.2', 'broadcom'],
    ['Google SwiftShader', ''],
    ['llvmpipe (LLVM 15.0.7, 256 bits)', ''],
    ['', ''],
  ];
  for (const [name, vendor] of cases) assert.equal(gpuVendorOf(name), vendor, name);
  assert.equal(gpuVendorOf(null), '');
});

/** Whether 'auto' draws the opaque pass on the GPU a renderer name names. */
const autoOn = (name) => opaquePassOn('auto', gpuClassOf(name), gpuVendorOf(name));

test('the opaque pass suits every GPU but Intel\'s integrated ones and tile-based ones', () => {
  for (const [gpuClass, names] of Object.entries(NAMES)) {
    for (const name of names) {
      const off = gpuClass === GPU_TILED || (gpuClass === GPU_INTEGRATED && gpuVendorOf(name) === 'intel');
      assert.equal(opaquePassSuits(gpuClass, gpuVendorOf(name)), !off, name);
    }
  }
  // Measured: the Intel HD 620 draws slower with the pass (R-1277), the GTX 1650 its gate's costs come from and the
  // Ryzen 4800H's Radeon (Vega) faster.
  assert.equal(autoOn(NAMES[GPU_INTEGRATED][0]), false);
  assert.equal(autoOn('ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 (0x00001F99) Direct3D11 vs_5_0 ps_5_0, D3D11)'), true);
  assert.equal(autoOn('ANGLE (AMD, AMD Radeon(TM) Graphics (0x00001636) Direct3D11 vs_5_0 ps_5_0, D3D11)'), true);
  // Intel's Arc cards are discrete and keep it; tile-based GPUs do not.
  assert.equal(autoOn('ANGLE (Intel, Intel(R) Arc(TM) A770 Graphics (0x000056A0) Direct3D11 vs_5_0 ps_5_0, D3D11)'), true);
  assert.equal(autoOn('ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)'), false);
});

test('debug.opaquePass: auto follows the GPU, true and false force it', () => {
  assert.equal(DEBUG_DEFAULTS.opaquePass, 'auto');
  for (const names of Object.values(NAMES)) {
    for (const name of names) {
      const gpuClass = gpuClassOf(name);
      const vendor = gpuVendorOf(name);
      assert.equal(opaquePassOn('auto', gpuClass, vendor), opaquePassSuits(gpuClass, vendor), name);
      assert.equal(opaquePassOn(undefined, gpuClass, vendor), opaquePassSuits(gpuClass, vendor), name);
      assert.equal(opaquePassOn(true, gpuClass, vendor), true, name);
      assert.equal(opaquePassOn(false, gpuClass, vendor), false, name);
    }
  }
});
