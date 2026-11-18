// OL-7: a lamp's cookie lightens what the casters drew on the shadows' layer inside its pool (N-154: over the sun's
// shadows it changes up to 44 of 255). In a frame with no sun caster and no stamp that layer is empty, and the cookies
// were a pass over the shadows' target that changed no pixel: a flat scene of walls drew one for every casting lamp, each
// frame. On a real pre-render worker's _packGpuShadows: no caster and no stamp packs no cookie; a sun caster does, as
// before. The sun's pack and the stamp are stood in for (they need the render queue and the stamp's wasm regions).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeGpuQueueBufferSize, createGpuQueueViews, gpuQueueCaps } from '../../src/render/gpuQueueLayout.js';
import { loadWorker } from '../bench/workerHarness.mjs';

/** A pre-render worker whose shadows are on, with the sun's pack, the stamp and the cookies' pack counted. */
async function worker({ sunCasters, stamps }) {
  const pre = await loadWorker('preRenderWorker.js', 'preRenderWorker');
  const caps = gpuQueueCaps(64, { enabled: true, shadowsEnabled: true, maxLights: 16, maxShadowCastingLights: 4 });
  const dst = createGpuQueueViews(new SharedArrayBuffer(computeGpuQueueBufferSize(caps)), caps);
  pre.shadowsEnabled = true;
  pre.gpuQueueCaps = caps;
  pre.shadowUpdateInterval = 1;
  pre._wallFansOn = false;
  const calls = { cookies: 0 };
  pre._packGpuSun = () => sunCasters;
  pre._stampAgainstSun = () => stamps;
  pre._packGpuCookies = () => {
    calls.cookies++;
    return 3;
  };
  return { pre, dst, calls };
}

test('OL-7: a frame with no sun caster and no stamp packs no cookie', async () => {
  const { pre, dst, calls } = await worker({ sunCasters: 0, stamps: 0 });
  const res = pre._packGpuShadows(dst, null);
  assert.equal(res.sun, 0);
  assert.equal(res.stamp, 0);
  assert.equal(res.cookie, 0);
  assert.equal(calls.cookies, 0, 'the cookies are not even gathered');
});

test('OL-7: a sun caster on the layer keeps the cookies, with or without a stamp', async () => {
  for (const stamps of [0, 5]) {
    const { pre, dst, calls } = await worker({ sunCasters: 2, stamps });
    // Stamp rows name their lamps; none here, so the own-lamp pass has nothing to drop.
    pre._stampLights = null;
    const res = pre._packGpuShadows(dst, null);
    assert.equal(res.sun, 2);
    assert.equal(res.stamp, stamps);
    assert.equal(res.cookie, 3, `stamps ${stamps}`);
    assert.equal(calls.cookies, 1);
  }
});

test('OL-7: under the old fan pass (debug.lightFans) no cookie is packed, as before', async () => {
  const { pre, dst, calls } = await worker({ sunCasters: 2, stamps: 5 });
  pre._wallFansOn = true;
  const res = pre._packGpuShadows(dst, null);
  assert.equal(res.cookie, 0);
  assert.equal(res.stamp, 0, 'nor a stamp');
  assert.equal(calls.cookies, 0);
});
