import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  normalizeRendererBackend,
  assertSceneRendererConfig,
  assertLookShaderCompatible,
  assertComputeShaderCompatible,
  assertLoadedShadersCompatible,
  resolveShaderPath,
  resolveShaderDialect,
  detectShaderDialectFromPath,
  detectShaderDialectFromSource,
  errorShaderFetchFailed,
  errorCompileFailed,
} from '../../src/render/rendererBackend.js';

const WGSL_LOOK = `@fragment fn mainFrag() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }`;
const GLSL_LOOK = `precision mediump float;\nvoid main() { gl_FragColor = vec4(1.0); }`;

test('normalizeRendererBackend defaults to webgpu', () => {
  assert.equal(normalizeRendererBackend(undefined), 'webgpu');
  assert.equal(normalizeRendererBackend('webgl'), 'webgl');
  assert.equal(normalizeRendererBackend('webgpu'), 'webgpu');
});

test('invalid backend string throws a full-sentence WeedJS error', () => {
  assert.throws(
    () => normalizeRendererBackend('opengl'),
    /WeedJS: config\.renderer\.backend must be "webgl" or "webgpu"\. Got "opengl"/
  );
});

test('webgl plus compute throws before workers', () => {
  assert.throws(
    () =>
      assertSceneRendererConfig({
        renderer: { backend: 'webgl' },
        layers: { fire: { shader: { fragment: 'fireLook', compute: 'fireSim' } } },
      }),
    /WeedJS: Layer "fire" uses a compute shader, which requires WebGPU/
  );
});

test('assertSceneRendererConfig rejects invalid backend and webgl+compute', () => {
  assert.throws(
    () => assertSceneRendererConfig({ renderer: { backend: 'metal' } }),
    /must be "webgl" or "webgpu"/
  );
  assert.throws(
    () =>
      assertSceneRendererConfig({
        renderer: { backend: 'webgl' },
        layers: { fire: { shader: { compute: 'sim' } } },
      }),
    /Layer "fire" uses a compute shader/
  );
  assert.equal(assertSceneRendererConfig({}), 'webgpu');
});

test('look WGSL on webgl throws; GLSL on webgpu throws', () => {
  assert.throws(
    () =>
      assertLookShaderCompatible({
        backend: 'webgl',
        layerName: 'water',
        asset: 'metaball',
        path: '/demos/shaders/metaball.wgsl',
        source: WGSL_LOOK,
      }),
    /look shader "metaball" is WGSL/
  );
  assert.throws(
    () =>
      assertLookShaderCompatible({
        backend: 'webgpu',
        layerName: 'water',
        asset: 'metaball',
        path: '/demos/shaders/metaball.frag',
        source: GLSL_LOOK,
      }),
    /look shader "metaball" is GLSL/
  );
});

test('compute source must be WGSL', () => {
  assert.throws(
    () =>
      assertComputeShaderCompatible({
        layerName: 'fire',
        asset: 'fireFluid',
        path: '/shaders/fireFluid.frag',
        source: GLSL_LOOK,
      }),
    /compute shader "fireFluid" must be WGSL/
  );
});

test('path vs body dialect mismatch throws', () => {
  assert.throws(
    () => resolveShaderDialect('metaball', '/demos/shaders/metaball.frag', WGSL_LOOK),
    /does not match its contents \(file looks like GLSL, source looks like WGSL\)/
  );
});

test('loaded look/compute assets are checked against backend', () => {
  assert.throws(
    () =>
      assertLoadedShadersCompatible({
        backend: 'webgl',
        layers: { water: { shader: { fragment: 'metaball' } } },
        shaderAssets: { metaball: '/demos/shaders/metaball.wgsl' },
        loadedSources: { metaball: WGSL_LOOK },
      }),
    /renderer\.backend is "webgl"/
  );
  assert.throws(
    () =>
      assertLoadedShadersCompatible({
        backend: 'webgpu',
        layers: { fire: { shader: { fragment: 'fireLook', compute: 'fireSim' } } },
        shaderAssets: { fireLook: '/x.wgsl', fireSim: '/x.frag' },
        loadedSources: { fireLook: WGSL_LOOK, fireSim: GLSL_LOOK },
      }),
    /compute shader "fireSim" must be WGSL/
  );
  assert.throws(
    () =>
      assertLoadedShadersCompatible({
        backend: 'webgpu',
        layers: { fire: { shader: { fragment: 'fireLook' } } },
        shaderAssets: {},
        loadedSources: {},
      }),
    /look shader "fireLook" was not loaded/
  );
});

