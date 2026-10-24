import test from 'node:test';
import assert from 'node:assert/strict';

import { computeBufferSize, createViews } from '../../src/render/renderQueueLayout.js';
import { computeGpuQueueBufferSize, createGpuQueueViews, gpuQueueCaps } from '../../src/render/gpuQueueLayout.js';
import { createRenderQueueMemory } from '../../src/util/renderQueueMemory.js';
import { GPU_PACK_COLUMNS } from '../../src/render/gpuPackClient.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { DecorationComponent } from '../../src/components/decorationComponent.js';
import { EMIT_MAX_ANIMATIONS, EMIT_MAX_FRAMES, EMIT_PROXY_SHEETS, EMIT_PROXY_STATES, EMIT_TABLE_SLOTS, STAMP_GRID_CELLS, STAMP_LIGHT_DOUBLES, STAMP_TABLE_SLOTS, SWAY_LIST_CAP, SWAY_TABLE_SLOTS } from '../../src/util/wasmMemoryMap.js';

// E-76 W9: the render queue's and the GPU queue's buffers as regions of one shared memory. Every
// view a worker makes from the payload's (buffer, byte) pairs lies in its own region.

const MAX = 5000;

function setup() {
  const caps = gpuQueueCaps(MAX, { enabled: true });
  const queueBytes = computeBufferSize(MAX);
  const gpuBytes = computeGpuQueueBufferSize(caps);
  const m = createRenderQueueMemory(MAX, queueBytes, gpuBytes);
  assert.ok(m, 'the memory is made');
  return { m, caps, queueBytes, gpuBytes };
}

function viewsRange(views) {
  let lo = Infinity;
  let hi = 0;
  for (const v of Object.values(views)) {
    if (!ArrayBuffer.isView(v) || v.byteLength === 0) continue;
    lo = Math.min(lo, v.byteOffset);
    hi = Math.max(hi, v.byteOffset + v.byteLength);
  }
  return [lo, hi];
}

test('the regions lie inside the memory, apart, and nothing starts at 0', () => {
  const { m, queueBytes, gpuBytes } = setup();
  const L = m.layout;
  const spans = [
    ['queueA', L.queueAByte, queueBytes],
    ['queueB', L.queueBByte, queueBytes],
    ['gpuA', L.gpuAByte, gpuBytes],
    ['gpuB', L.gpuBByte, gpuBytes],
    ['indices', L.indexByte, L.indexCap * 4],
    ['tables', L.tableByte, L.tableSlots * GPU_PACK_COLUMNS.length * 4],
    ['results', L.particlesByte, 16],
  ].sort((a, b) => a[1] - b[1]);
  assert.ok(spans[0][1] > 0, 'address 0 is the guard');
  for (let k = 0; k < spans.length; k++) {
    const [name, at, bytes] = spans[k];
    assert.equal(at % 64, 0, `${name} starts on a line`);
    assert.ok(at + bytes <= m.buffer.byteLength, `${name} fits`);
    if (k > 0) assert.ok(at >= spans[k - 1][1] + spans[k - 1][2], `${name} overlaps ${spans[k - 1][0]}`);
  }
  assert.equal(L.indexCap, MAX);
});

test('each queue views its own region, and writing one leaves the others alone', () => {
  const { m, caps, queueBytes, gpuBytes } = setup();
  const L = m.layout;
  const qa = createViews(m.buffer, MAX, L.queueAByte);
  const qb = createViews(m.buffer, MAX, L.queueBByte);
  const ga = createGpuQueueViews(m.buffer, caps, L.gpuAByte);
  const gb = createGpuQueueViews(m.buffer, caps, L.gpuBByte);
  for (const [v, at, bytes, name] of [[qa, L.queueAByte, queueBytes, 'queueA'], [qb, L.queueBByte, queueBytes, 'queueB'], [ga, L.gpuAByte, gpuBytes, 'gpuA'], [gb, L.gpuBByte, gpuBytes, 'gpuB']]) {
    const [lo, hi] = viewsRange(v);
    assert.ok(lo >= at && hi <= at + bytes, `${name}'s views stay in [${at}, ${at + bytes}): ${lo}..${hi}`);
  }
  assert.equal(ga.byteLength, gpuBytes, 'the GPU queue reports its own length');
  qa.x.fill(1);
  qa.tint.fill(0xffffffff);
  ga.sprites.fill(3);
  assert.equal(qb.x.reduce((s, x) => s + x, 0), 0, 'queue B untouched');
  assert.equal(gb.sprites.reduce((s, x) => s + x, 0), 0, 'GPU queue B untouched');
  assert.equal(new Uint8Array(m.buffer, 0, L.queueAByte).reduce((s, x) => s + x, 0), 0, 'nothing before queue A');
});

