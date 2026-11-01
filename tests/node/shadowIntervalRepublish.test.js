import test from 'node:test';
import assert from 'node:assert/strict';

import { loadWorker } from '../bench/workerHarness.mjs';
import {
  GPU_CASTER_FLOATS, GPU_KEYED_CASTER_FLOATS, GPU_KEYED_STAMP_FLOATS, GPU_SPRITE_FLOATS,
} from '../../src/render/gpuQueueLayout.js';
import { PIXI_KEYED_HEADER, PIXI_KEYED_HEADER_WORDS } from '../../src/util/wasmMemoryMap.js';

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

// E-191 step 2: keyed caster rows while Pixi's statics are recent (its keyed header's LIVE word within
// KEYED_CASTERS_LAG frames of the one being written), republished with their own strides, and packed again rather
// than republished once that word is stale.
test('keyed caster rows follow the LIVE word, and a skipped frame republishes them only while it holds', async () => {
  const pre = await loadWorker('preRenderWorker.js', 'preRenderWorker');
  const header = new Uint32Array(PIXI_KEYED_HEADER_WORDS);
  pre._keyedFrames = true;
  pre._keyedHeader = header;
  pre._keyedKeyBase = 100;
  pre.renderQueueFrame = 40; // writing frame 41
  const live = (w) => {
    header[PIXI_KEYED_HEADER.LIVE] = w;
    return pre._keyedCastersLive();
  };
  assert.equal(live(0), false, 'no keyed upload yet');
  assert.equal(live(41), true);
  assert.equal(live(40), true, 'Pixi on the frame before');
  assert.equal(live(39), true, 'two behind');
  assert.equal(live(38), false, 'three behind');
  assert.equal(live(42), false, 'a word ahead of the frame is no frame of this run');
  pre._keyedKeyBase = 0;
  assert.equal(live(41), false, 'no entity keys');
  pre._keyedKeyBase = 100;

  pre.shadowsEnabled = true;
  pre.gpuQueueCaps = { maxSun: 8, maxStamp: 8, maxCookie: 8 };
  pre.shadowUpdateInterval = 2;
  pre._shadowUpdateTick = 0;
  pre._gpuShadowsFrom = null;
  pre._gpuShadowsResult = null;
  let packs = 0;
  pre._packGpuSun = (dst) => {
    packs++;
    pre._gpuSunKeyed = true;
    dst.sun.fill(packs, 0, 3 * GPU_KEYED_CASTER_FLOATS);
    return 3;
  };
  pre._stampAgainstSun = (dst) => {
    dst.stamp.fill(packs + 0.5, 0, 2 * GPU_KEYED_STAMP_FLOATS);
    return 2;
  };
  pre._packGpuCookies = () => 0;
  const bufs = [buffer(), buffer()];
  header[PIXI_KEYED_HEADER.LIVE] = 41;
  let res = pre._packGpuShadows(bufs[0], {});
  assert.equal(res.keyed, true);
  res = pre._packGpuShadows(bufs[1], {});
  assert.equal(packs, 1, 'the skipped frame republished');
  assert.equal(res.keyed, true);
  assert.equal(bufs[1].sun[3 * GPU_KEYED_CASTER_FLOATS - 1], 1, 'the keyed sun rows, all of them');
  assert.equal(bufs[1].sun[3 * GPU_KEYED_CASTER_FLOATS], 0, 'and no more');
  assert.equal(bufs[1].stamp[2 * GPU_KEYED_STAMP_FLOATS - 1], 1.5, 'the keyed stamp rows, all of them');
  assert.equal(bufs[1].stamp[2 * GPU_KEYED_STAMP_FLOATS], 0, 'and no more');

  pre._shadowUpdateTick = 1; // the next frame skips
  header[PIXI_KEYED_HEADER.LIVE] = 30; // Pixi stopped taking keyed frames
  res = pre._packGpuShadows(bufs[0], {});
  assert.equal(packs, 2, 'stale statics: packed again, not republished');
});

// E-191 step 2: the sun's keyed rows read the main queue's keys through the GPU pack's view of it; without them every
// frame fell back to the full rows.
test('the GPU pack\'s view of the main queue carries its keys', async () => {
  const pre = await loadWorker('preRenderWorker.js', 'preRenderWorker');
  const key = new Uint32Array(4);
  const q = pre._gpuSoAFromViews({ count: new Int32Array([3]), key, shadowH: new Float32Array(4), type: new Uint8Array(4) });
  assert.equal(q.count, 3);
  assert.equal(q.key, key);
  pre.renderQueueKey = key;
  assert.equal(pre._gpuSoAFromBound().key, key);
});