test('resolveShaderPath accepts a string or a webgl/webgpu map', () => {
  const assets = {
    rock: {
      webgl: '/demos/shaders/rockContour.frag',
      webgpu: '/demos/shaders/rockContour.wgsl',
    },
    fire: '/demos/shaders/fire.wgsl',
  };
  assert.equal(resolveShaderPath('rock', assets, 'webgl'), '/demos/shaders/rockContour.frag');
  assert.equal(resolveShaderPath('rock', assets, 'webgpu'), '/demos/shaders/rockContour.wgsl');
  assert.equal(resolveShaderPath('fire', assets, 'webgpu'), '/demos/shaders/fire.wgsl');
  assert.throws(
    () => resolveShaderPath('rock', { rock: { webgl: '/x.frag' } }, 'webgpu'),
    /has no path for renderer\.backend "webgpu"/
  );
});

test('loaded dual-map look uses the backend dialect', () => {
  const assets = {
    rockContour: {
      webgl: '/demos/shaders/rockContour.frag',
      webgpu: '/demos/shaders/rockContour.wgsl',
    },
  };
  assert.equal(
    assertLoadedShadersCompatible({
      backend: 'webgl',
      layers: { terrain: { shader: { fragment: 'rockContour' } } },
      shaderAssets: assets,
      loadedSources: { rockContour: GLSL_LOOK },
    }),
    undefined
  );
  assert.throws(
    () =>
      assertLoadedShadersCompatible({
        backend: 'webgpu',
        layers: { terrain: { shader: { fragment: 'rockContour' } } },
        shaderAssets: { rockContour: { webgl: '/x.frag', webgpu: '/x.frag' } },
        loadedSources: { rockContour: GLSL_LOOK },
      }),
    /look shader "rockContour" is GLSL/
  );
});

test('rockContour assets match backend dialect and the terrain map', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const frag = fs.readFileSync(path.join(here, '../../demos/shaders/rockContour.frag'), 'utf8');
  const wgsl = fs.readFileSync(path.join(here, '../../demos/shaders/rockContour.wgsl'), 'utf8');
  assert.equal(detectShaderDialectFromSource(frag), 'glsl');
  assert.equal(detectShaderDialectFromSource(wgsl), 'wgsl');
  const assets = {
    rockContour: {
      webgl: '/demos/shaders/rockContour.frag',
      webgpu: '/demos/shaders/rockContour.wgsl',
    },
  };
  assert.equal(resolveShaderPath('rockContour', assets, 'webgl'), '/demos/shaders/rockContour.frag');
  assert.equal(resolveShaderPath('rockContour', assets, 'webgpu'), '/demos/shaders/rockContour.wgsl');
  assertLookShaderCompatible({
    backend: 'webgl',
    layerName: 'terrain',
    asset: 'rockContour',
    path: assets.rockContour.webgl,
    source: frag,
  });
  assertLookShaderCompatible({
    backend: 'webgpu',
    layerName: 'terrain',
    asset: 'rockContour',
    path: assets.rockContour.webgpu,
    source: wgsl,
  });
});

test('detect dialect from path and source', () => {
  assert.equal(detectShaderDialectFromPath('/a/b.wgsl'), 'wgsl');
  assert.equal(detectShaderDialectFromPath('/a/b.frag'), 'glsl');
  assert.equal(detectShaderDialectFromSource(WGSL_LOOK), 'wgsl');
  assert.equal(detectShaderDialectFromSource(GLSL_LOOK), 'glsl');
});

test('compile failure message names layer, asset, and backend', () => {
  assert.match(
    errorCompileFailed('look', 'metaball', 'water', 'WebGL', new Error('syntax')).message,
    /WeedJS: Failed to compile look shader "metaball" for layer "water" on WebGL: syntax/
  );
});

test('fetch failure message names the asset and HTTP status', () => {
  assert.match(
    errorShaderFetchFailed('metaball', '/demos/shaders/metaball.frag', 404).message,
    /Failed to load shader asset "metaball" from \/demos\/shaders\/metaball\.frag \(HTTP 404\)/
  );
});
