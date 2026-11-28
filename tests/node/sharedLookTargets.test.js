// E-525: the look draws take turns on shared targets (src/render/pixi/lookPasses.js). A sprite or density look layer's
// picture (cl.rt) is shared by the layers of its size, its output (rtOut) stays its own, a MESH layer's picture (a cache) and a
// picture a layer shows (no look) stay their own; the SCREEN passes before the last draw into two targets a size in turn, the
// frame's target being one of them when no pass reads uScene; the earlier passes of a look take slots of their own. No draw
// reads what it draws into. The pictures are byte-identical to one target each (tests/bench/compareCaptures.mjs, both backends).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Layer } from '../../src/core/layer.js';
import { LAYER_KIND, LAYER_SCALE_MODE } from '../../src/util/configDefaults.js';

import { loadWorker, quietly } from '../bench/workerHarness.mjs';
import { readEngineShader } from './engineShaderSources.mjs';

const BUILT_IN = { decals: { zIndex: 1 }, castedShadows: { zIndex: 2 }, entities: { zIndex: 3 }, lighting: { zIndex: 4 } };
const GLSL = (body) => 'precision mediump float;\nvarying vec2 vTextureCoord;\nuniform sampler2D uTexture;\n' + body;
const COPY = GLSL('void main() { gl_FragColor = texture2D(uTexture, vTextureCoord); }\n');
const ADD_SCENE = GLSL('uniform sampler2D uScene;\nvoid main() { gl_FragColor = texture2D(uTexture, vTextureCoord) + texture2D(uScene, vTextureCoord); }\n');
const WITH_SOURCE = GLSL('uniform sampler2D uSource;\nvoid main() { gl_FragColor = texture2D(uTexture, vTextureCoord) + texture2D(uSource, vTextureCoord); }\n');

const screen = (zIndex, shader = { fragment: 'copy' }) => ({ kind: LAYER_KIND.SCREEN, zIndex, shader });

/** A Pixi worker with a stand-in renderer: what each submit drew, from what, into what; which targets were released. */
async function pixiWith(layers, sources) {
  Layer.reset();
  Layer.initializeFromConfig(layers, BUILT_IN);
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
  // The harness hands out one worker for every test: each starts with no shared target held.
  px.lookPasses.shared.length = 0;
  px.globalEntityCount = 0;
  px.pixiApp = { stage: { addChild() {}, sortChildren() {} }, renderer: { background: { colorRgba: [0, 0, 0, 1] } } };
  const released = [];
  px._releaseTextureBindGroups = (rt) => released.push(rt);
  px._gpuLive = () => true;
  await quietly(() => px.customLayers.initialize({ config: px.config, layerData: Layer.getSerializableData(), customLayerRenderQueues: {} }));
  const draws = [];
  px._submitRender = (what) => {
    const shader = (what.container ?? what)?.shader ?? null;
    draws.push({
      name: shader?.name ?? 'stage',
      reads: shader?.resources?.uTexture ?? null,
      uSource: shader?.resources?.uSource ?? null,
      uScene: shader?.resources?.uScene ?? null,
      into: what.target?.source ?? null,
    });
  };
  return { px, draws, released };
}

/** No draw reads (uTexture, uSource, uScene) the target it draws into. */
function assertNoDrawReadsItsTarget(draws) {
  for (const d of draws) {
    if (d.into === null) continue;
    assert.notEqual(d.reads, d.into, `${d.name} reads what it draws into`);
    assert.notEqual(d.uSource, d.into, `${d.name} reads, as uSource, what it draws into`);
    assert.notEqual(d.uScene, d.into, `${d.name} reads, as uScene, what it draws into`);
  }
}

const targetsDrawn = (draws) => new Set(draws.filter((d) => d.into !== null).map((d) => d.into));

test('a shared target: one a size and slot, held by each taker, destroyed when the last one gives it back', async () => {
  const { px, released } = await pixiWith({}, {});
  const pool = px.lookPasses;
  const a = pool.takeTarget(800, 600, 0);
  assert.equal(pool.takeTarget(800, 600, 0), a, 'the same size and slot: the same target');
  const other = pool.takeTarget(800, 600, 1);
  const half = pool.takeTarget(400, 300, 0);
  assert.notEqual(other, a, 'another slot: another target');
  assert.notEqual(half, a, 'another size: another target');
  assert.deepEqual([a.source.pixelWidth, a.source.pixelHeight, half.source.pixelWidth], [800, 600, 400]);
  pool.giveTarget(a);
  assert.equal(released.includes(a), false, 'one holder left');
  pool.giveTarget(a);
  assert.equal(released.includes(a), true, 'the last holder destroys it, its bind groups released first');
  assert.notEqual(pool.takeTarget(800, 600, 0), a, 'taken again: a new one');
});

