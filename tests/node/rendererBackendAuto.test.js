// DX-BACKENDAUTO: renderer.backend 'auto' is resolved before the workers start. It picks WebGPU where the browser gives an
// adapter and every layer's look shader has a WGSL version, and WebGL otherwise, with one warning that says why. A compute
// layer requires WebGPU, so without it the scene fails naming the layer.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  assertSceneRendererConfig, normalizeRendererBackend, resolveAutoRendererBackend,
} from '../../src/render/rendererBackend.js';

const adapterGpu = { requestAdapter: async () => ({}) };
const noAdapterGpu = { requestAdapter: async () => null };

function env(gpu, sources = {}) {
  const warnings = [];
  return {
    warnings,
    env: { gpu, warn: (m) => warnings.push(m), fetchText: async (path) => sources[path] ?? '' },
  };
}

test("'auto' passes the config's check and stays 'auto' until the scene resolves it", () => {
  assert.equal(normalizeRendererBackend('auto'), 'auto');
  assert.equal(assertSceneRendererConfig({ renderer: { backend: 'auto' }, layers: { fire: { shader: { compute: 'sim' } } } }), 'auto');
});

test('WebGPU where an adapter is given and every look shader has a WGSL version', async () => {
  const { env: e, warnings } = env(adapterGpu);
  const config = { layers: { water: { shader: { fragment: 'waterLook' } }, glow: { shader: { fragment: { webgl: '/a.frag', webgpu: '/a.wgsl' } } } } };
  assert.equal(await resolveAutoRendererBackend(config, { waterLook: { webgl: '/w.frag', webgpu: '/w.wgsl' } }, e), 'webgpu');
  assert.deepEqual(warnings, []);
});

test('WebGL, said once, without WebGPU, without an adapter, or with a GLSL-only look', async () => {
  for (const [gpu, why] of [[undefined, /no WebGPU/], [noAdapterGpu, /no WebGPU adapter/]]) {
    const { env: e, warnings } = env(gpu);
    assert.equal(await resolveAutoRendererBackend({}, {}, e), 'webgl');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], why);
  }
  const { env: e, warnings } = env(adapterGpu);
  const config = { layers: { fog: { shader: { fragment: 'fogLook' } } } };
  assert.equal(await resolveAutoRendererBackend(config, { fogLook: '/fog.frag' }, e), 'webgl');
  assert.match(warnings[0], /layer "fog"'s look shader has no WGSL version/);
});

test('a look path that names no dialect is told by its source', async () => {
  const { env: e } = env(adapterGpu, { '/look': '@fragment fn mainFrag() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }' });
  assert.equal(await resolveAutoRendererBackend({ layers: { a: { shader: { fragment: '/look' } } } }, {}, e), 'webgpu');
  const { env: e2 } = env(adapterGpu, { '/look': 'precision mediump float;\nvoid main() { gl_FragColor = vec4(1.0); }' });
  assert.equal(await resolveAutoRendererBackend({ layers: { a: { shader: { fragment: '/look' } } } }, {}, e2), 'webgl');
});

test('a compute layer without WebGPU fails naming it', async () => {
  const { env: e } = env(undefined);
  const config = { layers: { fire: { shader: { fragment: { webgl: '/f.frag', webgpu: '/f.wgsl' }, compute: 'fireSim' } } } };
  await assert.rejects(resolveAutoRendererBackend(config, {}, e), /Layer "fire" uses a compute shader, which requires WebGPU/);
  const { env: ok } = env(adapterGpu);
  assert.equal(await resolveAutoRendererBackend(config, {}, ok), 'webgpu');
});