test('with the emit spec, the component blocks and the emit state are regions apart from the queues', () => {
  const caps = gpuQueueCaps(MAX, { enabled: true });
  const queueBytes = computeBufferSize(MAX);
  const gpuBytes = computeGpuQueueBufferSize(caps);
  const entities = 3000;
  const decorations = 700;
  const spriteBytes = SpriteRenderer.getBufferSize(entities);
  const decorationBytes = DecorationComponent.getBufferSize(decorations);
  const m = createRenderQueueMemory(MAX, queueBytes, gpuBytes, { entities, spriteBytes, casterBytes: 0, decorationBytes });
  assert.ok(m?.layout.emit);
  const L = m.layout;
  const e = L.emit;
  assert.equal(e.entities, entities);
  assert.equal(e.shadowCasterByte, -1, 'no ShadowCaster block');
  const spans = [
    ['queueA', L.queueAByte, queueBytes],
    ['queueB', L.queueBByte, queueBytes],
    ['gpuA', L.gpuAByte, gpuBytes],
    ['gpuB', L.gpuBByte, gpuBytes],
    ['spriteRenderer', e.spriteRendererByte, spriteBytes],
    ['decorations', e.decorationByte, decorationBytes],
    ['frame', e.frameByte, entities * 2],
    ['accum', e.accumByte, entities * 4],
    ['lastTexture', e.lastTextureByte, entities * 2],
    ['collectorType', e.collectorTypeByte, MAX],
    ['collectorIndex', e.collectorIndexByte, MAX * 4],
    ['collectorY', e.collectorYByte, MAX * 4],
    ['proxy', e.proxyByte, EMIT_PROXY_SHEETS * EMIT_PROXY_STATES * 4],
    ['frameCount', e.frameCountByte, EMIT_MAX_ANIMATIONS * 4],
    ['frameStart', e.frameStartByte, EMIT_MAX_ANIMATIONS * 4],
    ['frameWidth', e.frameWidthByte, EMIT_MAX_FRAMES * 2],
    ['frameHeight', e.frameHeightByte, EMIT_MAX_FRAMES * 2],
    ['ends', e.endsByte, MAX * 8],
    ['warns', e.warnsByte, MAX * 8],
    ['foreign', e.foreignByte, MAX * 4],
    ['results', e.resultsByte, 16],
    ['table', e.tableByte, EMIT_TABLE_SLOTS * 4],
    // W4c: the rows each queue buffer last held, both buffers back to back.
    ['persistType', e.persistTypeByte, 2 * MAX],
    ['persistEntity', e.persistEntityByte, 2 * MAX * 4],
    ['persistFrame', e.persistFrameByte, 2 * MAX * 2],
    ['persistAnim', e.persistAnimByte, 2 * MAX * 2],
  ].sort((a, b) => a[1] - b[1]);
  assert.equal(e.persistRows, MAX);
  for (let k = 0; k < spans.length; k++) {
    const [name, at, bytes] = spans[k];
    assert.equal(at % 64, 0, `${name} starts on a line`);
    assert.ok(at + bytes <= m.buffer.byteLength, `${name} fits`);
    if (k > 0) assert.ok(at >= spans[k - 1][1] + spans[k - 1][2], `${name} overlaps ${spans[k - 1][0]}`);
  }
  // A component bound in its block writes only there.
  SpriteRenderer.initializeArrays(m.buffer, entities, e.spriteRendererByte);
  for (const v of Object.values(SpriteRenderer)) if (ArrayBuffer.isView(v)) v.fill(1);
  const all = new Uint8Array(m.buffer);
  let outside = 0;
  for (let i = 0; i < all.length; i++) {
    if (i >= e.spriteRendererByte && i < e.spriteRendererByte + spriteBytes) continue;
    outside += all[i];
  }
  assert.equal(outside, 0, 'nothing written outside the SpriteRenderer block');
});

test('without the emit spec the layout has no emit regions', () => {
  const { m } = setup();
  assert.equal(m.layout.emit, null);
});