test('four SCREEN passes that read no uScene: the frame\'s target and one more, in turn', async () => {
  const layers = { a: screen(100), b: screen(101), c: screen(102), d: screen(103) };
  const { px, draws } = await pixiWith(layers, { a: [COPY], b: [COPY], c: [COPY], d: [COPY] });
  assert.equal(px.screenLayers.sceneFree, true);
  px.screenLayers.present();
  assert.deepEqual(draws.map((d) => d.name), ['stage', 'a', 'b', 'c', 'd']);
  const frame = draws[0].into;
  assert.equal(draws[1].reads, frame, 'the first pass reads the frame');
  assert.equal(draws[2].into, frame, 'the second draws into the frame\'s target, read already');
  assert.equal(draws[3].into, draws[1].into, 'the third into the first\'s');
  assert.equal(draws[4].into, null, 'the last onto the canvas');
  for (let i = 2; i < draws.length; i++) assert.equal(draws[i].reads, draws[i - 1].into, 'each reads the one before it');
  assertNoDrawReadsItsTarget(draws);
  assert.equal(targetsDrawn(draws).size, 2, 'two targets where there were four');
});

test('a pass that reads uScene keeps the frame\'s target the stage\'s: two targets for the chain', async () => {
  const layers = { a: screen(100), b: screen(101), c: screen(102), d: screen(103) };
  const { px, draws } = await pixiWith(layers, { a: [COPY], b: [COPY], c: [ADD_SCENE], d: [COPY] });
  assert.equal(px.screenLayers.sceneFree, false);
  px.screenLayers.present();
  const frame = draws[0].into;
  assert.equal(draws[3].uScene, frame, 'uScene is the frame before the first pass');
  for (let i = 1; i < draws.length; i++) assert.notEqual(draws[i].into, frame, 'only the stage draws into the frame\'s target');
  assertNoDrawReadsItsTarget(draws);
  assert.equal(targetsDrawn(draws).size, 3, 'the frame and two in turn');
});

test('a pass hidden or shown: the chain still never reads what it draws into', async () => {
  const layers = { a: screen(100), b: screen(101), c: screen(102), d: screen(103) };
  const { px, draws } = await pixiWith(layers, { a: [COPY], b: [COPY], c: [ADD_SCENE], d: [COPY] });
  px.screenLayers.present();
  const held = px.screenLayers.chainTargets.length;
  for (const hide of ['a', 'b', 'c']) {
    Layer.get(hide).visible = false;
    draws.length = 0;
    px.screenLayers.present();
    assertNoDrawReadsItsTarget(draws);
    Layer.get(hide).visible = true;
  }
  assert.equal(px.screenLayers.chainTargets.length, held, 'no target made for a visibility change');
});

test('a SCREEN layer\'s earlier passes take slots of their own, apart from the chain\'s', async () => {
  const bloom = screen(100, { passes: [{ fragment: 'rows' }, { fragment: 'rows' }, { fragment: 'columns' }] });
  const layers = { bloom, b: screen(101), c: screen(102) };
  const { px, draws } = await pixiWith(layers, { bloom: [COPY, COPY, WITH_SOURCE], b: [COPY], c: [COPY] });
  px.screenLayers.present();
  assert.equal(draws.length, 6, 'the stage, two earlier passes, the bloom, b, c');
  assertNoDrawReadsItsTarget(draws);
  const frame = draws[0].into;
  assert.equal(draws[3].uSource, frame, 'the bloom\'s last pass reads the frame as uSource');
  assert.notEqual(draws[1].into, draws[2].into, 'the earlier passes in turn');
  const chain = new Set(px.screenLayers.chainTargets.map((e) => e.rt.source));
  assert.equal(chain.has(draws[1].into) || chain.has(draws[2].into), false, 'none of them the chain\'s');
  assert.equal(draws[4].into, frame, 'b draws into the frame\'s target: no pass reads uScene');
});

test('a resize: the chain gives back the old size\'s targets, unbound first, and takes the new size\'s', async () => {
  const layers = { a: screen(100), b: screen(101), c: screen(102), d: screen(103) };
  const { px, draws, released } = await pixiWith(layers, { a: [COPY], b: [COPY], c: [ADD_SCENE], d: [COPY] });
  px.screenLayers.present();
  const old = px.screenLayers.chainTargets.map((e) => e.rt);
  assert.equal(old.length, 2);
  px.canvasWidth = 400;
  px.canvasHeight = 300;
  draws.length = 0;
  px.screenLayers.present();
  for (const rt of old) assert.ok(released.includes(rt), 'the old size\'s targets destroyed');
  for (const e of px.screenLayers.chainTargets) assert.deepEqual([e.rt.source.pixelWidth, e.rt.source.pixelHeight], [400, 300]);
  assertNoDrawReadsItsTarget(draws);
  assert.equal(px.lookPasses.shared.length, 2, 'the shared targets are the new size\'s only');
});

