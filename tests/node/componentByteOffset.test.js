// A component bound at a byte offset (E-112): its block is a region of a larger shared buffer, as the
// render-queue memory will hold SpriteRenderer, ShadowCaster and DecorationComponent. Every view, the
// tail views some components add included, must sit inside [offset, offset + getBufferSize), and the
// binders must pass each component's offset.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ShadowCaster } from '../../src/components/shadowCaster.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { ParticleComponent } from '../../src/components/particleComponent.js';
import { MeshRenderer } from '../../src/components/meshRenderer.js';
import { initializeComponentViews } from '../../src/util/utils.js';
import { coreComponentData, initWorker, loadWorker } from '../bench/workerHarness.mjs';

const N = 1000;
const AT = 192;

/** Every typed-array view a component class holds after binding. */
function views(C) {
  return Object.values(C).filter((v) => ArrayBuffer.isView(v));
}

/** Byte offsets of C's views, bound at `at` in a buffer with room around the block. */
function bindAt(C, at) {
  const bytes = C.getBufferSize(N);
  const buffer = new SharedArrayBuffer(at + bytes + 256);
  C.initializeArrays(buffer, N, at);
  return { buffer, bytes, offsets: new Map(views(C).map((v) => [v, v.byteOffset])) };
}

for (const C of [ShadowCaster, SpriteRenderer, ParticleComponent, MeshRenderer]) {
  test(`${C.name}: bound at a byte offset, every view moves with it and stays in its block`, () => {
    const at0 = bindAt(C, 0);
    const base = [...at0.offsets.values()];
    const atK = bindAt(C, AT);
    const moved = [...atK.offsets.values()];
    assert.equal(moved.length, base.length);
    for (let k = 0; k < base.length; k++) assert.equal(moved[k], base[k] + AT, `view ${k}`);
    assert.equal(C.sharedBufferByte, AT);
    // Writing every view fills only the block; the bytes before and after it stay zero.
    for (const v of views(C)) v.fill(v instanceof Float32Array || v instanceof Float64Array ? 1.5 : 7);
    const all = new Uint8Array(atK.buffer);
    for (let i = 0; i < AT; i++) assert.equal(all[i], 0, `byte ${i} before the block`);
    for (let i = AT + atK.bytes; i < all.length; i++) assert.equal(all[i], 0, `byte ${i} after the block`);
  });
}

test('an offset that is not a multiple of 8 is refused', () => {
  const buffer = new SharedArrayBuffer(ShadowCaster.getBufferSize(N) + 64);
  assert.throws(() => ShadowCaster.initializeArrays(buffer, N, 12), /multiple of 8/);
});

test('initializeComponentViews binds each component at its own offset', () => {
  const buffer = new SharedArrayBuffer(4096 + ShadowCaster.getBufferSize(N));
  const n = initializeComponentViews(new Map([['ShadowCaster', ShadowCaster]]), { ShadowCaster: buffer }, { ShadowCaster: { count: N } }, N, { ShadowCaster: 4096 });
  assert.equal(n, 1);
  assert.equal(ShadowCaster.active.buffer, buffer);
  assert.equal(ShadowCaster.active.byteOffset, 4096);
});

test('a worker binds the core and optional components at the offsets in its payload', async () => {
  const buffers = { componentData: coreComponentData(N), componentDataByte: {} };
  const sr = new SharedArrayBuffer(512 + SpriteRenderer.getBufferSize(N));
  const sc = new SharedArrayBuffer(1024 + ShadowCaster.getBufferSize(N));
  buffers.componentData.SpriteRenderer = sr;
  buffers.componentData.ShadowCaster = sc;
  buffers.componentDataByte.SpriteRenderer = 512;
  buffers.componentDataByte.ShadowCaster = 1024;
  // Unbound first, so the worker's own binding is what the asserts read.
  SpriteRenderer.clearArrays();
  ShadowCaster.clearArrays();
  const worker = await loadWorker('preRenderWorker.js', 'preRenderWorker');
  await initWorker(worker, { config: { worldWidth: 1000, worldHeight: 1000 }, globalEntityCount: N, buffers });
  assert.equal(SpriteRenderer.active.buffer, sr);
  assert.equal(SpriteRenderer.active.byteOffset, 512);
  assert.ok(SpriteRenderer.zIndexUsers() === 0);
  assert.equal(ShadowCaster.active.buffer, sc);
  assert.equal(ShadowCaster.active.byteOffset, 1024);
});
