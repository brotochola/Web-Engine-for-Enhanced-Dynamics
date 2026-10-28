import test from 'node:test';
import assert from 'node:assert/strict';

import { generateShaderSyncPolyfill } from '../../node_modules/pixi.js/lib/unsafe-eval/shader/generateShaderSyncPolyfill.mjs';
import { BindGroup as UpstreamBindGroup } from '../../node_modules/pixi.js/lib/rendering/renderers/gpu/shader/BindGroup.mjs';
import { UniformGroup } from '../../node_modules/pixi.js/lib/rendering/renderers/shared/shader/UniformGroup.mjs';
import { BufferResource } from '../../node_modules/pixi.js/lib/rendering/renderers/shared/buffer/BufferResource.mjs';
import { Buffer } from '../../node_modules/pixi.js/lib/rendering/renderers/shared/buffer/Buffer.mjs';
import { TextureSource } from '../../node_modules/pixi.js/lib/rendering/renderers/shared/texture/sources/TextureSource.mjs';
import { syncShader } from '../../scripts/pixi-stubs/shaderSyncPolyfill.mjs';
import { BindGroup as BundledBindGroup } from '../../src/vendor/pixi.min.js';

// The Pixi bundle's WebGL shader sync (scripts/pixi-stubs/shaderSyncPolyfill.mjs, swapped in by scripts/buildPixi.mjs)
// walks a per-shader plan instead of for…in over integer-keyed objects. It must make the calls Pixi's polyfill makes,
// in the same order, and follow a shader whose groups or resource slots change.

/** BindGroup as the bundle patches it: `_weedKeys` counts the resource slots it gains. */
class PatchedBindGroup extends UpstreamBindGroup {
  constructor(resources) {
    super(resources);
    if (this._weedKeys === undefined) this._weedKeys = Object.keys(this.resources).length;
  }

  setResource(resource, index) {
    if (this.resources && !(index in this.resources)) this._weedKeys = (this._weedKeys | 0) + 1;
    super.setResource(resource, index);
  }
}

/** A renderer and shader system that log what the sync does. */
function recorder() {
  const calls = [];
  const renderer = {
    gl: { uniform1i: (location, unit) => calls.push(['uniform1i', location, unit]) },
    texture: { bind: (source, unit) => calls.push(['texture', source.label, unit]) },
    shader: {
      _getProgramData: () => ({ uniformData: { uA: { location: 'locA', value: -1 }, uB: { location: 'locB', value: -1 } } }),
      bindUniformBlock: (resource, name, index) => calls.push(['block', name, index]),
      updateUniformGroup: (group) => calls.push(['uniforms', group.uniformStructures.uValue.value]),
    },
  };
  return { calls, renderer };
}

function shaderOf(groups, bindMap) {
  return { glProgram: {}, groups, _uniformBindMap: bindMap };
}

function run(sync, shader) {
  const { calls, renderer } = recorder();
  sync(renderer, shader, { textureCount: 0, blockIndex: 0 });
  return calls;
}

const texture = (label) => {
  const source = new TextureSource({ width: 1, height: 1 });
  source.label = label;
  return source;
};
const uniforms = (value, ubo = false) => new UniformGroup({ uValue: { value, type: 'f32' } }, { ubo });

test('the plan makes the calls Pixi\'s polyfill makes, in its order', () => {
  const upstream = generateShaderSyncPolyfill();
  const groups = {
    0: new PatchedBindGroup({ a: uniforms(1), b: uniforms(2, true) }),
    1: new PatchedBindGroup({ t: texture('A'), u: texture('B') }),
    100: new PatchedBindGroup({ buf: new BufferResource({ buffer: new Buffer({ data: new Float32Array(4) }) }) }),
  };
  const bindMap = { 0: { 0: 'uOne', 1: 'uTwo' }, 1: { 0: 'uA', 1: 'uB' }, 100: { 0: 'uBuffer' } };
  const shader = shaderOf(groups, bindMap);
  const expected = run(upstream, shader);
  assert.ok(expected.length >= 6, JSON.stringify(expected));
  assert.deepEqual(run(syncShader, shader), expected, 'first bind');
  assert.deepEqual(run(syncShader, shader), expected, 'from the plan');
});

test('a BindGroup swapped into a slot, or a resource slot added, rebuilds the plan', () => {
  const upstream = generateShaderSyncPolyfill();
  const groups = { 0: new PatchedBindGroup({ a: uniforms(1) }), 1: new PatchedBindGroup({ t: texture('A') }) };
  const bindMap = { 0: { 0: 'uOne', 1: 'uTwo' }, 1: { 0: 'uA', 1: 'uB' } };
  const shader = shaderOf(groups, bindMap);
  run(syncShader, shader);
  groups[1] = new PatchedBindGroup({ t: texture('C'), u: texture('D') });
  assert.deepEqual(run(syncShader, shader), run(upstream, shader), 'swapped group');
  groups[0].setResource(uniforms(7), 1);
  assert.deepEqual(run(syncShader, shader), run(upstream, shader), 'new slot');
  groups[0].setResource(uniforms(9), 1);
  assert.deepEqual(run(syncShader, shader), run(upstream, shader), 'a slot replaced');
});

test('the bundled BindGroup counts the resource slots it gains, not the ones it replaces', () => {
  const group = new BundledBindGroup();
  assert.equal(group._weedKeys, 0);
  group.setResource({ on() {}, off() {} }, 0);
  group.setResource({ on() {}, off() {} }, 2);
  assert.equal(group._weedKeys, 2);
  group.setResource({ on() {}, off() {} }, 0);
  assert.equal(group._weedKeys, 2, 'replacing slot 0 adds nothing');
});