test('the scene\'s end gives every shared target back', async () => {
  const bloom = screen(100, { passes: [{ fragment: 'rows' }, { fragment: 'columns' }] });
  const { px } = await pixiWith({ bloom, b: screen(101), c: screen(102) }, { bloom: [COPY, WITH_SOURCE], b: [COPY], c: [COPY] });
  px.screenLayers.present();
  assert.ok(px.lookPasses.shared.length > 0);
  Layer.reset();
  Layer.initializeFromConfig({ fx: { zIndex: 5 } }, BUILT_IN);
  await quietly(() => px.customLayers.initialize({ config: px.config, layerData: Layer.getSerializableData(), customLayerRenderQueues: {} }));
  assert.equal(px.lookPasses.shared.length, 0);
});

/** A custom layer's record, as initialize makes it, with what _ensureDensityRT and resizeRTs read. */
function layerRecord(layerId, extra = {}) {
  return {
    layerId, resolution: 1, scaleMode: LAYER_SCALE_MODE.LINEAR, rt: null, rtShared: false, sharesTargets: true, rtOut: null,
    displaySprite: null, shader: null, earlierPasses: null, batch: null, fillBatch: null, uvFillBatch: null, compute: null,
    shaderBypass: false, ...extra,
  };
}

test('look layers of one size share their picture\'s target and keep their outputs; a MESH layer and a shown picture have their own', async () => {
  const { px, released } = await pixiWith({}, {});
  px._proxyLayers = [];
  const custom = px.customLayers;
  const a = layerRecord(10);
  const b = layerRecord(11);
  const mesh = layerRecord(12, { fillBatch: {}, sharesTargets: false });
  custom._ensureDensityRT(a);
  custom._ensureDensityRT(b);
  custom._ensureDensityRT(mesh);
  assert.equal(a.rt, b.rt, 'one picture target for both');
  assert.deepEqual([a.rtShared, b.rtShared, mesh.rtShared], [true, true, false]);
  assert.notEqual(a.rtOut, b.rtOut, 'each its own output (a frame with no new queue shows it again)');
  assert.notEqual(mesh.rt, a.rt, 'a MESH layer\'s picture is a cache: its own');
  assert.equal(a.displaySprite.texture, a.rtOut);

  // The look swapped for none: the sprite shows the picture, which is then the layer's own.
  const shared = a.rt;
  custom._ensureDensityRT(a, true);
  assert.notEqual(a.rt, shared);
  assert.equal(a.rtShared, false);
  assert.equal(b.rt, shared, 'the other layer keeps the shared one');
  assert.equal(released.includes(shared), false);
  // And a look again: back on the shared one, its own destroyed.
  const own = a.rt;
  custom._ensureDensityRT(a);
  assert.equal(a.rt, shared);
  assert.ok(released.includes(own));

  // A resize: each takes the new size's; the last to give the old one back destroys it.
  px.canvasWidth = 400;
  px.canvasHeight = 300;
  custom.resizeRTs(a, 400, 300);
  assert.equal(released.includes(shared), false, 'b still holds it');
  custom.resizeRTs(b, 400, 300);
  assert.ok(released.includes(shared));
  assert.equal(a.rt, b.rt);
  assert.deepEqual([a.rt.source.pixelWidth, a.rt.source.pixelHeight], [400, 300]);
  custom.resizeRTs(mesh, 400, 300);
  assert.equal(mesh.rtShared, false);
  assert.equal(px.lookPasses.shared.length, 1, 'one shared target, the new size\'s');
});

test('a shared picture is sampled as each layer samples it', async () => {
  const { px } = await pixiWith({}, {});
  const custom = px.customLayers;
  const soft = layerRecord(10);
  const crisp = layerRecord(11, { scaleMode: LAYER_SCALE_MODE.NEAREST });
  custom._ensureDensityRT(soft);
  custom._ensureDensityRT(crisp);
  assert.equal(soft.rt, crisp.rt);
  custom._sharedRtMode(soft);
  assert.equal(soft.rt.source.scaleMode, 'linear');
  custom._sharedRtMode(crisp);
  assert.equal(crisp.rt.source.scaleMode, 'nearest');
  custom._sharedRtMode(soft);
  assert.equal(soft.rt.source.scaleMode, 'linear');
});
