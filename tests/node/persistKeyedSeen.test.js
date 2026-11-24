// E-557: while the persist frames of a keyed queue go on, pre-render neither reads nor writes each sprite's last emitted
// frame, and leaves a buffer's keys alone when none can carry a mark. The same frames with those shortcuts off (the
// kernel's flags masked) give the same hits and the same keys, whatever changes, enters, leaves or Pixi skips; and Pixi's
// statics texture, fed by the marks alone, holds every drawn sprite's statics.
import test from 'node:test';
import assert from 'node:assert/strict';

import { bootEmitWorker, oneAnimationMetadata } from '../helpers/preRenderEmitBoot.mjs';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { Transform } from '../../src/components/transform.js';
import { Layer } from '../../src/core/layer.js';
import { EMIT_MARKS, EMIT_PERSIST_MISS, EMIT_SEEN } from '../../src/workers/preRenderEmitClient.js';
import { PIXI_KEYED_HEADER } from '../../src/util/wasmMemoryMap.js';
import { mulberry32 } from '../bench/microbenchHelpers.mjs';

const N = 48;
const FRAMES = 400;
const KEY_CHANGED = 0x80000000;
const KEY_TEX_ONLY = 0x40000000;
const KEY_MASK = 0x3fffffff;

async function run(seed, shortcuts) {
  Layer.reset();
  Layer.initializeFromConfig({}, { decals: {}, castedShadows: {}, entities: {}, lighting: {} }, true);
  const { worker: w } = await bootEmitWorker(N, {
    keyed: true, maxItems: N, textureMetadata: oneAnimationMetadata(4), config: { debug: { checks: false } },
  });
  // The harness keeps one worker a process: what its last scene left.
  w._keyedComplete.fill(0);
  w._keyedAllMarked = false;
  const rng = mulberry32(seed);
  const S = SpriteRenderer;
  for (let e = 0; e < N; e++) {
    Transform.active[e] = 1;
    Transform.x[e] = 10 * e;
    Transform.rotC[e] = 1;
    S.active[e] = 1;
    S.spritesheetId[e] = 1;
    S.animationState[e] = 0;
    S.animationSpeed[e] = 0.05 + (e % 5) * 0.02;
    S.loop[e] = 1;
    S.isAnimated[e] = 0;
    S.scaleX[e] = 1;
    S.scaleY[e] = 1;
    S.alpha[e] = 1;
  }
  const b = w._emitWasm;
  const real = b.persistFrame;
  let hit = -1;
  let kept = 0;
  b.persistFrame = (table, count, maxItems, flags, dt, band) => {
    const got = real(table, count, maxItems, shortcuts ? flags : (flags & ~EMIT_SEEN) | EMIT_MARKS, dt, band);
    hit = got === EMIT_PERSIST_MISS ? 0 : 1;
    if (hit === 1 && b.results[3] === 0) kept++;
    return got;
  };
  // Pixi: the frame it last drew keyed, and the statics its texture holds by entity.
  let drawn = 0;
  const texAlpha = new Float32Array(N).fill(-1);
  const texTexture = new Int32Array(N).fill(-1);
  const inView = new Uint8Array(N).fill(1);
  let flicker = 0;
  let flickers = 0;
  const log = [];
  for (let f = 0; f < FRAMES; f++) {
    // Quiet stretches, so the hits go on, between busy ones; nothing repeats or moves its frame in half of them.
    const busy = (f >> 4) % 3 === 1;
    if (f % 48 === 32 && f % 96 === 32) {
      for (let e = 0; e < N; e++) {
        if (!S.repeatX[e] && !S.isAnimated[e]) continue;
        S.repeatX[e] = 0;
        S.isAnimated[e] = 0;
        S.renderDirty[e] = 1;
        S.keyedDirty[e] = 1;
      }
    }
    const r = rng();
    if (busy || r < 0.04) {
      const e = (rng() * N) | 0;
      const what = rng();
      if (what < 0.35) {
        S.alpha[e] = Math.fround(rng());
        S.renderDirty[e] = 1;
        S.keyedDirty[e] = 1;
      } else if (what < 0.5) {
        // A statics change with no row of its own (a G-buffer flag).
        S.keyedDirty[e] = 1;
      } else if (what < 0.7) {
        inView[e] ^= 1;
      } else if (what < 0.8) {
        S.isAnimated[e] ^= 1;
        S.renderDirty[e] = 1;
      } else if (what < 0.85) {
        // One sprite gives its row to another: the same count, another sprite.
        const g = (rng() * N) | 0;
        const t = inView[e];
        inView[e] = inView[g];
        inView[g] = t;
      }
    }
    // A sprite in view every other frame: each buffer keeps its rows, and they are not the other's.
    if (flicker > 0) {
      flicker--;
      inView[flickers] ^= 1;
    } else if (rng() < 0.02) {
      flicker = 8;
      flickers = (rng() * N) | 0;
    }
    // In the quiet frames too, a mark with no row of its own to rewrite (the frame stays a persist one).
    if (rng() < 0.08) S.keyedDirty[(rng() * N) | 0] = 1;
    if (busy && rng() < 0.1) {
      const e = (rng() * N) | 0;
      S.repeatX[e] = S.repeatX[e] ? 0 : 2;
      S.renderDirty[e] = 1;
      S.keyedDirty[e] = 1;
    }
    Atomics.store(w._keyedHeader, PIXI_KEYED_HEADER.DRAWN, drawn >>> 0);
    hit = -1;
    w.selectWriteBuffers();
    w._renderableCount = 0;
    w._bindCollectPoses();
    for (let e = 0; e < N; e++) if (inView[e]) w.collectRenderable(0, e);
    const rows = w._renderableCount;
    w.buildRenderQueue(1000 / 60);
    const keys = Array.from(w.renderQueueKey.subarray(0, rows), (k) => k >>> 0);
    log.push(`${f} ${hit} ${keys.join(',')}`);
    const buf = w._queueBuf;
    w.renderQueueFrame++;
    w._queueBuf ^= 1;
    // Pixi draws most frames, if this buffer's marks reach back to the frame its texture holds; now and then none a while.
    const since = Atomics.load(w._keyedHeader, PIXI_KEYED_HEADER.SINCE0 + buf) >>> 0;
    const skips = rng() < 0.15;
    if (skips || since > drawn) continue;
    for (let i = 0; i < rows; i++) {
      const key = keys[i];
      const e = key & KEY_MASK;
      assert.equal(w._renderableIndex[i], e, `frame ${f} row ${i}: its key`);
      if (key >= KEY_CHANGED) {
        texTexture[e] = w.renderQueueTextureId[i];
        if ((key & KEY_TEX_ONLY) === 0) texAlpha[e] = w.renderQueueAlpha[i];
      }
      assert.equal(texAlpha[e], S.alpha[e], `frame ${f}: entity ${e}'s alpha in the texture`);
      assert.equal(texTexture[e], w.renderQueueTextureId[i], `frame ${f}: entity ${e}'s texture in the texture`);
    }
    drawn = w.renderQueueFrame;
  }
  b.persistFrame = real;
  Layer.reset();
  return { log, kept };
}

test('E-557: the keyed persist frames with and without the shortcuts mark the same keys, and Pixi holds every statics', async () => {
  for (const seed of [1, 2, 3, 4]) {
    const fast = await run(seed, true);
    const slow = await run(seed, false);
    assert.ok(fast.kept > 20, `seed ${seed}: ${fast.kept} frames left the keys alone`);
    assert.equal(slow.kept, 0);
    assert.deepEqual(fast.log, slow.log, `seed ${seed}`);
  }
});
