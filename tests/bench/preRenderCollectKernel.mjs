/**
 * The collect kernel screen (E-76 W4b, wasm/test/preRenderCollect.c), shared by its test and its bench.
 *
 * `collectMemory` lays every column the sprite collect reads and writes in one shared WebAssembly.Memory and
 * binds them where the shipped PreRenderWorker.collectVisibleEntities reads them (Transform, SpriteRenderer,
 * Collider, the worker's main collector), so the JS and the kernel walk the same bytes. `collectWithKernel` is
 * what the worker would do with the kernel: the collect's preamble as the JS has it, one call, and for each
 * sprite the kernel hands back (a layer mask) collectRenderable in JS before the next call.
 */
import { Transform } from '../../src/components/transform.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { Collider } from '../../src/components/collider.js';
import { Query } from '../../src/core/query.js';
import { instantiateKernel } from './wasmKernelHelpers.mjs';

/** wasm/test/preRenderCollect.c's table slots. */
export const SLOT = Object.freeze({
  L_LIST: 0, L_LIST_U32: 1, T_ACTIVE: 2, T_X: 3, T_Y: 4, T_ROT_C: 5, T_ROT_S: 6,
  S_ACTIVE: 7, S_VISIBLE: 8, S_HALF_W: 9, S_HALF_H: 10, S_SHEET: 11, S_MASK: 12, C_VISUAL_RANGE: 13,
  O_Y: 14, O_TYPE: 15, O_INDEX: 16, O_X: 17, O_PY: 18, O_ROT_C: 19, O_ROT_S: 20, R_RESULTS: 21,
  COUNT: 22,
});

/**
 * One memory with every collect column for `n` entities and a `maxItems` collector, bound on the components
 * and on `pre`. `mask`: SpriteRenderer.layerMask exists; `visualRange`: Collider.visualRange exists.
 */
export function collectMemory(pre, n, maxItems, { mask = true, visualRange = true } = {}) {
  const parts = [
    ['tActive', Uint8Array, n], ['x', Float32Array, n], ['y', Float32Array, n],
    ['rotC', Float32Array, n], ['rotS', Float32Array, n],
    ['sActive', Uint8Array, n], ['sVisible', Uint8Array, n], ['halfW', Float32Array, n], ['halfH', Float32Array, n],
    ['sheet', Uint8Array, n], ['mask', Uint16Array, mask ? n : 0], ['visualRange', Float32Array, visualRange ? n : 0],
    ['anchorX', Float32Array, n], ['anchorY', Float32Array, n],
    ['list', Uint32Array, n],
    ['oY', Float32Array, maxItems], ['oType', Uint8Array, maxItems], ['oIndex', Int32Array, maxItems],
    ['oX', Float32Array, maxItems], ['oPy', Float32Array, maxItems], ['oRc', Float32Array, maxItems], ['oRs', Float32Array, maxItems],
    ['results', Int32Array, 4], ['table', Uint32Array, SLOT.COUNT],
  ];
  let top = 64;
  const offsets = {};
  for (const [name, Ctor, len] of parts) {
    top = (top + 63) & ~63;
    offsets[name] = len > 0 ? top : 0;
    top += len * Ctor.BYTES_PER_ELEMENT;
  }
  const pages = Math.ceil(top / 65536) + 1;
  const memory = new WebAssembly.Memory({ initial: pages, maximum: pages, shared: true });
  const v = {};
  for (const [name, Ctor, len] of parts) v[name] = len > 0 ? new Ctor(memory.buffer, offsets[name], len) : null;

  Transform.active = v.tActive;
  Transform.x = v.x;
  Transform.y = v.y;
  Transform.rotC = v.rotC;
  Transform.rotS = v.rotS;
  SpriteRenderer.active = v.sActive;
  SpriteRenderer.renderVisible = v.sVisible;
  SpriteRenderer.boundsHalfW = v.halfW;
  SpriteRenderer.boundsHalfH = v.halfH;
  SpriteRenderer.spritesheetId = v.sheet;
  SpriteRenderer.layerMask = v.mask;
  SpriteRenderer.anchorX = v.anchorX;
  SpriteRenderer.anchorY = v.anchorY;
  Collider.visualRange = v.visualRange;
  pre._renderableY = v.oY;
  pre._renderableType = v.oType;
  pre._renderableIndex = v.oIndex;
  pre._collectPx = v.oX;
  pre._collectPy = v.oPy;
  pre._collectRotC = v.oRc;
  pre._collectRotS = v.oRs;
  pre.renderQueueMaxItems = maxItems;
  pre.globalEntityCount = n;

  const t = v.table;
  t[SLOT.L_LIST_U32] = 1;
  t[SLOT.T_ACTIVE] = offsets.tActive;
  t[SLOT.T_X] = offsets.x;
  t[SLOT.T_Y] = offsets.y;
  t[SLOT.T_ROT_C] = offsets.rotC;
  t[SLOT.T_ROT_S] = offsets.rotS;
  t[SLOT.S_ACTIVE] = offsets.sActive;
  t[SLOT.S_VISIBLE] = offsets.sVisible;
  t[SLOT.S_HALF_W] = offsets.halfW;
  t[SLOT.S_HALF_H] = offsets.halfH;
  t[SLOT.S_SHEET] = offsets.sheet;
  t[SLOT.S_MASK] = offsets.mask;
  t[SLOT.C_VISUAL_RANGE] = offsets.visualRange;
  t[SLOT.O_Y] = offsets.oY;
  t[SLOT.O_TYPE] = offsets.oType;
  t[SLOT.O_INDEX] = offsets.oIndex;
  t[SLOT.O_X] = offsets.oX;
  t[SLOT.O_PY] = offsets.oPy;
  t[SLOT.O_ROT_C] = offsets.oRc;
  t[SLOT.O_ROT_S] = offsets.oRs;
  t[SLOT.R_RESULTS] = offsets.results;
  return { memory, views: v, offsets };
}

