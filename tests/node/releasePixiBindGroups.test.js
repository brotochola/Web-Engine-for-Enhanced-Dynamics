import test from 'node:test';
import assert from 'node:assert/strict';
import { releasePixiBindGroupsOnResource } from '../../src/workers/releasePixiBindGroups.js';

test('releasePixiBindGroupsOnResource destroys BindGroup contexts on ~change', () => {
  let destroyed = 0;
  const bindGroup = {
    resources: { 0: {} },
    setResource() {},
    destroy() {
      destroyed++;
      this.resources = null;
    },
  };
  const gpuSys = { onSourceUpdate() {} };
  const resource = {
    _events: {
      '~change': [
        { fn: bindGroup.destroy, context: bindGroup },
        { fn: gpuSys.onSourceUpdate, context: gpuSys },
      ],
    },
  };
  assert.equal(releasePixiBindGroupsOnResource(resource), 1);
  assert.equal(destroyed, 1);
  assert.equal(bindGroup.resources, null);
});

test('releasePixiBindGroupsOnResource no-ops without events', () => {
  assert.equal(releasePixiBindGroupsOnResource(null), 0);
  assert.equal(releasePixiBindGroupsOnResource({}), 0);
});
