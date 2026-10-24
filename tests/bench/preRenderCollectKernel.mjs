/**
 * The sprite collect kernel (E-76 W4b, wasm/preRenderCollect.c), shared by its test and its bench.
 *
 * `collectMemory` lays every column the sprite collect reads and writes in one shared WebAssembly.Memory, binds
 * them where the shipped PreRenderWorker.collectVisibleEntities reads them (Transform, SpriteRenderer, Collider,
 * the worker's main collector), and leaves room for the kernel's list, table and results, as the render-queue
 * memory's collect regions do. `bindCollect` binds the worker's kernel there; with `pre._collectWasm` set the
 * shipped collect takes the kernel, with it null the JS loop.
 */
import { Transform } from '../../src/components/transform.js';
import { SpriteRenderer } from '../../src/components/spriteRenderer.js';
import { Collider } from '../../src/components/collider.js';
import { COLLECT_TABLE_SLOTS } from '../../src/util/wasmMemoryMap.js';
import { bindPreRenderCollect } from '../../src/workers/preRenderCollectClient.js';

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
    ['results', Int32Array, 4], ['table', Uint32Array, COLLECT_TABLE_SLOTS],
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
  return { memory, views: v, offsets, layout: { entities: n, listByte: offsets.list, tableByte: offsets.table, resultsByte: offsets.results } };
}

/** The worker's collect kernel on that memory, as its init binds it from the render-queue layout. */
export function bindCollect(m) {
  return bindPreRenderCollect(m.memory, m.layout);
}
