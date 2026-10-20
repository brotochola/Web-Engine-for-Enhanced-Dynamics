import test from 'node:test';
import assert from 'node:assert/strict';

import { loadWorker } from '../bench/workerHarness.mjs';
import { GPU_CASTER_FLOATS, GPU_SPRITE_FLOATS } from '../../src/render/gpuQueueLayout.js';

// B29 (shadow republish with shadowUpdateInterval > 1). On a skipped shadow
// frame pre-render reported the last pack's counts, but the GPU queue buffer
// alternates every frame: the buffer being published held rows from an older
// pack, or none (interval 2 always packs into the same buffer), so shadows
// drew garbage every other frame. A skipped frame now copies the last pack in.

function buffer() {
  return {
    sun: new Float32Array(8 * GPU_CASTER_FLOATS),
    stamp: new Float32Array(8 * GPU_CASTER_FLOATS),
    stampLightIdx: new Uint16Array(8),
    cookie: new Float32Array(8 * GPU_SPRITE_FLOATS),
  };
}

test('every published shadow buffer holds the rows its counts describe', async () => {
  const pre = await loadWorker('preRenderWorker.js', 'preRenderWorker');
  pre.shadowsEnabled = true;
  pre.gpuQueueCaps = { maxSun: 8, maxStamp: 8, maxCookie: 8 };
  pre.shadowUpdateInterval = 2;
  pre._shadowUpdateTick = 0;
  pre._gpuShadowsFrom = null;
  pre._gpuShadowsResult = null;
  let frame = 0;
  pre._packGpuSun = (dst) => {
    dst.sun.fill(frame + 1, 0, 3 * GPU_CASTER_FLOATS);
    return 3;
  };
  pre._stampAgainstSun = (dst) => {
    dst.stamp.fill(frame + 1.5, 0, 2 * GPU_CASTER_FLOATS);
    dst.stampLightIdx.fill(frame + 7, 0, 2);
    return 2;
  };
  pre._packGpuCookies = (dst) => {
    dst.cookie.fill(frame + 1.25, 0, GPU_SPRITE_FLOATS);
    return 1;
  };

  const bufs = [buffer(), buffer()];
  for (frame = 0; frame < 6; frame++) {
    const dst = bufs[frame & 1];
    const res = pre._packGpuShadows(dst, {});
    const packedFrame = frame - (frame % 2); // interval 2: packs on even ticks
    assert.equal(res.sun, 3);
    assert.equal(dst.sun[0], packedFrame + 1, `frame ${frame}: sun rows`);
    assert.equal(dst.sun[3 * GPU_CASTER_FLOATS - 1], packedFrame + 1);
    assert.equal(dst.stamp[0], packedFrame + 1.5, `frame ${frame}: stamp rows`);
    assert.equal(dst.stampLightIdx[1], packedFrame + 7);
    assert.equal(dst.cookie[0], packedFrame + 1.25, `frame ${frame}: cookie rows`);
  }
});
