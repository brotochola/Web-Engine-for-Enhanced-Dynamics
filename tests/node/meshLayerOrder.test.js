// N-119: MESH layers draw by zIndex. Every layer numbers its rows' depth from 0 in one depth buffer, so a depth test let
// the late rows of a lower layer beat the first rows of a higher one; rows paint in order with no test at all.
// tests/bench/stressScenes/meshLayerOrderScene.js shows the picture.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ColliderFillBatch } from '../../src/render/colliderFillBatch.js';
import { MeshUvFillBatch } from '../../src/render/meshUvFillBatch.js';
import { readEngineShader } from './engineShaderSources.mjs';

const wgsl = (name) => readEngineShader(`${name}.wgsl`);
const shaders = { colliderFill: wgsl('colliderFill'), meshUvFill: wgsl('meshUvFill') };

for (const [name, Batch] of [['fill', ColliderFillBatch], ['UV', MeshUvFillBatch]]) {
  test(`a MESH layer's ${name} batch neither tests nor writes depth`, () => {
    const { state } = new Batch({ capacity: 4, useWebGpu: true, shaders }).mesh;
    assert.equal(state.depthTest, false);
    assert.equal(state.depthMask, false);
  });
}
