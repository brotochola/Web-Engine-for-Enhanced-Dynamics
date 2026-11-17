import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GPU_DISCRETE, GPU_INTEGRATED, GPU_SOFTWARE, GPU_TILED, GPU_UNKNOWN, gpuClassOf, webglRendererName,
} from '../../src/render/gpuClass.js';
import { opaquePassOn, opaquePassSuits } from '../../src/render/opaquePass.js';
import { DEBUG_DEFAULTS } from '../../src/util/configDefaults.js';

// E-502: the GPU's class from its renderer name, as browsers give it (ANGLE on Windows and macOS, Mesa on Linux, the
// mobile drivers' own), and E-448's opaque pass kept off where the class says it costs.

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

test('the opaque pass suits discrete, software and unknown GPUs, not integrated or tile-based ones', () => {
  assert.equal(opaquePassSuits(GPU_DISCRETE), true);
  assert.equal(opaquePassSuits(GPU_SOFTWARE), true);
  assert.equal(opaquePassSuits(GPU_UNKNOWN), true);
  assert.equal(opaquePassSuits(GPU_INTEGRATED), false);
  assert.equal(opaquePassSuits(GPU_TILED), false);
});

test('debug.opaquePass: auto follows the GPU class, true and false force it', () => {
  assert.equal(DEBUG_DEFAULTS.opaquePass, 'auto');
  for (const gpuClass of Object.keys(NAMES)) {
    assert.equal(opaquePassOn('auto', gpuClass), opaquePassSuits(gpuClass), gpuClass);
    assert.equal(opaquePassOn(undefined, gpuClass), opaquePassSuits(gpuClass), gpuClass);
    assert.equal(opaquePassOn(true, gpuClass), true, gpuClass);
    assert.equal(opaquePassOn(false, gpuClass), false, gpuClass);
  }
  // The HD 620 the pass was measured on (R-1277) and the GTX 1650 its gate's costs come from.
  assert.equal(opaquePassOn('auto', gpuClassOf(NAMES[GPU_INTEGRATED][0])), false);
  assert.equal(opaquePassOn('auto', gpuClassOf(NAMES[GPU_DISCRETE][0])), true);
});
