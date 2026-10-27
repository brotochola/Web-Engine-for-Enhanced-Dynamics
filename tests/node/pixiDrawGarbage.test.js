import test from 'node:test';
import assert from 'node:assert/strict';

import { BindGroup as UpstreamBindGroup } from '../../node_modules/pixi.js/lib/rendering/renderers/gpu/shader/BindGroup.mjs';
import { GpuEncoderSystem as UpstreamEncoder } from '../../node_modules/pixi.js/lib/rendering/renderers/gpu/GpuEncoderSystem.mjs';
import { BindGroupSystem as UpstreamBindGroupSystem } from '../../node_modules/pixi.js/lib/rendering/renderers/gpu/BindGroupSystem.mjs';
import { PipelineSystem as UpstreamPipelineSystem } from '../../node_modules/pixi.js/lib/rendering/renderers/gpu/pipeline/PipelineSystem.mjs';
import { GpuMeshAdapter as UpstreamMeshAdapter } from '../../node_modules/pixi.js/lib/scene/mesh/gpu/GpuMeshAdapter.mjs';
import {
  BindGroup,
  BindGroupSystem,
  Geometry,
  GpuEncoderSystem,
  GpuMeshAdapter,
  PipelineSystem,
} from '../../src/vendor/pixi.min.js';

// The Pixi bundle's WebGPU draw path without garbage (scripts/buildPixi.mjs, patchPixiDrawGarbage): each patched
// method must do what Pixi's own does, on the same input, in the same order.

const resource = (id, uniforms = false) => ({ _resourceId: id, isUniformGroup: uniforms, name: `r${id}` });

/** A bundled BindGroup with resources set at `order`'s indices, in that order. */
function groupAt(order, ids, Class = BindGroup) {
  const group = new Class({});
  order.forEach((index, k) => group.setResource(resource(ids[k], ids[k] % 2 === 0), index));
  return group;
}

test('a BindGroup keeps its keys in for…in order, and its key is the one Pixi builds', () => {
  for (const order of [[0, 1, 2], [2, 0, 1], [5, 3, 9, 0], [1]]) {
    const ids = order.map((_, k) => 10 + k);
    const ours = groupAt(order, ids);
    const theirs = groupAt(order, ids, UpstreamBindGroup);
    assert.deepEqual(ours._weedKeyList, Object.keys(theirs.resources).map(Number), `keys of ${order}`);
    assert.equal(ours._key, theirs._key, `key of ${order}`);
    ours.setResource(resource(99), order[0]); // a replaced resource: no new key
    theirs.setResource(resource(99), order[0]);
    assert.equal(ours._weedKeyList.length, order.length);
    assert.equal(ours._key, theirs._key, 'after a replace');
  }
  const built = new BindGroup({ a: resource(1), b: resource(2) });
  assert.deepEqual(built._weedKeyList, [0, 1], 'the constructor numbers its resources from 0, as Pixi does');
});

test('BindGroup._touch marks every resource it holds, as Pixi\'s does', () => {
  const ours = groupAt([3, 0, 1], [1, 2, 3]);
  ours.resources[0] = null; // a destroyed resource (onResourceChange)
  ours._touch(1234.5, 7);
  for (const index of [3, 1]) {
    assert.equal(ours.resources[index]._gcLastUsed, 1234.5);
    assert.equal(ours.resources[index]._touched, 7);
  }
});

/** An encoder of `Class` that logs the bind groups it sets and the uniform groups it syncs. */
function encoderLog(Class) {
  const calls = [];
  const encoder = Object.create(Class.prototype);
  encoder._renderer = { ubo: { updateUniformGroup: (group) => calls.push(['sync', group.name]) } };
  encoder.setBindGroup = (index, group) => calls.push(['bind', Number(index), group._key]);
  encoder._setVertexBuffer = (slot, buffer) => calls.push(['vertex', slot, buffer]);
  encoder._setIndexBuffer = (buffer) => calls.push(['index', buffer]);
  return { encoder, calls };
}

test('the encoder sets and syncs the bind groups Pixi\'s does, in its order', () => {
  const groups = { 0: groupAt([0], [2]), 1: groupAt([1, 0], [4, 5]), 2: groupAt([2, 0, 1], [6, 7, 8]), 3: groupAt([0], [10]) };
  groups[2].resources[1] = null;
  const shader = { gpuProgram: { layout: { 0: {}, 2: {}, 3: {} } }, groups };
  for (const skipSync of [false, true]) {
    const ours = encoderLog(GpuEncoderSystem);
    const theirs = encoderLog(UpstreamEncoder);
    ours.encoder._setShaderBindGroups(shader, skipSync);
    UpstreamEncoder.prototype._setShaderBindGroups.call(theirs.encoder, shader, skipSync);
    // Groups 0, 2 and 3 are in the layout; each holds one uniform group (even ids), group 2 a destroyed slot too.
    assert.equal(theirs.calls.length, skipSync ? 3 : 6);
    assert.deepEqual(ours.calls, theirs.calls, `skipSync ${skipSync}`);
  }
});

test('the encoder binds the vertex buffers Pixi\'s does, a layout\'s gaps included', () => {
  const buffers = ['b0', 'b1', 'b2', 'b3'];
  const names = Object.create(null);
  names[0] = 'aPosition';
  names[2] = 'aInstance'; // b1 has no attribute the program reads: no layout, no key
  const geometry = {
    buffers,
    attributes: { aPosition: { buffer: 'b0' }, aInstance: { buffer: 'b2' } },
    indexBuffer: 'ib',
  };
  const ours = encoderLog(GpuEncoderSystem);
  const theirs = encoderLog(UpstreamEncoder);
  for (const log of [ours, theirs]) log.encoder._renderer.pipeline = { getBufferNamesToBind: () => names };
  ours.encoder.setGeometry(geometry, {});
  UpstreamEncoder.prototype.setGeometry.call(theirs.encoder, geometry, {});
  assert.deepEqual(ours.calls, [['vertex', 0, 'b0'], ['vertex', 2, 'b2'], ['index', 'ib']]);
  assert.deepEqual(ours.calls, theirs.calls);
});

test('a BindGroup keeps its GPU bind group per layout, for its key, for one system', () => {
  const made = [];
  const system = (Class) => {
    const s = new Class({});
    s._createBindGroup = (key) => {
      const gpu = { key, n: made.length };
      made.push(key);
      s._hash[key] = gpu;
      return gpu;
    };
    return s;
  };
  const ours = system(BindGroupSystem);
  const theirs = system(UpstreamBindGroupSystem);
  const group = groupAt([0, 1], [3, 4]);
  const a = { _layoutKey: 5 };
  const b = { _layoutKey: 6 };
  const steps = [[a, 0], [a, 0], [b, 0], [a, 0], [a, 1], [b, 0]];
  const run = (s) => steps.map(([program, index]) => s.getBindGroup(group, program, index).key);
  made.length = 0;
  const theirKeys = run(theirs);
  const theirMade = made.slice();
  made.length = 0;
  assert.deepEqual(run(ours), theirKeys, 'the same GPU bind group for every call');
  assert.deepEqual(made, theirMade, 'each made once');
  group.setResource(resource(30), 1); // a new key: the cache follows it
  made.length = 0;
  assert.equal(ours.getBindGroup(group, a, 0).key, `${group._key}:${(5 << 4) | 0}`);
  assert.equal(made.length, 1);
  const other = system(BindGroupSystem); // another renderer's system has its own GPU objects
  made.length = 0;
  assert.notEqual(other.getBindGroup(group, a, 0), ours.getBindGroup(group, a, 0));
  assert.equal(made.length, 1);
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
