// DX-POST: LAYER_KIND.SCREEN, a look over the whole frame below it. Layer registers it with no render queue and
// refuses a scene that cannot draw as written (no fragment; another layer at or over a SCREEN layer). The Pixi worker
// keeps the passes off the stage, in zIndex order, and presents as before while none is visible. That a copy pass
// leaves the frame exact is tests/bench/screenIdentityCheck.mjs (Chromium, WebGL and WebGPU).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { Layer } from '../../src/core/layer.js';
import { LAYER_KIND, isSkipSubscribeKind } from '../../src/util/configDefaults.js';

import { loadWorker, quietly } from '../bench/workerHarness.mjs';

const BUILT_IN = { decals: { zIndex: 1 }, castedShadows: { zIndex: 2 }, entities: { zIndex: 3 }, lighting: { zIndex: 4 } };
const COPY = 'precision mediump float;\nvarying vec2 vTextureCoord;\nuniform sampler2D uTexture;\nuniform float uAmount;\n' +
  'void main() { gl_FragColor = texture2D(uTexture, vTextureCoord) * (1.0 - uAmount); }\n';
const LOOK_VERT = fs.readFileSync(new URL('../../src/shaders/fullscreenLook.vert.glsl', import.meta.url), 'utf8');

const screen = (zIndex, extra = {}) => ({
  kind: LAYER_KIND.SCREEN,
  zIndex,
  shader: { fragment: 'copy', uniforms: { uAmount: { value: 0.25, type: 'f32' } } },
  ...extra,
});

test('a SCREEN layer has no render queue, takes no entities, and carries its look uniforms', () => {
  Layer.reset();
  Layer.initializeFromConfig({ fx: { zIndex: 5 }, crt: screen(100) }, BUILT_IN);
  const crt = Layer.get('crt');
  const meta = Layer._metadata.layers[crt.id];
  assert.equal(meta.kind, LAYER_KIND.SCREEN);
  assert.equal(meta.hasRenderQueue, false);
  assert.equal(meta.maxItems, 0);
  assert.equal(meta.hasShader, true);
  assert.ok(meta.uniformMap.uAmount, 'its own uniform');
  assert.ok(meta.uniformMap.uTime, 'and the reserved look uniforms');
  assert.equal(isSkipSubscribeKind(LAYER_KIND.SCREEN), true);
});

test('a SCREEN layer without a fragment is refused at load', () => {
  Layer.reset();
  assert.throws(() => Layer.initializeFromConfig({ crt: { kind: LAYER_KIND.SCREEN, zIndex: 100 } }, BUILT_IN), {
    message: 'WeedJS: layer "crt" is LAYER_KIND.SCREEN and has no shader.fragment: a SCREEN layer is a look over the ' +
      'frame below it. Give it shader: { fragment }.',
  });
});

test('a layer at or over the lowest SCREEN layer is refused at load', () => {
  Layer.reset();
  assert.throws(() => Layer.initializeFromConfig({ crt: screen(100), hud: { zIndex: 120 } }, BUILT_IN), {
    message: 'WeedJS: layer "hud" (zIndex 120) is not under the SCREEN layer "crt" (zIndex 100). SCREEN layers draw ' +
      "over every other layer: give \"hud\" a zIndex under 100 (a HUD can live in the page's DOM).",
  });
  Layer.reset();
  assert.throws(() => Layer.initializeFromConfig({ grade: screen(90), crt: screen(100), fx: { zIndex: 95 } }, BUILT_IN), {
    message: /layer "fx" \(zIndex 95\) is not under the SCREEN layer "grade" \(zIndex 90\)/,
  });
  Layer.reset();
  Layer.initializeFromConfig({ grade: screen(90), crt: screen(100), fx: { zIndex: 50 } }, BUILT_IN);
  assert.equal(Layer.count, 7, 'two SCREEN layers over everything else load');
});

