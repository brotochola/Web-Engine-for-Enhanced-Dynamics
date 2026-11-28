import test from 'node:test';
import assert from 'node:assert/strict';

import { BindGroup as UpstreamBindGroup } from '../../node_modules/pixi.js/lib/rendering/renderers/gpu/shader/BindGroup.mjs';
import { PipelineSystem as UpstreamPipelineSystem } from '../../node_modules/pixi.js/lib/rendering/renderers/gpu/pipeline/PipelineSystem.mjs';
import { GpuMeshAdapter as UpstreamMeshAdapter } from '../../node_modules/pixi.js/lib/scene/mesh/gpu/GpuMeshAdapter.mjs';
import { BindGroup, Geometry, GpuMeshAdapter, PipelineSystem } from '../../src/vendor/pixi.min.js';

// The Pixi bundle's WebGPU draw path without garbage (scripts/buildPixi.mjs, patchPixiDrawGarbage): each patched
// method must do what Pixi's own does, on the same input, in the same order. Pixi 8.23 does the encoder's loops and
// the bind group cache upstream (E-152's other patches went with DX-PIXI823).

const resource = (id, type) => ({ _resourceId: id, _resourceType: type, on() {}, off() {} });

test('BindGroup._touchKeys and _touch stamp what Pixi\'s do: every binding but the samplers', () => {
  const make = (Class) => {
    const group = new Class();
    group.setResource(resource(1, 'textureSource'), 2);
    group.setResource(resource(2, 'textureSampler'), 0);
    group.setResource(resource(3, 'uniformGroup'), 5);
    group.setResource(resource(4, 'textureSampler'), 1);
    return group;
  };
  const ours = make(BindGroup);
  const theirs = make(UpstreamBindGroup);
  assert.deepEqual(ours._touchKeys, [2, 5]);
  assert.deepEqual(ours._touchKeys, theirs._touchKeys);
  assert.equal(ours._touchKeys, ours._touchKeys, 'cached');
  ours.setResource(resource(5, 'buffer'), 3); // a binding more: listed again
  theirs.setResource(resource(5, 'buffer'), 3);
  assert.deepEqual(ours._touchKeys, theirs._touchKeys);
  ours.resources[2] = null; // a destroyed resource (onResourceChange)
  ours._touch(1234.5);
  assert.deepEqual([3, 5].map((k) => ours.resources[k]._gcLastUsed), [1234.5, 1234.5]);
  assert.equal(ours.resources[0]._gcLastUsed, undefined, 'a sampler is not stamped');
});

test('the mesh adapter draws what Pixi\'s draws, through one options object that keeps nothing', () => {
  const draws = [];
  const seen = new Set();
  const renderer = {
    encoder: {
      draw(options) {
        seen.add(options);
        draws.push([options.geometry, options.shader, options.state, options.firstInstance]);
      },
    },
    globalUniforms: { bindGroup: 'global' },
    renderPipes: { uniformBatch: { getUniformBindGroup: () => 'local' } },
  };
  const meshPipe = { renderer, localUniforms: {} };
  const shader = { gpuProgram: { autoAssignGlobalUniforms: true, autoAssignLocalUniforms: true }, groups: {} };
  const meshes = [1, 2].map((k) => ({ _shader: shader, _geometry: `geometry${k}`, state: `state${k}` }));
  const ours = Object.create(GpuMeshAdapter.prototype);
  for (const mesh of meshes) ours.execute(meshPipe, mesh);
  const ourDraws = draws.splice(0);
  assert.equal(seen.size, 1, 'one options object');
  const [options] = seen;
  assert.deepEqual([options.geometry, options.shader, options.state], [null, null, null], 'it holds no mesh after the draw');
  seen.clear();
  const theirs = Object.create(UpstreamMeshAdapter.prototype);
  for (const mesh of meshes) theirs.execute(meshPipe, mesh);
  assert.deepEqual(ourDraws, draws);
  assert.deepEqual(shader.groups, { 0: 'global', 1: 'local' });
});

test('a Geometry keeps its last pipeline, for the cache and key it came from', () => {
  const run = (Class) => {
    let n = 0;
    const system = Object.create(Class.prototype);
    system._pipeCache = new Map();
    system._createPipeline = () => ({ n: n++ });
    const geometry = new Geometry({ attributes: {} });
    geometry._layoutKey = 3;
    const program = { _layoutKey: 7 };
    const states = [{ data: 1, _blendModeId: 0 }, { data: 2, _blendModeId: 1 }];
    const out = [];
    const get = (state) => out.push(system.getPipeline(geometry, program, state, 'triangle-list').n);
    get(states[0]);
    get(states[0]);
    get(states[1]);
    get(states[0]);
    system._pipeCache = new Map(); // another render target's state: its own cache
    get(states[0]);
    get(states[0]);
    return out;
  };
  const ours = run(PipelineSystem);
  assert.deepEqual(ours, [0, 0, 1, 0, 2, 2]);
  assert.deepEqual(ours, run(UpstreamPipelineSystem));
  const geometry = new Geometry({ attributes: {} });
  assert.ok(Number.isNaN(geometry._weedPipeKey) && geometry._weedPipe === null, 'declared in the constructor');
});
