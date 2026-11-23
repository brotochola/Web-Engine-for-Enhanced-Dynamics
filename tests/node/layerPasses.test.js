// DX-LAYERPASSES: a layer's look in several passes (shader.passes). The config is checked at load; the metadata carries the
// last pass as the layer's look and the ones before it apart; the renderer draws those in order, each into a target at its
// resolution of the layer's size, and binds each one's input (uTexture: the picture before it; uSource: what the first one
// read) and uTexelSize. The WGSL prelude and program bind uSource after uScene.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Layer } from '../../src/core/layer.js';
import { earlierPassesOf, lookPassesOf } from '../../src/render/lookPassConfig.js';
import { assertLoadedShadersCompatible, resolveAutoRendererBackend } from '../../src/render/rendererBackend.js';
import { lookReads } from '../../src/render/pixi/lookPasses.js';
import { lookGpuProgram } from '../../src/render/webgpu/pixiMeshWgsl.js';
import { buildLookPrelude } from '../../src/render/webgpu/wgslPrelude.js';
import { LAYER_KIND } from '../../src/util/configDefaults.js';

import { loadWorker, quietly } from '../bench/workerHarness.mjs';
import { readEngineShader } from './engineShaderSources.mjs';

const BUILT_IN = { decals: { zIndex: 1 }, castedShadows: { zIndex: 2 }, entities: { zIndex: 3 }, lighting: { zIndex: 4 } };
const GLSL = (body) => 'precision mediump float;\nvarying vec2 vTextureCoord;\nuniform sampler2D uTexture;\n' + body;
const ROWS = GLSL('void main() { gl_FragColor = texture2D(uTexture, vTextureCoord); }\n');
const COLUMNS = GLSL('uniform sampler2D uSource;\nvoid main() { gl_FragColor = texture2D(uTexture, vTextureCoord) + texture2D(uSource, vTextureCoord); }\n');

const load = (layers) => {
  Layer.reset();
  Layer.initializeFromConfig(layers, BUILT_IN);
};
const bloom = (extra = {}, shader = {}) => ({
  zIndex: 3.5,
  shader: { passes: [{ fragment: 'rows' }, { fragment: 'columns' }], uniforms: { uAmount: { value: 0.5, type: 'f32' } }, ...shader },
  ...extra,
});

test('the look\'s passes: a list, one fragment, or none', () => {
  assert.deepEqual(lookPassesOf({ fragment: 'a' }), [{ fragment: 'a' }]);
  assert.deepEqual(lookPassesOf({ passes: [{ fragment: 'a' }, { fragment: 'b' }] }).map((p) => p.fragment), ['a', 'b']);
  assert.equal(lookPassesOf({ uniforms: {} }).length, 0);
  assert.equal(lookPassesOf(null).length, 0);
  assert.equal(earlierPassesOf({ fragment: 'a' }), null);
  assert.equal(earlierPassesOf({ passes: [{ fragment: 'a' }] }), null, 'one pass: nothing before it');
  assert.deepEqual(earlierPassesOf({ passes: [{ fragment: 'a', resolution: 0.5 }, { fragment: 'b' }, { fragment: 'c' }] }), [
    { fragment: 'a', name: null, resolution: 0.5 }, { fragment: 'b', name: null, resolution: 1 },
  ]);
});

