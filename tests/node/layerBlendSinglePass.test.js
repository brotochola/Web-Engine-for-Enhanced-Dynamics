// N-79: a layer drawn in one pass (a sprite layer without a look, a MESH layer's fill, a world-rect mesh) draws with
// its blendMode, unless its config sets shader.containerBlend. Before, those layers took the container blend, 0
// (normal) when the config had no shader, and blendMode did nothing. Through the Pixi worker's real init of the custom
// layers; the layers panel's blend select still changes the blend at run time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Transform } from '../../src/components/transform.js';
import { RigidBody } from '../../src/components/rigidBody.js';
import { Collider } from '../../src/components/collider.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { GameObject } from '../../src/core/gameObject.js';
import { Layer } from '../../src/core/layer.js';
import { Query } from '../../src/core/query.js';
import { BLEND_MODES, LAYER_KIND, WASM_DEFAULTS } from '../../src/util/configDefaults.js';
import { createSceneSharedBuffers } from '../../src/util/sceneSharedBuffers.js';

import { loadWorker, quietly } from '../bench/workerHarness.mjs';

const shaderDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/shaders');
const readShader = (f) => fs.readFileSync(path.join(shaderDir, f), 'utf8');
const GPU_SHADERS = {
  sprite: readShader('instancedSprite.wgsl'),
  spritePose: readShader('instancedSpritePose.wgsl'),
  colliderFill: readShader('colliderFill.wgsl'),
  meshUvFill: readShader('meshUvFill.wgsl'),
};

class Thing extends GameObject {}
Thing.components = [RigidBody, Collider, SpriteRenderer];

const LAYERS = {
  plain: { zIndex: 3, maxItems: 16 },
  glow: { zIndex: 4, maxItems: 16, blendMode: BLEND_MODES.ADD },
  forced: { zIndex: 5, maxItems: 16, blendMode: BLEND_MODES.ADD, shader: { containerBlend: BLEND_MODES.MULTIPLY } },
  meshGlow: { zIndex: 6, kind: LAYER_KIND.MESH, blendMode: BLEND_MODES.SCREEN },
  meshForced: { zIndex: 7, kind: LAYER_KIND.MESH, blendMode: BLEND_MODES.SCREEN, shader: { containerBlend: BLEND_MODES.ADD } },
};

function scene() {
  Query.reset();
  const s = {
    totalEntityCount: 16,
    nextComponentId: 4,
    registeredClasses: [{ class: Thing, count: 16, startIndex: 0, entityType: 0, components: Thing.components }],
    componentPools: {
      Transform: { ComponentClass: Transform },
      RigidBody: { ComponentClass: RigidBody },
      Collider: { ComponentClass: Collider },
      SpriteRenderer: { ComponentClass: SpriteRenderer },
    },
    config: {
      worldWidth: 1000,
      worldHeight: 1000,
      canvasWidth: 800,
      canvasHeight: 600,
      particle: { maxParticles: 0 },
      decoration: { maxDecorations: 0 },
      bullet: { maxBullets: 0 },
      physics: { enabled: false, maxJoints: 0 },
      spatial: { cellSize: 100, maxNeighbors: 8, maxEntitiesPerCell: 64, rowsPerBlock: 2, numberOfSpatialWorkers: 1 },
      lighting: { enabled: false, maxLights: 10, shadowsEnabled: false, maxFlashes: 0, raycasted: false },
      logic: { staggeredUpdates: false },
      debug: { maxDebugDrawEntries: 1 },
      navigation: { enabled: false },
      renderer: { maxVisibleRenderables: 64 },
      preRender: { packGpuSprites: 'pixi', sortSprites: 'none' },
      layers: LAYERS,
      wasm: { ...WASM_DEFAULTS },
    },
    buffers: { componentData: {} },
    views: {},
    camera: { zoom: 1, x: 0, y: 0 },
    inputBufferSize: 1,
    keyMap: {},
    updateKeyboardBuffer() {},
    preInitializeEntityTypeArrays() {},
    constructor: { queries: [] },
  };
  createSceneSharedBuffers(s);
  return s;
}

async function initPixi(s) {
  const px = await loadWorker('pixiWorker.js', 'pixiRenderer');
  px.config = s.config;
  px._useWebGpu = true;
  px._engineShaders = GPU_SHADERS;
  px._customLayerList = [];
  px._customLayers = [];
  px._layerRuntime = {};
  px.globalEntityCount = s.totalEntityCount;
  px.renderQueueEnabled = true;
  px.renderQueueMaxItems = 64;
  px._packGpuSpritesOn = 'pixi';
  px.pixiApp = { stage: { addChild() {}, sortChildren() {} }, renderer: null };
  await quietly(() => px.initializeCustomLayers({
    config: s.config,
    layerData: Layer.getSerializableData(),
    customLayerRenderQueues: s.customLayerRenderQueues,
  }));
  return px;
}

const drawn = (px, name) => {
  const cl = px._customLayers[Layer.get(name).id];
  return (cl.batch || cl.fillBatch).mesh.blendMode;
};

test('a layer drawn in one pass takes its blendMode; shader.containerBlend, when set, wins', async () => {
  const px = await initPixi(scene());
  assert.equal(drawn(px, 'plain'), 'normal');
  assert.equal(drawn(px, 'glow'), 'add', 'a sprite layer with no look');
  assert.equal(drawn(px, 'forced'), 'multiply', 'its containerBlend');
  assert.equal(drawn(px, 'meshGlow'), 'screen', 'a MESH layer with no look');
  assert.equal(drawn(px, 'meshForced'), 'add', 'its containerBlend');
});

test('the layer keeps its blend when the layer refs are built again', async () => {
  const px = await initPixi(scene());
  quietly(() => px.buildLayerRefsMap());
  assert.equal(drawn(px, 'glow'), 'add');
  assert.equal(drawn(px, 'forced'), 'multiply');
  assert.equal(drawn(px, 'meshGlow'), 'screen');
  assert.equal(drawn(px, 'meshForced'), 'add');
});

test('the layers panel still changes the blend at run time', async () => {
  const px = await initPixi(scene());
  quietly(() => px.buildLayerRefsMap());
  px.handleSetLayerProps({ layer: 'glow', blendMode: 'screen' });
  assert.equal(drawn(px, 'glow'), 'screen');
  px.handleSetLayerProps({ layer: 'meshGlow', blendMode: 'add' });
  assert.equal(drawn(px, 'meshGlow'), 'add');
});
