// The WASM sprite collect (E-76 W4b): loads preRenderCollect.wasm onto the render-queue memory, where a scene
// without physics keeps every column pre-render's sprite collect reads (Transform and its pose, SpriteRenderer,
// Collider) and the main collector it writes (renderQueueMemoryRegions' collect spec). collect_sprites and
// collect_sprites_turned walk the sprites as collectVisibleEntities' two loops do; a sprite with a layer mask is
// handed back for collectRenderable in JS.

import { loadWasmKernel } from '../util/wasmKernel.js';
import { COLLECT_TABLE_SLOTS } from '../util/wasmMemoryMap.js';

// Literal on purpose: webpack emits the asset for this pattern, and the bundle embeds it.
const wasmUrl = new URL('./preRenderCollect.wasm', import.meta.url);

/** wasm/preRenderCollect.c's column table, slot for slot. */
export const COLLECT_SLOTS = [
  'list', 'listU32', 'tActive', 'tX', 'tY', 'tRotC', 'tRotS',
  'sActive', 'sVisible', 'sHalfW', 'sHalfH', 'sSheet', 'sMask', 'cVisualRange',
  'oY', 'oType', 'oIndex', 'oX', 'oPy', 'oRotC', 'oRotS', 'results',
];
if (COLLECT_SLOTS.length > COLLECT_TABLE_SLOTS) throw new Error('preRenderCollect: the column table outgrew its region');
const SLOT = Object.fromEntries(COLLECT_SLOTS.map((name, k) => [name, k]));

export async function bindPreRenderCollect(memory, collect) {
  const k = await loadWasmKernel('preRenderCollect', wasmUrl, memory, ['collect_sprites', 'collect_sprites_turned']);
  const buffer = memory.buffer;
  const table = new Uint32Array(buffer, collect.tableByte, COLLECT_SLOTS.length);
  table[SLOT.listU32] = 1;
  table[SLOT.results] = collect.resultsByte;
  return {
    buffer,
    collectSprites: k.collect_sprites,
    collectSpritesTurned: k.collect_sprites_turned,
    table,
    tableByte: collect.tableByte,
    results: new Int32Array(buffer, collect.resultsByte, 4),
    list: new Uint32Array(buffer, collect.listByte, collect.entities),
    listByte: collect.listByte,
  };
}

/**
 * The column table for this frame (the collector's pose columns are the queue buffer being written). False
 * when a column the collect reads is not in the memory, and the JS collect runs instead.
 */
export function writeCollectColumns(b, worker, Transform, SpriteRenderer, Collider) {
  const t = b.table;
  const buffer = b.buffer;
  let ok = true;
  // A column the scene has must be in the memory; one it lacks is 0, which the kernel reads as absent.
  const put = (slot, a, required) => {
    if (!a) {
      t[SLOT[slot]] = 0;
      if (required) ok = false;
    } else if (a.buffer === buffer) {
      t[SLOT[slot]] = a.byteOffset;
    } else {
      ok = false;
    }
  };
  put('tActive', Transform.active, true);
  put('tX', Transform.x, true);
  put('tY', Transform.y, true);
  put('tRotC', Transform.rotC, false);
  put('tRotS', Transform.rotS, false);
  put('sActive', SpriteRenderer.active, true);
  put('sVisible', SpriteRenderer.renderVisible, true);
  put('sHalfW', SpriteRenderer.boundsHalfW, false);
  put('sHalfH', SpriteRenderer.boundsHalfH, false);
  put('sSheet', SpriteRenderer.spritesheetId, false);
  put('sMask', SpriteRenderer.layerMask, false);
  put('cVisualRange', Collider.visualRange, false);
  put('oY', worker._renderableY, true);
  put('oType', worker._renderableType, true);
  put('oIndex', worker._renderableIndex, true);
  put('oX', worker._collectPx, true);
  put('oPy', worker._collectPy, true);
  put('oRotC', worker._collectRotC, true);
  put('oRotS', worker._collectRotS, true);
  return ok;
}

/** Point the table at the sprite query's list, copied into the memory, or at none (a scan of every index). */
export function writeCollectList(b, ids) {
  if (ids && ids.length > 0) {
    b.list.set(ids);
    b.table[SLOT.list] = b.listByte;
    return ids.length;
  }
  b.table[SLOT.list] = 0;
  return 0;
}