async function pixiWith(layers) {
  Layer.reset();
  Layer.initializeFromConfig(layers, BUILT_IN);
  for (const name of Object.keys(layers)) {
    const meta = Layer._metadata.layers[Layer.get(name).id];
    if (meta.kind === LAYER_KIND.SCREEN) meta.shaderFragment = COPY; // as sceneWorkerBootstrap injects the source
  }
  const px = await loadWorker('pixiWorker.js', 'pixiRenderer');
  px.config = { physics: {}, renderer: {}, particle: {} };
  px._useWebGpu = false;
  px._engineShaders = { lookVert: LOOK_VERT };
  // Compiling needs a GPU context (Node has none): the shader as Pixi would hold it, from the same uniform defs.
  px._createLookShader = (source, texture, uniformDefs) => ({
    source,
    resources: {
      customUniforms: { uniforms: Object.fromEntries(Object.entries(uniformDefs).map(([k, d]) => [k, d.value])) },
      uTexture: texture,
    },
  });
  px._customLayerList = [];
  px._screenLayers = [];
  px.globalEntityCount = 0;
  const staged = [];
  px.pixiApp = { stage: { addChild: (c) => staged.push(c), sortChildren() {} }, renderer: null };
  await quietly(() => px.initializeCustomLayers({ config: px.config, layerData: Layer.getSerializableData(), customLayerRenderQueues: {} }));
  return { px, staged };
}

test('the Pixi worker keeps the SCREEN passes off the stage, in zIndex order', async () => {
  const { px, staged } = await pixiWith({ crt: screen(100), grade: screen(90) });
  assert.deepEqual(px._screenLayers.map((cl) => cl.layerName), ['grade', 'crt']);
  assert.equal(staged.length, 0, 'nothing on the stage: the stage is what the passes read');
  const crt = px._screenLayers[1];
  assert.equal(crt.scaleMode, 'linear');
  assert.equal(crt.uniformStore.uAmount, 0.25);
  assert.ok(crt.mesh, 'one full-screen mesh');
});

test('with no SCREEN layer visible, the present is the stage\'s as before', async () => {
  const { px } = await pixiWith({ crt: screen(100) });
  let presented = 0;
  px._pixiPresent = () => presented++;
  px._gpuLive = () => true;
  Layer.get('crt').visible = false;
  px._presentStage();
  assert.equal(presented, 1);
  assert.equal(px._screenSceneRT, null, 'no frame target made');
});

test('re-initializing the layers drops the passes of the scene before', async () => {
  const { px } = await pixiWith({ crt: screen(100) });
  assert.equal(px._screenLayers.length, 1);
  Layer.reset();
  Layer.initializeFromConfig({ fx: { zIndex: 5 } }, BUILT_IN);
  await quietly(() => px.initializeCustomLayers({ config: px.config, layerData: Layer.getSerializableData(), customLayerRenderQueues: {} }));
  assert.equal(px._screenLayers.length, 0);
});

test('a SCREEN pass that names uScene gets the frame before the first pass bound; one that does not, nothing more', async () => {
  const SCENE = COPY.replace('uniform float uAmount;', 'uniform float uAmount;\nuniform sampler2D uScene;');
  const { px } = await pixiWith({ bloom: screen(100), crt: screen(110) });
  const calls = [];
  px._createLookShader = (source, texture, uniformDefs, name, layerName, sceneSource) => {
    calls.push({ layerName, scene: sceneSource !== null && sceneSource !== undefined });
    return { resources: { customUniforms: { uniforms: {} }, uTexture: texture, ...(sceneSource ? { uScene: sceneSource } : {}) } };
  };
  Layer.reset();
  Layer.initializeFromConfig({ bloom: screen(100), crt: screen(110) }, BUILT_IN);
  Layer._metadata.layers[Layer.get('bloom').id].shaderFragment = SCENE;
  Layer._metadata.layers[Layer.get('crt').id].shaderFragment = COPY;
  await quietly(() => px.initializeCustomLayers({ config: px.config, layerData: Layer.getSerializableData(), customLayerRenderQueues: {} }));
  assert.deepEqual(calls, [{ layerName: 'bloom', scene: true }, { layerName: 'crt', scene: false }]);
  assert.deepEqual(px._screenLayers.map((cl) => cl.usesScene), [true, false]);
});