test('with the stamp spec, the shadow stamp scratch and light table are regions apart from the rest', () => {
  const caps = gpuQueueCaps(MAX, { enabled: true, shadowsEnabled: true });
  const queueBytes = computeBufferSize(MAX);
  const gpuBytes = computeGpuQueueBufferSize(caps);
  const stamp = { maxSun: MAX, maxPerEntity: 3, maxLights: 20 };
  const m = createRenderQueueMemory(MAX, queueBytes, gpuBytes, null, stamp);
  const L = m.layout;
  const s = L.stamp;
  assert.equal(L.emit, null);
  assert.equal(s.maxSun, MAX);
  assert.equal(s.maxPerEntity, 3);
  assert.equal(s.maxLights, 20);
  const spans = [
    ['queueA', L.queueAByte, queueBytes],
    ['queueB', L.queueBByte, queueBytes],
    ['gpuA', L.gpuAByte, gpuBytes],
    ['gpuB', L.gpuBByte, gpuBytes],
    ['tmpIdx', s.tmpIdxByte, MAX * 4],
    ['dist', s.distByte, MAX * 4],
    ['order', s.orderByte, MAX * 4],
    ['keep', s.keepByte, MAX * 4],
    ['gridCounts', s.gridCountsByte, STAMP_GRID_CELLS * 4],
    ['gridStarts', s.gridStartsByte, (STAMP_GRID_CELLS + 1) * 4],
    ['gridItems', s.gridItemsByte, MAX * 4],
    ['nearDist', s.nearDistByte, MAX * 3 * 4],
    ['nearSlot', s.nearSlotByte, MAX * 3 * 4],
    ['nearCount', s.nearCountByte, MAX],
    ['lights', s.lightsByte, 20 * STAMP_LIGHT_DOUBLES * 8],
    ['table', s.tableByte, STAMP_TABLE_SLOTS * 4],
  ].sort((a, b) => a[1] - b[1]);
  for (let k = 0; k < spans.length; k++) {
    const [name, at, bytes] = spans[k];
    assert.equal(at % 64, 0, `${name} starts on a line`);
    assert.ok(at + bytes <= m.buffer.byteLength, `${name} fits`);
    if (k > 0) assert.ok(at >= spans[k - 1][1] + spans[k - 1][2], `${name} overlaps ${spans[k - 1][0]}`);
  }
});

test("with the sway spec, the particle worker's sway arrays are regions of their own (W22)", () => {
  const caps = gpuQueueCaps(MAX, { enabled: true });
  const queueBytes = computeBufferSize(MAX);
  const gpuBytes = computeGpuQueueBufferSize(caps);
  const d = 1500;
  const k = 100;
  const emit = { entities: 300, spriteBytes: 0, casterBytes: 0, decorationBytes: DecorationComponent.getBufferSize(d) };
  const m = createRenderQueueMemory(MAX, queueBytes, gpuBytes, emit, null, { decorations: d, buckets: k });
  const L = m.layout;
  const w = L.sway;
  assert.equal(w.decorations, d);
  assert.equal(w.buckets, k);
  assert.equal(w.listCap, SWAY_LIST_CAP);
  const spans = [
    ['queueA', L.queueAByte, queueBytes],
    ['queueB', L.queueBByte, queueBytes],
    ['decorations', L.emit.decorationByte, emit.decorationBytes],
    ['snapshot', w.snapshotByte, d * 2],
    ['phaseSin', w.phaseSinByte, d * 4],
    ['phaseCos', w.phaseCosByte, d * 4],
    ['bucketSin', w.bucketSinByte, k * 4],
    ['bucketCos', w.bucketCosByte, k * 4],
    ['bucketOf', w.bucketOfByte, d * 2],
    ['bucketFreq', w.bucketFreqByte, d * 4],
    ['list', w.listByte, SWAY_LIST_CAP * 2],
    ['trig', w.trigByte, d * 4],
    ['trigValue', w.trigValueByte, d * 8],
    ['table', w.tableByte, SWAY_TABLE_SLOTS * 4],
  ].sort((a, b) => a[1] - b[1]);
  for (let i = 0; i < spans.length; i++) {
    const [name, at, bytes] = spans[i];
    assert.equal(at % 64, 0, `${name} starts on a line`);
    assert.ok(at + bytes <= m.buffer.byteLength, `${name} fits`);
    if (i > 0) assert.ok(at >= spans[i - 1][1] + spans[i - 1][2], `${name} overlaps ${spans[i - 1][0]}`);
  }
  assert.equal(createRenderQueueMemory(MAX, queueBytes, gpuBytes, emit).layout.sway, null, 'no spec, no regions');
});