test('passes the layer cannot draw are refused at load', () => {
  const refused = (layers, message) => assert.throws(() => load(layers), { message });
  refused({ bloom: bloom({}, { passes: [] }) }, /layer "bloom": shader\.passes is a list of at least one pass/);
  refused({ bloom: bloom({}, { passes: 'rows' }) }, /layer "bloom": shader\.passes is a list of at least one pass/);
  refused({ bloom: bloom({}, { fragment: 'rows' }) }, /shader\.passes and shader\.fragment are both set/);
  refused({ bloom: bloom({}, { passes: [{ fragment: 'rows' }, {}] }) }, /shader\.passes\[1\] has no fragment/);
  refused({ bloom: bloom({}, { passes: [{ fragment: 'rows' }, { fragment: 'columns', resolution: 0.5 }] }) },
    /shader\.passes\[1\]\.resolution: the last pass draws the layer, at the layer's resolution/);
  for (const bad of [0, -1, 2, 'half']) {
    refused({ bloom: bloom({}, { passes: [{ fragment: 'rows', resolution: bad }, { fragment: 'columns' }] }) },
      /shader\.passes\[0\]\.resolution is .*: a share of the layer's size, over 0 and up to 1/);
  }
  for (const kind of [LAYER_KIND.TILEMAP, LAYER_KIND.COVER, LAYER_KIND.STATIC]) {
    refused({ back: bloom({ kind }) }, /layer "back": shader\.passes needs a look over the layer's own picture/);
  }
  refused({ back: bloom({}, { worldRect: { width: 10, height: 10 } }) }, /needs a look over the layer's own picture/);
});

test('the metadata: the last pass is the layer\'s look, the ones before it apart; SCREEN takes passes', () => {
  load({ bloom: bloom(), grade: { kind: LAYER_KIND.SCREEN, zIndex: 100, shader: { passes: [{ fragment: 'a' }, { fragment: 'b' }] } } });
  const meta = Layer._metadata.layers[Layer.get('bloom').id];
  assert.equal(meta.shaderFragment, 'columns');
  assert.deepEqual(meta.shaderEarlier, [{ fragment: 'rows', name: null, resolution: 1 }]);
  assert.equal(meta.hasShader, true);
  assert.ok(meta.uniformMap.uTexelSize, 'the engine gives every look its input\'s texel size');
  const one = Layer._metadata.layers[Layer.get('grade').id];
  assert.equal(one.shaderFragment, 'b');
  load({ plain: { zIndex: 5, shader: { fragment: 'a' } } });
  assert.equal(Layer._metadata.layers[Layer.get('plain').id].shaderEarlier, null);
});

test('every pass\'s shader is checked against the backend, and renderer.backend auto asks each for its WGSL', async () => {
  const layers = { bloom: bloom() };
  const shaderAssets = { rows: '/rows.frag', columns: '/columns.frag' };
  const loaded = { rows: ROWS, columns: COLUMNS };
  assert.doesNotThrow(() => assertLoadedShadersCompatible({ backend: 'webgl', layers, shaderAssets, loadedSources: loaded }));
  assert.throws(() => assertLoadedShadersCompatible({ backend: 'webgl', layers, shaderAssets, loadedSources: { rows: ROWS } }), /columns/);
  const env = { gpu: { requestAdapter: async () => ({}) }, warn: () => {} };
  const half = { rows: { webgl: '/r.frag', webgpu: '/r.wgsl' }, columns: '/columns.frag' };
  assert.equal(await resolveAutoRendererBackend({ layers }, half, env), 'webgl', 'the second pass has no WGSL');
  const both = { ...half, columns: { webgl: '/c.frag', webgpu: '/c.wgsl' } };
  assert.equal(await resolveAutoRendererBackend({ layers }, both, env), 'webgpu');
});

test('the WGSL prelude and program bind uSource after uScene and before the G-buffer', () => {
  const s = buildLookPrelude(null, null, { scene: true, source: true, gbuf: true });
  assert.match(s, /@binding\(3\) var uScene/);
  assert.match(s, /@binding\(4\) var uSource: texture_2d<f32>/);
  assert.match(s, /@binding\(5\) var uGbufFace/);
  assert.match(buildLookPrelude(null, null, { source: true }), /@binding\(3\) var uSource/);
  const GpuProgram = { from: (o) => o };
  const p = lookGpuProgram(GpuProgram, 'fn mainFrag() {}', 'look', 'fn mainVert() {}', { source: true });
  assert.equal(p.layout[2].uSource, 3);
  assert.deepEqual(p.gpuLayout.at(-1).map((e) => e.binding), [0, 1, 2, 3]);
});

test('what a look reads: uSource only with passes, uScene and the G-buffer only on a SCREEN layer', () => {
  assert.deepEqual(lookReads(COLUMNS, false, true), { scene: false, source: true, gbuf: false });
  assert.deepEqual(lookReads(COLUMNS, false, false), { scene: false, source: false, gbuf: false });
  assert.deepEqual(lookReads('uScene uGbufIds uSourceOther', true, true), { scene: true, source: false, gbuf: true });
  assert.deepEqual(lookReads('uScene uGbufIds', false, true), { scene: false, source: false, gbuf: false });
  assert.deepEqual(lookReads(null, true, true), { scene: false, source: false, gbuf: false });
});

/** A Pixi worker with a stand-in renderer: what each submit drew, from what, into what, with which uTexelSize. */
async function pixiWith(layers, sources) {
  load(layers);
  for (const [name, list] of Object.entries(sources)) {
    const meta = Layer._metadata.layers[Layer.get(name).id];
    meta.shaderFragment = list.at(-1);
    for (let i = 0; i < list.length - 1; i++) meta.shaderEarlier[i].fragment = list[i];
  }
  const px = await loadWorker('pixiWorker.js', 'pixiRenderer');
  px.config = { physics: {}, renderer: {}, particle: {} };
  px._useWebGpu = false;
  px._engineShaders = { lookVert: readEngineShader('fullscreenLook.vert.glsl') };
  px.canvasWidth = 800;
  px.canvasHeight = 600;
  px.lookShaders.create = (source, texture, uniformDefs, name, layerName, textures = {}) => ({
    name,
    resources: {
      customUniforms: { uniforms: Object.fromEntries(Object.entries(uniformDefs).map(([k, d]) => [k, d.value])) },
      uTexture: texture,
      ...(textures.source ? { uSource: textures.source } : {}),
      ...(textures.scene ? { uScene: textures.scene } : {}),
    },
  });
  px.customLayers.list = [];
  px.screenLayers.passes = [];
  px.globalEntityCount = 0;
  px.pixiApp = { stage: { addChild() {}, sortChildren() {} }, renderer: { background: { colorRgba: [0, 0, 0, 1] } } };
  const released = [];
  px._releaseTextureBindGroups = (rt) => released.push(rt);
  px._gpuLive = () => true;
  await quietly(() => px.customLayers.initialize({ config: px.config, layerData: Layer.getSerializableData(), customLayerRenderQueues: {} }));
  const draws = [];
  px._submitRender = (what) => {
    const mesh = what.container ?? what;
    const shader = mesh?.shader;
    const tex = shader?.resources?.uTexture ?? null;
    draws.push({
      shader: shader ?? null,
      reads: tex,
      uSource: shader?.resources?.uSource ?? null,
      into: what.target?.source ?? null,
      size: what.target ? [what.target.source.pixelWidth, what.target.source.pixelHeight] : null,
      texel: shader ? Array.from(shader.resources.customUniforms.uniforms.uTexelSize) : null,
    });
  };
  return { px, draws, released };
}

const screenBloom = (shader = {}) => ({
  kind: LAYER_KIND.SCREEN,
  zIndex: 100,
  shader: { passes: [{ fragment: 'rows', resolution: 0.5 }, { fragment: 'columns' }], ...shader },
});

test('a SCREEN layer in two passes: the rows at half size from the frame, the last onto the canvas with uSource', async () => {
  const { px, draws } = await pixiWith({ bloom: screenBloom() }, { bloom: [ROWS, COLUMNS] });
  const cl = px.screenLayers.passes[0];
  assert.equal(cl.earlierPasses.length, 1);
  assert.equal(cl.reads.source, true);
  px.screenLayers.present();
  assert.equal(draws.length, 3, 'the stage, the rows, the last pass');
  const frame = draws[0].into;
  assert.deepEqual([draws[1].reads, draws[1].size], [frame, [400, 300]], 'the rows read the frame and draw at half size');
  assert.equal(draws[2].into, null, 'the canvas');
  assert.equal(draws[2].reads, draws[1].into, 'the last pass reads what the rows drew');
  assert.equal(draws[2].uSource, frame, 'and, as uSource, the frame the first pass read');
  assert.deepEqual(draws[1].texel, [1 / 800, 1 / 600].map(Math.fround));
  assert.deepEqual(draws[2].texel, [1 / 400, 1 / 300].map(Math.fround));
});

test('the canvas resized: the targets are remade at the new size, the old ones let go of first', async () => {
  const { px, draws, released } = await pixiWith({ bloom: screenBloom() }, { bloom: [ROWS, COLUMNS] });
  px.screenLayers.present();
  const old = px.screenLayers.passes[0].earlierPasses[0].target;
  px.canvasWidth = 400;
  px.canvasHeight = 300;
  draws.length = 0;
  px.screenLayers.present();
  assert.ok(released.includes(old), 'its bind groups released before it is destroyed');
  assert.notEqual(px.screenLayers.passes[0].earlierPasses[0].target, old);
  assert.deepEqual(draws[1].size, [200, 150]);
  assert.equal(draws[2].reads, draws[1].into);
  const n = released.length;
  px.screenLayers.present();
  assert.equal(released.length, n, 'kept while the size holds');
});

test('the layer\'s uniforms reach every pass, and each pass has its own store', async () => {
  const { px } = await pixiWith({ bloom: screenBloom({ uniforms: { uAmount: { value: 0.5, type: 'f32' } } }) }, { bloom: [ROWS, COLUMNS] });
  const cl = px.screenLayers.passes[0];
  const earlier = cl.earlierPasses[0];
  assert.notEqual(cl.uniformStore, earlier.uniformStore);
  Layer.get('bloom').setUniform('uAmount', 0.25);
  px.screenLayers.present();
  assert.equal(cl.uniformStore.uAmount, 0.25);
  assert.equal(earlier.uniformStore.uAmount, 0.25);
});

test('a layer with one pass has no earlier ones, and draws as it did', async () => {
  const { px, draws } = await pixiWith({ grade: { kind: LAYER_KIND.SCREEN, zIndex: 100, shader: { fragment: 'rows' } } }, { grade: [ROWS] });
  assert.equal(px.screenLayers.passes[0].earlierPasses, null);
  px.screenLayers.present();
  assert.equal(draws.length, 2);
  assert.equal(draws[1].reads, draws[0].into);
  assert.deepEqual(draws[1].texel, [1 / 800, 1 / 600].map(Math.fround));
});

test('re-initializing the layers destroys the earlier passes of the scene before', async () => {
  const { px, released } = await pixiWith({ bloom: screenBloom() }, { bloom: [ROWS, COLUMNS] });
  px.screenLayers.present();
  const target = px.screenLayers.passes[0].earlierPasses[0].target;
  load({ fx: { zIndex: 5 } });
  await quietly(() => px.customLayers.initialize({ config: px.config, layerData: Layer.getSerializableData(), customLayerRenderQueues: {} }));
  assert.ok(released.includes(target));
});