export function bindCollectKernel(memory) {
  return instantiateKernel('preRenderCollect', memory);
}

/**
 * collectVisibleEntities through the kernel, for a scene the kernel serves: no physics poses, no Y-sort, the
 * queue on. `keyY` is the collect's sort key (COLLECT_Y[0] in the worker, which the kernel's caller passes).
 */
export function collectWithKernel(pre, k, m, keyY) {
  if (pre.globalEntityCount === 0 || !SpriteRenderer.active || !pre.cameraData) return;
  const cb = pre.calculateCameraBounds();
  if (!cb) return;
  const v = m.views;
  const t = v.table;
  const spriteEntities = Query.queryActiveEntities(pre._querySpriteRenderer || [SpriteRenderer]);
  let count;
  let list = null;
  if (spriteEntities && spriteEntities.length > 0) {
    count = spriteEntities.length;
    list = spriteEntities;
    v.list.set(spriteEntities);
    t[SLOT.L_LIST] = m.offsets.list;
  } else {
    count = pre.globalEntityCount;
    t[SLOT.L_LIST] = 0;
  }
  const res = v.results;
  res[0] = pre._renderableCount;
  res[1] = 0;
  res[2] = 0;
  const maxItems = pre.renderQueueMaxItems;
  const table = m.offsets.table;
  const rot = pre._frameCameraRot || 0;
  const turned = rot && !pre.skipCull;
  let rc = 0;
  let rs = 0;
  let halfCw = 0;
  let halfCh = 0;
  let limW = 0;
  let limH = 0;
  if (turned) {
    rc = Math.cos(rot);
    rs = Math.sin(rot);
    halfCw = pre.canvasWidth * 0.5;
    halfCh = pre.canvasHeight * 0.5;
    const marginScale = cb.zoom < 1 ? cb.zoom : 1;
    limW = halfCw + pre.canvasWidth * pre.cullingRatio * marginScale;
    limH = halfCh + pre.canvasHeight * pre.cullingRatio * marginScale;
  }
  let visible = 0;
  let from = 0;
  for (;;) {
    const stop = turned
      ? k.collect_sprites_turned(table, from, count, maxItems, keyY, cb.zoom, cb.cameraOffsetX, cb.cameraOffsetY,
        halfCw, halfCh, rc, rs, limW, limH)
      : k.collect_sprites(table, from, count, maxItems, pre.skipCull ? 1 : 0, keyY, cb.zoom,
        cb.cameraOffsetX, cb.cameraOffsetY, cb.minX, cb.maxX, cb.minY, cb.maxY);
    if (stop >= count) break;
    // A masked sprite: collectRenderable, as the JS loop does, then on from the next one.
    pre._renderableCount = res[0];
    pre.collectRenderable(0, list ? list[stop] : stop);
    res[0] = pre._renderableCount;
    visible++;
    from = stop + 1;
  }
  pre._renderableCount = res[0];
  if (res[2]) pre._collectorFull();
  pre.visibleEntitiesCount += visible + res[1];
  pre._collectEntityGlow(Transform.x, Transform.y, Collider.visualRange, cb.zoom, cb.cameraOffsetX, cb.cameraOffsetY,
    cb.minX, cb.maxX, cb.minY, cb.maxY);
}
