import test from 'node:test';
import assert from 'node:assert/strict';

import { BindGroupSystem } from '../../node_modules/pixi.js/lib/rendering/renderers/gpu/BindGroupSystem.mjs';
import { BindGroup, TextureSource } from '../../src/vendor/pixi.min.js';
import { pinGpuTexture } from '../../src/render/webgpu/pinGpuTexture.js';

// pinGpuTexture points a TextureSource at a GPUTexture the engine made. A bind group made with the source's old view
// must not be reused after a pin: Pixi 8.23's BindGroupSystem keeps the GPU bind group in its hash and on the BindGroup
// itself (_gpuEntry), under keys made of resource ids that a pin of the same size does not change.

/** A GPUTexture as the engine makes them: its size and a view per createView. */
function gpuTexture(width, height, label) {
  let views = 0;
  return { width, height, label, createView: () => ({ texture: label, view: ++views }) };
}

/** Pixi's WebGPU BindGroupSystem (8.23's, as bundled) whose bind groups record the view each binding had. */
function bindGroupSystem(renderer) {
  const system = new BindGroupSystem(renderer);
  system.contextChange({ device: {} });
  system._createBindGroup = (group) => ({ view: group.resources[0]._gpuData[renderer.uid].textureView });
  return system;
}

test('after a pin, a bind group holding the source is made again with the new view, not taken from the caches', () => {
  const renderer = {
    uid: 7,
    gc: { now: 0, addResourceHash() {}, addCollection() {} },
    texture: { _bindGroupHash: Object.create(null) },
  };
  renderer.bindGroup = bindGroupSystem(renderer);
  const source = new TextureSource({ width: 64, height: 32 });
  pinGpuTexture(renderer, source, gpuTexture(64, 32, 'first'));
  const group = new BindGroup({ 0: source });
  const program = { _layoutKey: 3 };
  const before = renderer.bindGroup.getBindGroup(group, program, 0);
  assert.equal(before.view.texture, 'first');
  assert.equal(renderer.bindGroup.getBindGroup(group, program, 0), before, 'cached while nothing changes');

  pinGpuTexture(renderer, source, gpuTexture(64, 32, 'second')); // the same size: the source's resource id stays
  const after = renderer.bindGroup.getBindGroup(group, program, 0);
  assert.notEqual(after, before);
  assert.equal(after.view.texture, 'second');
  assert.equal(renderer.bindGroup.getBindGroup(group, program, 0), after, 'and cached again');

  pinGpuTexture(renderer, source, gpuTexture(128, 32, 'third')); // a resize: the source's resource id moves too
  assert.equal(renderer.bindGroup.getBindGroup(group, program, 0).view.texture, 'third');
});
