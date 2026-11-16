// E-372: a scene with DirectionalSprite keeps the component's block in the render-queue memory, as it keeps
// SpriteRenderer's and ShadowCaster's, so pre-render's keyed caster scan (gpuPack.wasm) reads its columns for the sun's
// frames; the sun frames' region lies beside it. A scene without DirectionalSprite has neither.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createSceneSharedBuffers } from '../../src/util/sceneSharedBuffers.js';
import { DirectionalSprite } from '../../src/components/directionalSprite.js';
import { ShadowCaster } from '../../src/components/shadowCaster.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { keyedSunRegionBytes } from '../../src/render/gpuPackClient.js';

function scene(pools) {
  return {
    totalEntityCount: 10,
    nextComponentId: 3,
    registeredClasses: [
      { class: class TestEntityA {}, startIndex: 0, count: 5 },
      { class: class TestEntityB {}, startIndex: 5, count: 5 },
    ],
    componentPools: pools,
    config: {
      worldWidth: 1024,
      worldHeight: 1024,
      canvasWidth: 800,
      canvasHeight: 600,
      particle: { maxParticles: 10 },
      decoration: { maxDecorations: 10 },
      bullet: { maxBullets: 10 },
      physics: { maxJoints: 10 },
      spatial: {
        cellSize: 128,
        maxNeighbors: 32,
        maxEntitiesPerCell: 64,
        rowsPerBlock: 2,
        numberOfSpatialWorkers: 1,
      },
      lighting: { enabled: true, maxLights: 10, shadowsEnabled: true },
      logic: { staggeredUpdates: false },
      debug: { maxDebugDrawEntries: 1 },
      navigation: { enabled: false },
      renderer: { maxVisibleRenderables: 100 },
      layers: {},
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
}

function clearComponents() {
  for (const C of [DirectionalSprite, ShadowCaster, SpriteRenderer]) C.clearArrays();
}

test('DirectionalSprite\'s block is a region of the render-queue memory, the sun frames\' region beside it', () => {
  const s = scene({
    SpriteRenderer: { ComponentClass: SpriteRenderer },
    ShadowCaster: { ComponentClass: ShadowCaster },
    DirectionalSprite: { ComponentClass: DirectionalSprite },
  });
  try {
    createSceneSharedBuffers(s);
    const rqm = s.renderQueueMemory;
    const at = rqm.layout.emit.directionalSpriteByte;
    assert.ok(at > 0 && at % 64 === 0, `a block of the memory (${at})`);
    assert.equal(s.buffers.componentDataByte.DirectionalSprite, at);
    assert.equal(s.buffers.componentData.DirectionalSprite, rqm.buffer);
    assert.equal(DirectionalSprite.active.buffer, rqm.buffer, 'the columns view the memory');
    assert.equal(DirectionalSprite.active.byteOffset, at);
    assert.equal(DirectionalSprite.active.length, s.totalEntityCount);
    for (const name of ['SpriteRenderer', 'ShadowCaster']) {
      assert.equal(s.buffers.componentData[name], rqm.buffer, `${name} as before`);
    }
    const sun = rqm.layout.keyedSunByte;
    assert.ok(sun >= at + DirectionalSprite.getBufferSize(s.totalEntityCount), `the sun frames' region past it (${sun})`);
    assert.ok(sun + keyedSunRegionBytes() <= rqm.buffer.byteLength);
  } finally {
    clearComponents();
  }
});

test('without DirectionalSprite there is no block of it and no sun frames\' region', () => {
  const s = scene({ SpriteRenderer: { ComponentClass: SpriteRenderer }, ShadowCaster: { ComponentClass: ShadowCaster } });
  try {
    createSceneSharedBuffers(s);
    const rqm = s.renderQueueMemory;
    assert.equal(rqm.layout.emit.directionalSpriteByte, -1);
    assert.equal(rqm.layout.keyedSunByte, -1);
    assert.equal(s.buffers.componentDataByte.DirectionalSprite, undefined);
    assert.equal(s.buffers.componentData.DirectionalSprite, undefined);
  } finally {
    clearComponents();
  }
});
